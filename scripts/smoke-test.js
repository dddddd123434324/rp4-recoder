#!/usr/bin/env node
'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const electron = require('electron');
const projectRoot = path.resolve(__dirname, '..');

async function main() {
  const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'rp4-smoke-'));
  const env = { ...process.env, RP4_SMOKE: '1' };
  delete env.ELECTRON_RUN_AS_NODE;

  let code;
  try {
    code = await new Promise((resolve, reject) => {
      const child = spawn(electron, ['.', `--user-data-dir=${sandbox}`], {
        cwd: projectRoot,
        env,
        stdio: 'inherit',
        windowsHide: true
      });
      child.once('error', reject);
      child.once('close', (exitCode) => resolve(exitCode ?? 1));
    });
  } finally {
    await fs.rm(sandbox, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }

  process.exitCode = code;
}

main().catch((error) => {
  process.stderr.write(`SMOKE RUNNER FAIL ${error?.stack || error}\n`);
  process.exitCode = 1;
});
