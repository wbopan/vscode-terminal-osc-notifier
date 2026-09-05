import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { execFile } from 'child_process';

// -- OS notifier backends --
// Windows and Linux go through node-notifier; macOS has its own Notifier
// implementation (see createMacNotifier).
// eslint-disable-next-line @typescript-eslint/no-var-requires
const BaseNotifier = require('node-notifier');
// These sub-reporters are exposed as part of the public API
// eslint-disable-next-line @typescript-eslint/no-var-requires
const WindowsToaster = require('node-notifier/notifiers/toaster');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const NotifySend = require('node-notifier/notifiers/notifysend');

// node-notifier's reporter shape, which createMacNotifier also implements.
type Notifier = {
    notify: (opts: Record<string, any>, cb?: (...args: any[]) => void) => void;
    on?: (event: string, handler: (...args: any[]) => void) => void;
};

let notifier: Notifier;               // Platform-specific notifier instance
let iconPathForOS: string | undefined; // Absolute path to the notification icon
let extensionCtx: vscode.ExtensionContext;

const SETTINGS_SECTION = 'terminalNotification';

function getSetting<T>(key: string, defaultValue: T): T {
    return vscode.workspace.getConfiguration(SETTINGS_SECTION).get<T>(key, defaultValue);
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

// Deep link handled by the registerUriHandler below. Used by the macOS and Linux
// backends, which cannot deliver a click back into this process.
// Note the scheme varies by build: vscode / vscode-insiders / code-oss.
function buildFocusUri(tid: string): string {
    const uri = `${vscode.env.uriScheme}://${extensionCtx.extension.id}/focus?tid=${encodeURIComponent(tid)}`;
    return vscode.Uri.parse(uri).toString();
}

// -- OS notifications and VS Code notifications --

// Windows click handler: node-notifier returns the options we originally passed in
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

// Resolve the notification icon.
// Windows/Linux use VS Code's own icon from the installation; macOS falls back to
// this extension's PNG because the app bundle only ships an .icns, which
// terminal-notifier 3.x rejects for -contentImage.
function resolveIconPath(): string | undefined {
    try {
        if (process.platform === 'darwin') {
            const p = path.join(extensionCtx.extensionPath, 'images', 'icon.png');
            return fs.existsSync(p) ? p : undefined;
        }
        const root = vscode.env.appRoot; // .../resources/app
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

// macOS backend: spawn the vendored universal terminal-notifier.app directly.
// It hands the notification to macOS and exits immediately; the OS stores the
// -open action and launches the URI on click, which brings VS Code forward and
// routes through registerUriHandler -> focusTerminalById.
// node-notifier's own NotificationCenter reporter is unusable here: it ships an
// x86_64-only binary and drives it with the -json/-sender flags that
// terminal-notifier 3.0.0 removed.
function createMacNotifier(): Notifier {
    const binary = path.join(
        extensionCtx.extensionPath,
        'vendor', 'mac.noindex', 'terminal-notifier.app', 'Contents', 'MacOS', 'terminal-notifier'
    );
    return {
        notify(opts) {
            const args = ['-title', opts.title, '-message', opts.message];
            if (opts.open) args.push('-open', opts.open);
            // Sound names come from /System/Library/Sounds; true means the system default.
            if (opts.sound) args.push('-sound', opts.sound === true ? 'default' : opts.sound);
            // -contentImage takes a PNG/JPEG/GIF; .icns is rejected.
            if (opts.icon) args.push('-contentImage', opts.icon);

            // A rejected -contentImage or -sound is only a warning on stderr, exit 0.
            execFile(binary, args, (err, _stdout, stderr) => {
                if (err) console.error('terminal-notifier failed', err);
                else if (stderr.trim()) console.warn('terminal-notifier:', stderr.trim());
            });
        },
    };
}

function createPlatformNotifier(): Notifier {
    try {
        if (process.platform === 'darwin') {
            return createMacNotifier();
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
            wait: true,   // Required so click events are delivered (Windows)
            tid,          // Custom field retrieved later in the click callback
        };

        // Optional sound. Support varies by backend:
        //   macOS: system sound names like "Glass", "Ping", "Hero", or true for the default.
        //   Windows Toaster: "IM", "Mail", "Reminder", "SMS", etc.
        //   Linux notify-send: no sound support.
        const sound = getSetting<string>('sound', '');
        if (sound) {
            opts.sound = sound === 'default' ? true : sound;
        }

        if (iconPathForOS) opts.icon = iconPathForOS;
        // Only Windows reports clicks back to us; elsewhere the OS opens the deep link.
        if (process.platform !== 'win32') opts.open = buildFocusUri(tid);

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
    iconPathForOS = resolveIconPath();
    notifier = createPlatformNotifier();
    installGlobalNotifierClickHandler();

    // Commands: enable/disable parsing
    ctx.subscriptions.push(
        vscode.commands.registerCommand('terminalNotification.enable', () => { enabled = true; vscode.window.showInformationMessage('Terminal notifications enabled'); }),
        vscode.commands.registerCommand('terminalNotification.disable', () => { enabled = false; vscode.window.showInformationMessage('Terminal notifications disabled'); }),
    );

    // URI handler: click target of the macOS/Linux OS notifications.
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

    // Observe raw command execution output (VS Code Shell Integration API 1.93+)
    ctx.subscriptions.push(
        vscode.window.onDidStartTerminalShellExecution(async (event: vscode.TerminalShellExecutionStartEvent) => {
            if (!enabled) return;

            const term = event.terminal;
            const execution = event.execution;
            const tid = getOrAssignTerminalId(term);

            const parser = new OscParser(
                (n) => {
                    const title = n.kind === 'osc777' ? (n.title || 'Terminal') : 'Terminal';
                    const body = n.body;
                    // Skip when the emitting terminal is already the focused one
                    // (user is clearly watching it — no need to interrupt).
                    if (getSetting('skipWhenActive', false)) {
                        const vscodeFocused = vscode.window.state.focused;
                        const isActiveTerm = vscode.window.activeTerminal === term;
                        if (vscodeFocused && isActiveTerm) return;
                    }
                    sendOsNotification(tid, title, body);
                    sendVsCodeNotification(tid, title, body);
                },
                getSetting('ignoreProgressOsc9_4', true)
            );

            const stream = execution.read();
            try {
                for await (const data of stream) {
                    parser.feed(String(data));
                }
            } catch (e) {
                console.warn('Terminal data stream ended with error:', e);
            }
        })
    );

}

export function deactivate() {
    // noop
}
