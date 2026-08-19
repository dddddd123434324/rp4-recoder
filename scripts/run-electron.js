#!/usr/bin/env node
'use strict';

const { spawn } = require('node:child_process');

const electron = require('electron');

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

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
  if (signal) {
    process.stderr.write(`Electron exited from signal ${signal}.\n`);
    process.exitCode = 1;
    return;
  }
  process.exitCode = code ?? 1;
});
