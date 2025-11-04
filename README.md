<div align="center">
  <img src="images/icon.png" width="160" alt="Terminal OSC Notifier icon" />
  <h1 style="margin-bottom: 0;">Terminal OSC Notifier</h1>
  <p style="font-size: 1.15rem; margin-top: 0.25rem;">
    Ghostty-style OSC notifications for your VS Code terminals — native alerts with focus-on-click.
  </p>
  <p>
    <a href="https://github.com/wbopan/vscode-terminal-osc-notifier">GitHub</a>
    &nbsp;•&nbsp;
    <a href="https://github.com/wbopan/vscode-terminal-osc-notifier/issues">Issues</a>
  </p>
</div>

# Terminal OSC Notifier

VS Code extension that listens to terminal output for Ghostty-style OSC notification sequences (`OSC 9`, `OSC 777;notify;…`) and turns them into native OS notifications plus optional VS Code toasts. Clicking a notification re-focuses the originating integrated terminal tab.

## Features

- Detects both `OSC 9;<message>` and `OSC 777;notify;<title>;<message>` sequences, including payloads wrapped by tmux passthrough escape codes.
- Raises native notifications via `node-notifier` on macOS (Notification Center), Windows (SnoreToast), and Linux (`notify-send`), while preserving VS Code focus and iconography when possible.
- Provides fallback VS Code notifications with a **Focus Terminal** action so you can jump back even when the OS API lacks click events (e.g. some Linux environments).
- Optionally filters Ghostty progress updates (`OSC 9;4;…`) to avoid noisy notifications.
- Deep-link handler keeps the extension functional even when the OS notification system cannot route click events back to VS Code.

## Requirements

- Visual Studio Code `1.93.0` or newer (first release exposing the Shell Integration execution stream used by this extension).
- Terminal must have Shell Integration enabled (the default for built-in terminals in supported shells). Custom shells must source VS Code's shell integration script.

## Usage

1. Install **Terminal OSC Notifier** from the VS Code Marketplace (or sideload the `.vsix` created with `vsce package`).
2. Trigger notifications from a shell command by emitting one of the supported escape sequences:

   ```sh
   # Simple body-only notification (OSC 9)
   printf '\e]9;Build finished ✔\a'

   # Title + body notification (OSC 777)
   printf '\e]777;notify;Nightly Tests;All suites passed\a'

   # With tmux passthrough (tmux forwards OSC sequences via DCS tmux;)
   printf '\ePtmux;\e\e]777;notify;Deploy;Production complete\a\e\\'
   ```

3. Click the OS notification (where supported) or the VS Code toast action to focus the emitting terminal.

## Extension Settings

These options live under the `Terminal OSC Notifier` group in Settings (`oscNotifier.*`):

- `preferOsNotifications` (default `true`): Send native OS notifications. Disable to keep alerts inside VS Code only.
- `showVsCodeNotification` (default `true`): Show VS Code pop-ups alongside OS notifications. Handy if the OS API cannot deliver click callbacks.
- `ignoreProgressOsc9_4` (default `true`): Ignore `OSC 9;4` sequences, often used for progress updates in Ghostty, to reduce noise.

Commands:

- `OSC Notifier: Enable` — Resume parsing terminal output (default state).
- `OSC Notifier: Disable` — Pause parsing without unloading the extension.

## Development

```sh
npm install
npm run watch   # or npm run compile for a one-off build
```

Press `F5` in VS Code to launch an Extension Development Host with live-reload.

## License

Released under the [MIT License](LICENSE) by Pan Wenbo.
