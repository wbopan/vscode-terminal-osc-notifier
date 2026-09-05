#!/usr/bin/env node
/**
 * Assemble the vendor/ tree the packaged extension ships:
 *
 *   1. node-notifier's Windows/Linux binaries (SnoreToast, notifu).
 *   2. terminal-notifier, downloaded from upstream as a universal
 *      (x86_64 + arm64) build and pinned by SHA256.
 *
 * node-notifier's own mac.noindex bundle is skipped: it is x86_64-only (Rosetta
 * warning, or outright failure, on Apple Silicon -- see
 * https://github.com/mikaelbr/node-notifier/issues/361) and its
 * NotificationCenter wrapper needs the -json/-sender flags that
 * terminal-notifier 3.0.0 removed. macOS spawns the binary directly instead,
 * see createMacNotifier in src/extension.ts.
 *
 * The pinned SHA256 is the integrity gate: a mismatch fails the build, and
 * `vscode:prepublish` runs this script, so a tampered release cannot ship.
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { tmpdir } = require('node:os');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const NODE_NOTIFIER_VENDOR = path.join(ROOT, 'node_modules', 'node-notifier', 'vendor');
const VENDOR = path.join(ROOT, 'vendor');
// Keep node-notifier's directory name; the .noindex suffix stops Spotlight from
// indexing the shipped .app bundle.
const MAC_VENDOR = path.join(VENDOR, 'mac.noindex');

// Bump both together when upgrading.
const VERSION = '3.1.0';
const SHA256 = 'e969d4ae20287da1ba55495ae31dcedd8e9069deb8ce4eed24f6561a5fc3e4d5';
const DOWNLOAD_URL = `https://github.com/julienXX/terminal-notifier/releases/download/${VERSION}/terminal-notifier-${VERSION}.zip`;

function sha256(file) {
    return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/** Returns a SHA256-verified zip path, reusing the temp-dir copy left by a previous run. */
async function downloadTerminalNotifier() {
    const zip = path.join(tmpdir(), `terminal-notifier-${VERSION}.zip`);
    if (fs.existsSync(zip) && sha256(zip) === SHA256) return zip;

    console.log(`Downloading terminal-notifier ${VERSION} (universal)...`);
    const res = await fetch(DOWNLOAD_URL);
    if (!res.ok) {
        throw new Error(`Download failed: ${res.status} ${res.statusText} for ${DOWNLOAD_URL}`);
    }
    fs.writeFileSync(zip, Buffer.from(await res.arrayBuffer()));

    const actual = sha256(zip);
    if (actual !== SHA256) {
        throw new Error(`SHA256 mismatch: got ${actual}, expected ${SHA256}`);
    }
    return zip;
}

async function main() {
    if (!fs.existsSync(NODE_NOTIFIER_VENDOR)) {
        throw new Error(`node-notifier vendor assets not found at ${NODE_NOTIFIER_VENDOR}`);
    }
    fs.rmSync(VENDOR, { recursive: true, force: true });
    fs.cpSync(NODE_NOTIFIER_VENDOR, VENDOR, {
        recursive: true,
        filter: (src) => path.basename(src) !== 'mac.noindex',
    });
    console.log('Copied node-notifier Windows/Linux vendor assets to', VENDOR);

    // Only fetch where the binary is usable or published from, so a Linux/Windows
    // contributor's build needs neither network nor unzip.
    if (process.platform !== 'darwin' && !process.env.CI) {
        console.log('Skipping terminal-notifier download (not macOS, not CI)');
        return;
    }

    const zip = await downloadTerminalNotifier();
    // The zip holds terminal-notifier.app/ plus README.markdown (its MIT license
    // and the Terminal.icns Apple-copyright exception), so extract it as-is.
    fs.mkdirSync(MAC_VENDOR, { recursive: true });
    execFileSync('unzip', ['-q', zip, '-d', MAC_VENDOR]);
    console.log(`Vendored universal terminal-notifier ${VERSION} into`, MAC_VENDOR);
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
