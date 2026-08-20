#!/usr/bin/env node
'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const electron = require('electron');

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const cleanupManifest = path.join(
  os.tmpdir(),
  `rp4-electron-cleanup-${process.pid}-${crypto.randomUUID()}.json`
);
env.RP4_TEST_CLEANUP_MANIFEST = cleanupManifest;

function cleanupRequestedSandbox() {
  try {
    const requested = JSON.parse(fs.readFileSync(cleanupManifest, 'utf8'))?.sandbox;
    const tempRoot = path.resolve(os.tmpdir());
    const target = path.resolve(String(requested || ''));
    const safeName = /^rp4-(?:itest|smoke)-[a-z0-9]+$/i.test(path.basename(target));
    if (safeName && path.dirname(target).toLowerCase() === tempRoot.toLowerCase()) {
      fs.rmSync(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  } catch {
    // The child may not be a test process or its cleanup marker may be unavailable.
  } finally {
    try { fs.rmSync(cleanupManifest, { force: true }); } catch {}
  }
}

const child = spawn(electron, process.argv.slice(2), {
  cwd: process.cwd(),
  env,
  stdio: 'inherit',
  windowsHide: false
});

child.once('error', (error) => {
  process.stderr.write(`Electron launch failed: ${error?.stack || error}\n`);
  process.exitCode = 1;
});

child.once('close', (code, signal) => {
  cleanupRequestedSandbox();
  if (signal) {
    process.stderr.write(`Electron exited from signal ${signal}.\n`);
    process.exitCode = 1;
    return;
  }
  process.exitCode = code ?? 1;
});
