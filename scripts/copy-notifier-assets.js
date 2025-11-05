#!/usr/bin/env node
/**
 * Copy node-notifier vendor binaries into a top-level vendor folder so the
 * bundled extension can resolve them relative to the compiled output.
 */
const fs = require('node:fs');
const path = require('node:path');

const source = path.join(__dirname, '..', 'node_modules', 'node-notifier', 'vendor');
const destination = path.join(__dirname, '..', 'vendor');

if (!fs.existsSync(source)) {
    console.error('node-notifier vendor assets not found at', source);
    process.exit(1);
}

if (fs.existsSync(destination)) {
    fs.rmSync(destination, { recursive: true, force: true });
}

fs.mkdirSync(path.dirname(destination), { recursive: true });
fs.cpSync(source, destination, { recursive: true });

console.log('Copied node-notifier vendor assets to', destination);
