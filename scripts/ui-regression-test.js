#!/usr/bin/env electron
'use strict';

// Real renderer and MediaRecorder, with isolated IPC and a synthetic video source.
const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const root = path.resolve(__dirname, '..');
let sandbox;
let win;

async function run() {
  sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'rp4-itest-'));
  app.setPath('userData', sandbox);
  if (process.env.RP4_TEST_CLEANUP_MANIFEST) {
    await fs.writeFile(process.env.RP4_TEST_CLEANUP_MANIFEST, JSON.stringify({ sandbox }));
  }
  await app.whenReady();
  win = new BrowserWindow({
    width: 1440, height: 900, useContentSize: true, show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false }
  });
  const index = await fs.readFile(path.join(root, 'src', 'index.html'), 'utf8');
  const html = index.replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '')
    .replace('<head>', `<head><base href="${pathToFileURL(path.join(root, 'src') + path.sep).href}">`);
  const fixture = path.join(sandbox, 'ui.html');
  await fs.writeFile(fixture, html);
  await win.loadFile(fixture);
  await win.webContents.executeJavaScript(`
    window.__test = { areaCalls: 0, stopCalls: 0, writtenBytes: 0, failSave: false, events: [] };
    window.rp4 = new Proxy({
      appInfo: async () => ({ version: 'test', recordingsDir: '', isSmoke: false }),
      getAppSettings: async () => ({}),
      getHotkeys: async () => ({}),
      listRecordings: async () => [],
      listSources: async () => [],
      startRecording: async () => ({ sessionId: 'test', directToTarget: true }),
      writeRecordingChunk: async ({ buffer }) => { __test.writtenBytes += buffer.byteLength; },
      stopRecording: async () => {
        __test.stopCalls++;
        __test.events.push('saving');
        await new Promise(resolve => { __test.releaseSave = resolve; });
        if (__test.failSave) throw new Error('test save failure');
        __test.events.push('saved');
        return { name: 'test.mp4', status: 'saved' };
      },
      selectArea: async () => {
        __test.areaCalls++;
        __test.events.push('selecting');
        if (__test.holdArea) await new Promise(resolve => { __test.releaseArea = resolve; });
        return __test.areaResult;
      }
    }, { get(target, key) { return target[key] || (async () => {}); } });
    undefined;
  `);
  for (const name of ['core', 'i18n', 'modal', 'capture', 'profile', 'recorder', 'clips', 'hotkeys', 'files', 'app']) {
    const source = await fs.readFile(path.join(root, 'src', 'renderer', `${name}.js`), 'utf8');
    await win.webContents.executeJavaScript(source);
  }
  await win.webContents.executeJavaScript(`
    (async () => {
      await RP4.app.init();
      await document.fonts.ready;
      // Avoid native screen capture: the recording still uses real MediaRecorder events.
      RP4.capture.createCaptureStream = async () => {
        const canvas = document.createElement('canvas');
        canvas.width = 64; canvas.height = 48;
        const ctx = canvas.getContext('2d');
        let frame = 0;
        const draw = () => {
          ctx.fillStyle = 'hsl(' + (++frame * 17 % 360) + ',80%,50%)';
          ctx.fillRect(0, 0, 64, 48);
        };
        draw();
        const stream = canvas.captureStream(30);
        const timer = setInterval(draw, 30);
        return { stream, output: { width: 64, height: 48 }, gains: {},
          cleanup() { clearInterval(timer); stream.getTracks().forEach(track => track.stop()); } };
      };
      const source = { id: 'screen:test', type: 'screen', displayId: '1', display: { primary: true, index: 1 } };
      window.rp4.listSources = async () => [source];
      RP4.state.sources = [source];
      RP4.state.selectedSource = source;
      RP4.state.selectedMode = 'area';
      RP4.state.hasAreaSelection = true;
      RP4.state.areaSelection = { x: 0, y: 0, width: 0.5, height: 0.5 };
      __test.areaResult = { displayId: '1', selection: { x: 0.25, y: 0.25, width: 0.5, height: 0.5 },
        absolute: { width: 32, height: 24 } };
      RP4.els.previewVideo.play = async () => {};
      RP4.els.systemAudioToggle.checked = false;
      RP4.els.resolutionSelect.value = '1280x720';
      RP4.els.fpsSelect.value = '30';
    })()
  `);

  const behavior = await win.webContents.executeJavaScript(`
    (async () => {
      const checks = [];
      const check = (name, ok) => checks.push({ name, ok,
        detail: { bytes: __test.writtenBytes, events: __test.events.join(','),
          recording: RP4.state.isRecording, lifecycle: RP4.state.captureLifecycle,
          areaX: RP4.state.areaSelection.x } });
      const waitFor = async predicate => {
        const deadline = Date.now() + 5000;
        while (!predicate()) {
          if (Date.now() > deadline) throw new Error('UI test wait timed out');
          await new Promise(resolve => setTimeout(resolve, 10));
        }
      };
      await RP4.app.setMode('area');
      check('idle area selection opens directly', __test.areaCalls === 1 && __test.stopCalls === 0
        && RP4.state.areaSelection.x === 0.25 && !RP4.state.sourceSelectionPending);

      __test.areaResult = null;
      const oldArea = RP4.state.areaSelection;
      await RP4.app.setMode('area');
      check('cancelled selection retains the previous area', RP4.state.areaSelection === oldArea
        && RP4.state.selectedMode === 'area' && RP4.state.hasAreaSelection);
      __test.areaResult = { displayId: '1', selection: { x: 0.1, y: 0.1, width: 0.8, height: 0.8 },
        absolute: { width: 50, height: 38 } };

      await RP4.recorder.startRecording();
      check('synthetic recording starts', RP4.state.isRecording);
      await new Promise(resolve => setTimeout(resolve, 2500));
      const before = __test.areaCalls;
      __test.events.length = 0;
      const reselect = RP4.app.setMode('area');
      await waitFor(() => Boolean(__test.releaseSave));
      check('selector waits while recording is being saved', __test.areaCalls === before
        && RP4.state.sourceSelectionPending && RP4.els.recordButton.disabled);
      await RP4.app.setMode('area');
      await RP4.recorder.startRecording();
      check('repeat clicks and record starts cannot interrupt saving', __test.stopCalls === 1
        && __test.areaCalls === before);
      __test.releaseSave();
      await reselect;
      check('recording bytes are flushed before reselection', __test.writtenBytes > 0
        && __test.events.join(',') === 'saving,saved,selecting'
        && !RP4.state.isRecording && !RP4.lifecycle.isBusy() && RP4.state.areaSelection.x === 0.1);
      check('controls unlock after selecting', !RP4.state.sourceSelectionPending
        && !RP4.els.recordButton.disabled && !RP4.els.createPresetButton.disabled);

      await RP4.recorder.startRecording();
      RP4.recorder.togglePause();
      check('pause fixture is active', RP4.state.isPaused);
      __test.releaseSave = null;
      __test.failSave = true;
      const failureArea = RP4.state.areaSelection;
      const failureCalls = __test.areaCalls;
      const failedReselect = RP4.app.setMode('area');
      await waitFor(() => Boolean(__test.releaseSave));
      __test.releaseSave();
      await failedReselect;
      check('save failure preserves area and unlocks controls', __test.areaCalls === failureCalls
        && RP4.state.areaSelection === failureArea && !RP4.state.sourceSelectionPending
        && !RP4.els.recordButton.disabled && !RP4.lifecycle.isBusy());

      __test.holdArea = true;
      const pendingSelection = RP4.app.setMode('area');
      await waitFor(() => Boolean(__test.releaseArea));
      const pendingCalls = __test.areaCalls;
      await RP4.app.setMode('area');
      check('repeat clicks cannot open duplicate selectors', __test.areaCalls === pendingCalls);
      __test.releaseArea();
      await pendingSelection;
      return checks;
    })()
  `);
  for (const { name, ok, detail } of behavior) {
    assert.ok(ok, `${name}: ${JSON.stringify(detail)}`);
    process.stdout.write(`PASS  ${name}\n`);
  }

  for (const [width, height] of [[1440, 900], [900, 560]]) {
    win.setContentSize(width, height);
    for (const language of ['ko', 'en']) {
      const layout = await win.webContents.executeJavaScript(`
        (async () => {
          RP4.i18n.setLanguage(${JSON.stringify(language)});
          document.querySelector('[data-settings-popup="record"]').click();
          const sizes = [];
          for (const tab of document.querySelectorAll('[data-settings-tab]')) {
            tab.click();
            await new Promise(resolve => requestAnimationFrame(resolve));
            const card = document.querySelector('.settings-modal-card').getBoundingClientRect();
            sizes.push([card.width, card.height]);
          }
          document.querySelector('[data-settings-tab="record"]').click();
          const scroll = document.querySelector('.settings-popup-scroll');
          const bounds = scroll.getBoundingClientRect();
          const preset = document.querySelector('#createPresetButton').getBoundingClientRect();
          const fits = preset.bottom <= bounds.bottom && scroll.scrollHeight <= scroll.clientHeight + 1;
          scroll.scrollTop = scroll.scrollHeight;
          const reachable = document.querySelector('#createPresetButton').getBoundingClientRect().bottom <= bounds.bottom + 1;
          scroll.scrollTop = 0;
          return { sizes, fits, reachable, width: innerWidth, height: innerHeight };
        })()
      `);
      assert.ok(layout.sizes.every(size => size[0] === layout.sizes[0][0] && size[1] === layout.sizes[0][1]),
        `tabs share dimensions at ${width}x${height} (${language})`);
      assert.ok(layout.reachable, 'preset button remains reachable in a small window');
      if (height === 900) assert.ok(layout.fits, `preset button fits without scrolling (${language})`);
      process.stdout.write(`PASS  settings tabs at ${width}x${height} (${language}): ${JSON.stringify(layout)}\n`);
    }
  }
  if (process.env.RP4_UI_SCREENSHOT) {
    win.setContentSize(1440, 900);
    await win.webContents.executeJavaScript(`RP4.i18n.setLanguage('ko'); document.querySelector('[data-settings-tab="record"]').click();`);
    const screenshot = await win.webContents.capturePage();
    await fs.writeFile(process.env.RP4_UI_SCREENSHOT, screenshot.toPNG());
  }
}

run().then(() => {
  win?.destroy();
  app.exit(0);
}).catch(error => {
  process.stderr.write(`${error.stack}\n`);
  win?.destroy();
  app.exit(1);
});
