'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

const { version } = require('../package.json');
const outputDir = path.join(__dirname, '..', 'dist');
const artifacts = [
  `RP4-Recorder-Setup-${version}.exe`,
  `RP4-Recorder-Portable-${version}.exe`
];

async function sha256(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const input = fs.createReadStream(filePath);
    input.on('error', reject);
    input.on('data', (chunk) => hash.update(chunk));
    input.on('end', () => resolve(hash.digest('hex')));
  });
}

async function main() {
  const lines = [];
  for (const name of artifacts) {
    const filePath = path.join(outputDir, name);
    const hash = await sha256(filePath);
    lines.push(`${hash} *${name}`);
  }
  const output = path.join(outputDir, `RP4-Recorder-${version}-SHA256SUMS.txt`);
  await fsp.writeFile(output, `${lines.join('\n')}\n`, 'utf8');
  process.stdout.write(`${output}\n`);
}

main().catch((error) => {
  process.stderr.write(`Could not write release checksums: ${error?.stack || error}\n`);
  process.exitCode = 1;
});
