import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

// —— node-notifier：按平台选择合适的后端 ——
// eslint-disable-next-line @typescript-eslint/no-var-requires
const BaseNotifier = require('node-notifier');
// 这些子 reporter 是官方公开入口
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

let notifier: Notifier;               // 平台化的 notifier 实例
let iconPathForOS: string | undefined; // VS Code 图标（绝对路径）
let extensionCtx: vscode.ExtensionContext;

// —— 终端数据解析 ——
// 识别：
//   1) OSC 9 ; <body> BEL|ST
//   2) OSC 777 ; notify ; <title> ; <body> BEL|ST
// 终止符：BEL(0x07) 或 ST(ESC \ -> \x1b\\)
// 新增：tmux passthrough 解包： ESC P tmux; <payload> ESC \ ；并把 <payload> 内的 \x1b\x1b 还原成 \x1b
// 参考：tmux FAQ on passthrough / DCS tmux; 前缀。  (详见上方说明)

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
        // 先尽量拆 tmux 的 DCS passthrough 包装（可能嵌套），把内层 payload 解成普通流
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
            // Ghostty: 9;4 可能是进度；可选忽略。
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

        // 其它 OSC 类型不处理
    }

    // 解包 ESC P tmux; ... ESC \ ，并将内部的 \x1b\x1b 还原成 \x1b
    private unwrapTmuxPassthrough() {
        const ESC = '\x1b';
        const DCS_TMUX = ESC + 'Ptmux;';
        const ST = ESC + '\\';

        // 为了应对多个/嵌套的情况，用 while
        // 若遇到不完整帧（没有 ST），就等待下一块数据
        while (true) {
            const i = this.buffer.indexOf(DCS_TMUX);
            if (i === -1) return;

            const after = i + DCS_TMUX.length;
            const end = this.buffer.indexOf(ST, after);
            if (end === -1) {
                // 不完整，等待更多数据；仅保留从 i 开始的部分，防内存增长
                if (i > 0) this.buffer = this.buffer.slice(i);
                return;
            }

            // 取内部 payload 并把 \x1b\x1b 变回 \x1b
            const inner = this.buffer.slice(after, end).replace(/\x1b\x1b/g, '\x1b');
            // 用内层替换整个 DCS 包（保留前后其余内容），继续循环以处理可能的下一个包
            this.buffer = this.buffer.slice(0, i) + inner + this.buffer.slice(end + ST.length);
        }
    }
}

// —— 终端/通知关联与聚焦 ——
// 点击系统通知后聚焦对应终端标签

const terminalIdMap = new Map<vscode.Terminal, string>();
const idToTerminal = new Map<string, vscode.Terminal>();

function getOrAssignTerminalId(t: vscode.Terminal): string {
    const existing = terminalIdMap.get(t);
    if (existing) return existing;

    // 使用 crypto.randomUUID（若可用）生成稳定的会话内 ID
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
        // 找不到时尽量只打开终端面板，而不是创建新终端
        try {
            await vscode.commands.executeCommand('workbench.action.terminal.focus');
        } catch {
            await vscode.commands.executeCommand('workbench.action.terminal.toggleTerminal');
        }
    }
}

// —— 系统通知 & VS Code 通知 ——

// 统一放一个点击处理器：node-notifier 会把我们当初传入的 options 原样带回
function installGlobalNotifierClickHandler() {
    if (!notifier?.on) return;
    // 避免重复注册
    const anyNotifier = notifier as any;
    if (anyNotifier.__oscNotifierClickHooked) return;
    anyNotifier.__oscNotifierClickHooked = true;

    notifier.on!('click', (_obj: any, options: any) => {
        const tid = options?.tid as string | undefined;
        if (tid) focusTerminalById(tid);
    });
}

// 解析 VS Code 安装内置图标（跨平台）
// Windows: 选择一个常见尺寸（256 或 128）
// macOS: 使用 .icns（Notification Center 会展示为 app 图标）
// Linux: 使用 PNG
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

// 按平台创建更可控的 notifier
function createPlatformNotifier(): Notifier {
    try {
        if (process.platform === 'darwin') {
            // macOS: 走 NotificationCenter，实现 sender/activate 从而显示 VS Code 图标并回到 VS Code
            return new NotificationCenter({ withFallback: false });
        }
        if (process.platform === 'win32') {
            // Windows: 走 SnoreToast 的 toaster，设置 appID（显示为 VS Code app 名称+图标）
            return new WindowsToaster({ withFallback: false, appID: 'Visual Studio Code' });
        }
        // Linux: 走 notify-send
        return new NotifySend({ withFallback: false });
    } catch {
        // 兜底
        return BaseNotifier;
    }
}

function sendOsNotification(tid: string, title: string, message: string) {
    const preferOs = vscode.workspace.getConfiguration('oscNotifier').get<boolean>('preferOsNotifications', true);
    if (!preferOs) return;

    try {
        const opts: any = {
            title: title || 'Terminal',
            message: message || '',
            wait: true,   // click 事件需要
            tid,          // 自定义字段，后续 click 回调里能拿到
        };

        // 尽量设置 VS Code 图标（不同平台机制不同）
        if (process.platform === 'darwin') {
            // macOS: 指定 sender/activate 为 VS Code，这样系统通知头图标显示 VS Code
            // （terminal-notifier 支持 -sender / -activate）
            opts.sender = 'com.microsoft.VSCode';
            opts.activate = 'com.microsoft.VSCode';
            if (iconPathForOS) opts.contentImage = iconPathForOS; // 作为内容图片展示（非标题小图标）
        } else if (process.platform === 'win32') {
            // Windows: appID 已在构造器里设置；此外也传一个 icon 提升一致性
            if (iconPathForOS) opts.icon = iconPathForOS;
        } else {
            // Linux: notify-send 支持 icon 路径，但不支持 wait/click 事件
            if (iconPathForOS) opts.icon = iconPathForOS;

            // Linux 上作为兜底：点击后用 deep link 回到当前 VS Code 实例
            // 注意：使用 vscode.env.uriScheme（vscode / vscode-insiders / code-oss）
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
    const show = vscode.workspace.getConfiguration('oscNotifier').get<boolean>('showVsCodeNotification', true);
    if (!show) return;

    const text = title ? `${title}: ${message}` : message;
    vscode.window.showInformationMessage(text, 'Focus Terminal').then(sel => {
        if (sel === 'Focus Terminal') focusTerminalById(tid);
    });
}

// —— 主入口 ——
let enabled = true;

export function activate(ctx: vscode.ExtensionContext) {
    extensionCtx = ctx;
    iconPathForOS = resolveVSCodeIconPath();
    notifier = createPlatformNotifier();
    installGlobalNotifierClickHandler();

    // 命令：启用/禁用
    ctx.subscriptions.push(
        vscode.commands.registerCommand('oscNotifier.enable', () => { enabled = true; vscode.window.showInformationMessage('OSC Notifier enabled'); }),
        vscode.commands.registerCommand('oscNotifier.disable', () => { enabled = false; vscode.window.showInformationMessage('OSC Notifier disabled'); }),
    );

    // URI handler：仅作为 Linux 或其它无法捕捉 click 的兜底
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

    // 监听命令执行的原始输出（VS Code Shell Integration API 1.93+）
    ctx.subscriptions.push(
        vscode.window.onDidStartTerminalShellExecution(async (event: vscode.TerminalShellExecutionStartEvent) => {
            if (!enabled) return;

            const term = event.terminal;
            const execution = event.execution;
            const tid = getOrAssignTerminalId(term);

            const parser = new OscParser(
                (n: ParsedNotification) => {
                    const title = n.kind === 'osc777' ? (n.title || 'Terminal') : 'Terminal';
                    const body = n.body;
                    sendOsNotification(tid, title, body);
                    sendVsCodeNotification(tid, title, body);
                },
                vscode.workspace.getConfiguration('oscNotifier').get<boolean>('ignoreProgressOsc9_4', true)
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
