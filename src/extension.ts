import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

// -- node-notifier: choose a backend appropriate for each platform --
// eslint-disable-next-line @typescript-eslint/no-var-requires
const BaseNotifier = require('node-notifier');
// These sub-reporters are exposed as part of the public API
// eslint-disable-next-line @typescript-eslint/no-var-requires
const NotificationCenter = require('node-notifier/notifiers/notificationcenter');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const WindowsToaster = require('node-notifier/notifiers/toaster');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const NotifySend = require('node-notifier/notifiers/notifysend');

type Notifier = {
    notify: (opts: Record<string, any>, cb?: (...args: any[]) => void) => void;
    on?: (event: string, handler: (...args: any[]) => void) => void;
};

let notifier: Notifier;               // Platform-specific notifier instance
let iconPathForOS: string | undefined; // VS Code icon path (absolute)
let extensionCtx: vscode.ExtensionContext;

const SETTINGS_SECTION = 'terminalNotification';

const parsers = new Map<vscode.Terminal, OscParser>();

function getSetting<T>(key: string, defaultValue: T): T {
    return vscode.workspace.getConfiguration(SETTINGS_SECTION).get<T>(key, defaultValue);
}

type TerminalWriteEvent = { terminal: vscode.Terminal; data: string };

function getParser(t: vscode.Terminal): OscParser {
    let p = parsers.get(t);
    if (!p) {
        const tid = getOrAssignTerminalId(t);
        p = new OscParser(
            (n) => {
                const title = n.kind === 'osc777' ? (n.title || 'Terminal') : 'Terminal';
                const body = n.body;
                sendOsNotification(tid, title, body);
                sendVsCodeNotification(tid, title, body);
            },
            getSetting('ignoreProgressOsc9_4', true)
        );
        parsers.set(t, p);
    }
    return p;
}

// -- Terminal data parsing --
// Detects:
//   1) OSC 9 ; <body> BEL|ST
//   2) OSC 777 ; notify ; <title> ; <body> BEL|ST
// Terminators: BEL (0x07) or ST (ESC \ -> \x1b\\)
// Additionally unwraps tmux passthrough: ESC P tmux; <payload> ESC \, restoring \x1b\x1b to \x1b inside <payload>
// Reference: tmux FAQ on passthrough / DCS tmux; prefix (see the description above)

type ParsedNotification = { kind: 'osc9' | 'osc777'; title?: string; body: string };

class OscParser {
    private buffer = '';

    constructor(
        private readonly onNotify: (n: ParsedNotification) => void,
        private readonly ignoreOsc9_4: boolean
    ) { }

    feed(chunk: string) {
        this.buffer += chunk;
        if (this.buffer.length > 256 * 1024) {
            this.buffer = this.buffer.slice(-128 * 1024);
        }
        // First unwrap tmux DCS passthrough (possibly nested) so the inner payload becomes a normal stream
        this.unwrapTmuxPassthrough();

        const ESC = '\x1b';
        const BEL = '\x07';
        const OSC_PREFIX = ESC + ']';
        const ST = ESC + '\\';

        while (true) {
            const start = this.buffer.indexOf(OSC_PREFIX);
            if (start === -1) {
                if (this.buffer.length > 4096) this.buffer = this.buffer.slice(-4096);
                return;
            }
            const afterStart = start + OSC_PREFIX.length;
            const endBel = this.buffer.indexOf(BEL, afterStart);
            const endSt = this.buffer.indexOf(ST, afterStart);

            let end = -1;
            let consume = 0;
            if (endBel !== -1 && (endSt === -1 || endBel < endSt)) {
                end = endBel; consume = 1;
            } else if (endSt !== -1) {
                end = endSt; consume = 2;
            } else {
                if (start > 0) this.buffer = this.buffer.slice(start);
                return;
            }

            const content = this.buffer.slice(afterStart, end);
            this.buffer = this.buffer.slice(end + consume);

            this.tryParseOsc(content);
        }
    }

    private tryParseOsc(content: string) {
        const s = content.trim();

        if (s.startsWith('9;')) {
            // Ghostty: 9;4 may indicate progress updates; optionally ignore
            if (this.ignoreOsc9_4 && s.startsWith('9;4;')) return;
            const body = s.slice(2).trim();
            if (body.length > 0) this.onNotify({ kind: 'osc9', body });
            return;
        }

        if (s.startsWith('777;')) {
            // 777;notify;title;body
            const parts = s.split(';');
            if (parts.length >= 2 && parts[1].toLowerCase() === 'notify') {
                const title = parts.length >= 3 ? parts[2] : 'Terminal';
                const body = parts.length >= 4 ? parts.slice(3).join(';') : '';
                if (body.length > 0 || title.length > 0) {
                    this.onNotify({ kind: 'osc777', title, body });
                }
            }
            return;
        }

        // Ignore other OSC types
    }

    // Unwrap ESC P tmux; ... ESC \ and turn inner \x1b\x1b sequences back into \x1b
    private unwrapTmuxPassthrough() {
        const ESC = '\x1b';
        const DCS_TMUX = ESC + 'Ptmux;';
        const ST = ESC + '\\';

        // Use a loop to handle multiple or nested frames
        // If the frame is incomplete (no ST), wait for the next chunk
        while (true) {
            const i = this.buffer.indexOf(DCS_TMUX);
            if (i === -1) return;

            const after = i + DCS_TMUX.length;
            const end = this.buffer.indexOf(ST, after);
            if (end === -1) {
                // Incomplete frame: keep data from i onward to control memory growth and wait for more
                if (i > 0) this.buffer = this.buffer.slice(i);
                return;
            }

            // Extract the inner payload and convert \x1b\x1b back to \x1b
            const inner = this.buffer.slice(after, end).replace(/\x1b\x1b/g, '\x1b');
            // Replace the entire DCS block with the inner payload, then continue to process the next block
            this.buffer = this.buffer.slice(0, i) + inner + this.buffer.slice(end + ST.length);
        }
    }
}

// -- Terminal/notification association and focus --
// Focus the matching terminal tab when a system notification is clicked

const terminalIdMap = new Map<vscode.Terminal, string>();
const idToTerminal = new Map<string, vscode.Terminal>();

function getOrAssignTerminalId(t: vscode.Terminal): string {
    const existing = terminalIdMap.get(t);
    if (existing) return existing;

    // Use crypto.randomUUID when available to produce a stable per-session ID
    const id = (globalThis as any).crypto?.randomUUID?.() ?? String(Math.random());
    terminalIdMap.set(t, id);
    idToTerminal.set(id, t);
    return id;
}

async function focusTerminalById(tid: string) {
    const term = idToTerminal.get(tid);
    if (term) {
        try { term.show(); } catch { /* ignore */ }
    } else {
        // If not found, prefer opening the terminal panel instead of creating a new terminal
        try {
            await vscode.commands.executeCommand('workbench.action.terminal.focus');
        } catch {
            await vscode.commands.executeCommand('workbench.action.terminal.toggleTerminal');
        }
    }
}

// -- OS notifications and VS Code notifications --

// One shared click handler: node-notifier returns the options we originally passed in
function installGlobalNotifierClickHandler() {
    if (!notifier?.on) return;
    // Avoid duplicate registration
    const anyNotifier = notifier as any;
    if (anyNotifier.__terminalNotificationClickHooked) return;
    anyNotifier.__terminalNotificationClickHooked = true;

    notifier.on!('click', (_obj: any, options: any) => {
        const tid = options?.tid as string | undefined;
        if (tid) focusTerminalById(tid);
    });
}

// Resolve the built-in VS Code icon path across platforms
// Windows: prefer common sizes (256 or 128)
// macOS: use the .icns asset so Notification Center shows the app icon
// Linux: use the PNG asset
function resolveVSCodeIconPath(): string | undefined {
    try {
        const root = vscode.env.appRoot; // .../resources/app
        if (process.platform === 'darwin') {
            const p = path.join(root, 'resources', 'darwin', 'code.icns');
            return fs.existsSync(p) ? p : undefined;
        }
        if (process.platform === 'win32') {
            const candidates = ['code_256x256x32.png', 'code_128x128x32.png', 'code_64x64x32.png'];
            for (const f of candidates) {
                const p = path.join(root, 'resources', 'win32', f);
                if (fs.existsSync(p)) return p;
            }
            return undefined;
        }
        // linux
        const p = path.join(root, 'resources', 'linux', 'code.png');
        return fs.existsSync(p) ? p : undefined;
    } catch {
        return undefined;
    }
}

// Create a more controllable notifier per platform
function createPlatformNotifier(): Notifier {
    try {
        if (process.platform === 'darwin') {
            // macOS: use NotificationCenter so sender/activate maintain the VS Code icon and refocus VS Code
            return new NotificationCenter({ withFallback: false });
        }
        if (process.platform === 'win32') {
            // Windows: rely on the SnoreToast toaster and set appID so VS Code's name/icon are shown
            return new WindowsToaster({ withFallback: false, appID: 'Visual Studio Code' });
        }
        // Linux: rely on notify-send
        return new NotifySend({ withFallback: false });
    } catch {
        // Fallback
        return BaseNotifier;
    }
}

function sendOsNotification(tid: string, title: string, message: string) {
    const preferOs = getSetting('preferOsNotifications', true);
    if (!preferOs) return;

    try {
        const opts: any = {
            title: title || 'Terminal',
            message: message || '',
            wait: true,   // Required so click events are delivered
            tid,          // Custom field retrieved later in the click callback
        };

        // Try to set the VS Code icon (each platform uses a different mechanism)
        if (process.platform === 'darwin') {
            // macOS: set sender/activate to VS Code so the notification header shows the VS Code icon
            // (terminal-notifier supports -sender / -activate)
            opts.sender = 'com.microsoft.VSCode';
            opts.activate = 'com.microsoft.VSCode';
            if (iconPathForOS) opts.contentImage = iconPathForOS; // Display as the notification content image (not the header badge)
        } else if (process.platform === 'win32') {
            // Windows: appID is already configured; also pass an icon for consistency
            if (iconPathForOS) opts.icon = iconPathForOS;
        } else {
            // Linux: notify-send accepts icon paths but does not support wait/click events
            if (iconPathForOS) opts.icon = iconPathForOS;

            // Linux fallback: deep link back to the current VS Code instance when clicked
            // Note: use vscode.env.uriScheme (vscode / vscode-insiders / code-oss)
            const scheme = vscode.env.uriScheme;
            const extId = extensionCtx.extension.id;
            const uri = vscode.Uri.parse(`${scheme}://${extId}/focus?tid=${encodeURIComponent(tid)}`);
            opts.open = uri.toString();
        }

        notifier.notify(opts);
    } catch (err) {
        console.error('OS notification failed', err);
    }
}

function sendVsCodeNotification(tid: string, title: string, message: string) {
    const show = getSetting('showVsCodeNotification', true);
    if (!show) return;

    const text = title ? `${title}: ${message}` : message;
    vscode.window.showInformationMessage(text, 'Focus Terminal').then(sel => {
        if (sel === 'Focus Terminal') focusTerminalById(tid);
    });
}

// -- Entry point --
let enabled = true;

export function activate(ctx: vscode.ExtensionContext) {
    extensionCtx = ctx;
    iconPathForOS = resolveVSCodeIconPath();
    notifier = createPlatformNotifier();
    installGlobalNotifierClickHandler();

    // Commands: enable/disable parsing
    ctx.subscriptions.push(
        vscode.commands.registerCommand('terminalNotification.enable', () => { enabled = true; vscode.window.showInformationMessage('Terminal notifications enabled'); }),
        vscode.commands.registerCommand('terminalNotification.disable', () => { enabled = false; vscode.window.showInformationMessage('Terminal notifications disabled'); }),
    );

    // URI handler: fallback for Linux or other runtimes without click events
    ctx.subscriptions.push(
        vscode.window.registerUriHandler({
            handleUri: (uri) => {
                if (uri.path === '/focus') {
                    const tid = new URLSearchParams(uri.query).get('tid') || '';
                    focusTerminalById(tid);
                }
            }
        })
    );

    const onDidWriteTerminalData = (vscode.window as any).onDidWriteTerminalData as vscode.Event<TerminalWriteEvent> | undefined;
    if (onDidWriteTerminalData) {
        ctx.subscriptions.push(
            onDidWriteTerminalData((e: TerminalWriteEvent) => {
                if (!enabled) return;
                getOrAssignTerminalId(e.terminal);
                getParser(e.terminal).feed(e.data);
            })
        );
    }

}

export function deactivate() {
    // noop
}
