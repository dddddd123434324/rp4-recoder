#!/usr/bin/env node
'use strict';

/*
 * Parses every JavaScript file under src/ and scripts/.
 *
 * The previous `lint` script only checked three hardcoded files, so newly added modules
 * were never validated at all. This walks the tree so nothing is missed, and doubles as a
 * dependency-free fallback when ESLint is not installed.
 */

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const TARGET_DIRS = ['src', 'scripts'];
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', 'build-tools', 'out']);

function collect(dir, found = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return found;
  }

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) collect(fullPath, found);
    } else if (entry.isFile() && entry.name.endsWith('.js')) {
      found.push(fullPath);
    }
  }
  return found;
}

const files = TARGET_DIRS.flatMap((dir) => collect(path.join(ROOT, dir)));
const failures = [];

for (const file of files) {
  const source = fs.readFileSync(file, 'utf8');
  try {
    // Compile without running: catches syntax errors in main, preload and renderer alike.
    new vm.Script(source, { filename: file });
  } catch (error) {
    failures.push({ file, message: error.message });
  }
}

const relative = (file) => path.relative(ROOT, file).replace(/\\/g, '/');

if (failures.length > 0) {
  for (const failure of failures) {
    process.stderr.write(`FAIL ${relative(failure.file)}\n  ${failure.message}\n`);
  }
  process.stderr.write(`\n${failures.length} of ${files.length} file(s) failed to parse.\n`);
  process.exit(1);
}

process.stdout.write(`OK ${files.length} file(s) parsed:\n`);
for (const file of files) {
  process.stdout.write(`  ${relative(file)}\n`);
}
