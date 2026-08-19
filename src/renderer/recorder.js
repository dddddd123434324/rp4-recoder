'use strict';

/*
 * Preview and normal (start/stop) recording.
 */
(function initRecorder(RP4) {
  const { state, els, util } = RP4;

  const CHUNK_INTERVAL_MS = 2000;
  const MAX_QUEUED_BYTES = 256 * 1024 * 1024;

  function cleanupPreview() {
    if (state.preview) {
      try {
        state.preview.cleanup();
      } catch {
        // best effort
      }
      state.preview = null;
    }
    els.previewVideo.srcObject = null;
  }

  async function playPreview() {
    try {
      await els.previewVideo.play();
    } catch {
      // Autoplay can reject harmlessly; the stream is still attached.
    }
  }

  /**
   * Starts the preview. Guarded by a generation counter: rapidly switching sources used to
   * interleave two startPreview calls, letting the stale one overwrite the newer stream and
   * leak a live capture (leaving the screen-capture indicator lit).
   */
  async function startPreview() {
    if (!state.selectedSource || RP4.lifecycle.isBusy()) return;

    const generation = ++state.previewGeneration;
    cleanupPreview();

    let capture = null;
    try {
      capture = await RP4.capture.createCaptureStream({
        audio: false,
        // Area mode previews the cropped region so the selection is actually visible.
        cropArea: state.selectedMode === 'area',
        includeMic: false
      });

      if (generation !== state.previewGeneration) {
        capture.cleanup();
        return;
      }

      state.preview = capture;
      els.previewVideo.srcObject = capture.stream;
      els.previewVideo.muted = true;
      await playPreview();

      els.previewPlaceholder.classList.add('hidden');
      RP4.app.updatePreviewMeta(capture.output);
      RP4.ui.setStatus('준비 완료', '녹화 준비가\n완료되었습니다.', 'ready');
    } catch (error) {
      console.error(error);
      capture?.cleanup();
      if (generation !== state.previewGeneration) return;

      state.preview = null;
      els.previewPlaceholder.classList.remove('hidden');
      RP4.ui.setStatus('미리보기 실패', '선택한 소스를 열 수 없습니다.', 'warn');
      RP4.ui.showToast('미리보기를 시작하지 못했습니다. 다른 소스를 선택해 주세요.');
    }
  }

  async function restartPreview() {
    if (RP4.lifecycle.isBusy()) return;
    await startPreview();
  }

  function recorderOptions(profile, mimeType) {
    const options = {
      videoBitsPerSecond: profile.bitrateMbps * 1000 * 1000,
      audioBitsPerSecond: profile.audioBitrateKbps * 1000
    };
    if (mimeType) options.mimeType = mimeType;
    return options;
  }

  function localizedCaptureStartError(error) {
    const name = String(error?.name || '');
    const message = String(error?.message || '').toLowerCase();
    if (name === 'NotAllowedError' || message.includes('permission')) {
      return RP4.i18n.translate('화면 캡처 권한이 없어 녹화를 시작할 수 없습니다.');
    }
    if (name === 'OverconstrainedError' || name === 'ConstraintNotSatisfiedError') {
      return RP4.i18n.translate('선택한 해상도나 FPS를 이 캡처 소스에서 사용할 수 없습니다.');
    }
    if (name === 'NotReadableError' || name === 'AbortError'
      || message.includes('could not start video source')
      || message.includes('failed to start video source')) {
      return RP4.i18n.translate('선택한 창의 캡처를 시작할 수 없습니다. 창을 화면에 띄운 뒤 다시 선택해 주세요.');
    }
    return RP4.i18n.translate('캡처 장치를 시작하지 못했습니다. 다른 소스를 선택해 주세요.');
  }

  async function startLosslessPipelines(context) {
    if (typeof window.MediaStreamTrackProcessor !== 'function'
      || typeof window.VideoFrame !== 'function') {
      throw new Error('이 시스템은 원본 프레임 무압축 녹화를 지원하지 않습니다.');
    }
    const sourceTrack = context.stream.getVideoTracks()[0];
    if (!sourceTrack) throw new Error('무압축 녹화 영상 트랙이 없습니다.');
    const rawTrack = sourceTrack.clone();
    const processor = new window.MediaStreamTrackProcessor({ track: rawTrack });
    const reader = processor.readable.getReader();
    context.losslessTrack = rawTrack;
    context.losslessReader = reader;
    context.losslessAudioWriteQueue = Promise.resolve();

    const audioTracks = context.stream.getAudioTracks();
    if (audioTracks.length > 0) {
      const audioStream = new MediaStream(audioTracks.map((track) => track.clone()));
      const audioContext = context.audioContext || new AudioContext({
        sampleRate: context.losslessAudioSampleRate
      });
      if (audioContext.state === 'suspended') await audioContext.resume();
      if (audioContext.state !== 'running') {
        throw new Error('무압축 PCM 오디오 처리기를 시작할 수 없습니다.');
      }
      const channels = context.losslessAudioChannels;
      const source = audioContext.createMediaStreamSource(audioStream);
      const processor = audioContext.createScriptProcessor(4096, channels, channels);
      const silentOutput = audioContext.createGain();
      silentOutput.gain.value = 0;
      source.connect(processor);
      processor.connect(silentOutput).connect(audioContext.destination);

      context.losslessAudioStream = audioStream;
      context.losslessPcmContext = audioContext;
      context.losslessOwnsPcmContext = audioContext !== context.audioContext;
      context.losslessPcmSource = source;
      context.losslessPcmProcessor = processor;
      context.losslessPcmSilentOutput = silentOutput;
      processor.onaudioprocess = (event) => {
        if (context.stopping || context.isPaused) return;
        const input = event.inputBuffer;
        const frameCount = input.length;
        const channelData = Array.from({ length: channels }, (_unused, channel) => (
          input.getChannelData(Math.min(channel, input.numberOfChannels - 1))
        ));
        const buffer = new ArrayBuffer(frameCount * channels * 2);
        const view = new DataView(buffer);
        let offset = 0;
        for (let frame = 0; frame < frameCount; frame += 1) {
          for (let channel = 0; channel < channels; channel += 1) {
            const sample = Math.max(-1, Math.min(1, channelData[channel][frame]));
            view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
            offset += 2;
          }
        }
        context.losslessAudioWriteQueue = context.losslessAudioWriteQueue.then(async () => {
          const result = await window.rp4.writeLosslessAudio({
            sessionId: context.sessionId,
            buffer
          });
          if (result?.warning) throw new Error(result.warning);
        }).catch((error) => {
          failRecording(context, error);
        });
      };
    }

    context.losslessPumpPromise = (async () => {
      while (!context.stopping) {
        const { value: frame, done } = await reader.read();
        if (done || !frame) break;
        try {
          if (context.isPaused) continue;
          const width = frame.displayWidth || frame.codedWidth;
          const height = frame.displayHeight || frame.codedHeight;
          if (width !== context.output.width || height !== context.output.height) {
            throw new Error(`무압축 프레임 크기가 변경되었습니다. (${width}x${height})`);
          }
          const buffer = new ArrayBuffer(width * height * 4);
          await frame.copyTo(new Uint8Array(buffer), {
            format: 'BGRA',
            layout: [{ offset: 0, stride: width * 4 }]
          });
          const result = await window.rp4.writeLosslessFrame({
            sessionId: context.sessionId,
            buffer
          });
          context.losslessFrameCount = Number(result?.frames) || context.losslessFrameCount + 1;
          if (result?.warning) throw new Error(result.warning);
        } finally {
          frame.close();
        }
      }
    })().catch((error) => {
      if (!context.stopping) failRecording(context, error);
    });
  }

  async function stopLosslessPipelines(context) {
    if (context.losslessPcmProcessor) context.losslessPcmProcessor.onaudioprocess = null;
    context.losslessPcmSource?.disconnect();
    context.losslessPcmProcessor?.disconnect();
    context.losslessPcmSilentOutput?.disconnect();
    await context.losslessReader?.cancel().catch(() => {});
    await context.losslessPumpPromise?.catch(() => {});
    await context.losslessAudioWriteQueue?.catch(() => {});
    context.losslessTrack?.stop();
    util.stopStream(context.losslessAudioStream);
    if (context.losslessOwnsPcmContext) {
      await context.losslessPcmContext?.close().catch(() => {});
    }
  }

  /** Elapsed recording time with paused stretches excluded. */
  function elapsedMs(context = state.recording) {
    if (!context?.startedAt) return 0;
    const pausedNow = context.isPaused && context.pausedAt ? Date.now() - context.pausedAt : 0;
    return Math.max(0, Date.now() - context.startedAt - context.pausedAccumMs - pausedNow);
  }

  async function toggleRecording() {
    if (state.sourceSelectionPending) return;
    if (state.captureLifecycle === 'recording') {
      await stopRecording();
      return;
    }
    if (RP4.lifecycle.isBusy()) return;
    await startRecording();
  }

  async function performStartRecording() {
    const operationId = RP4.lifecycle.begin('starting-recording');
    if (operationId == null) return;
    RP4.app.updateRecordingUi();

    if (!state.selectedSource) {
      await RP4.app.selectDefaultScreen();
    }
    if (!state.selectedSource) {
      RP4.lifecycle.finish(operationId);
      RP4.app.updateRecordingUi();
      return;
    }

    const profile = RP4.profile.get();
    const sourceSnapshot = {
      source: state.selectedSource,
      mode: state.selectedMode,
      modeLabel: RP4.app.getModeLabel(state.selectedMode),
      sourceName: RP4.app.getSourceTitle(state.selectedSource),
      areaSelection: { ...state.areaSelection }
    };
    const codec = profile.lossless
      ? { mimeType: null, container: 'avi', codec: 'rawvideo', finish: 'direct' }
      : RP4.capture.pickRecorderMime(profile.format);
    if (!codec) {
      RP4.lifecycle.finish(operationId);
      RP4.app.updateRecordingUi();
      RP4.ui.showToast('이 시스템에서 지원하는 녹화 코덱을 찾지 못했습니다.');
      return;
    }

    let session = null;
    let capture = null;

    try {
      RP4.ui.setStatus('녹화 준비 중', '캡처 스트림을 준비하고 있습니다.', 'warn');
      state.previewGeneration += 1;
      cleanupPreview();

      capture = await RP4.capture.createCaptureStream({
        audio: profile.systemAudioEnabled,
        cropArea: sourceSnapshot.mode === 'area',
        includeMic: profile.micEnabled,
        profile,
        source: sourceSnapshot.source,
        mode: sourceSnapshot.mode,
        areaSelection: sourceSnapshot.areaSelection
      });

      if (!RP4.lifecycle.isCurrent(operationId, 'starting-recording')) {
        capture.cleanup();
        return;
      }

      els.previewVideo.srcObject = capture.stream;
      els.previewVideo.muted = true;
      await playPreview();
      els.previewPlaceholder.classList.add('hidden');

      RP4.capture.notifyAudioStatus(capture);

      let recorder = null;
      let actualMimeType = 'video/x-raw;format=bgra';
      const acceleration = profile.lossless
        ? { supported: true, powerEfficient: false }
        : await RP4.capture.detectEncodingAcceleration(profile, codec.mimeType);
      const losslessAudioTrack = profile.lossless ? capture.stream.getAudioTracks()[0] : null;
      const losslessAudioSampleRate = Math.max(
        8000,
        Math.min(192000, Math.round(capture.audioContext?.sampleRate || 48000))
      );
      const losslessAudioChannels = Math.max(
        1,
        Math.min(2, Math.round(losslessAudioTrack?.getSettings().channelCount || 2))
      );
      const recordingMeta = {
        mode: sourceSnapshot.mode,
        modeLabel: sourceSnapshot.modeLabel,
        sourceName: sourceSnapshot.sourceName,
        format: profile.format,
        mimeType: actualMimeType,
        width: capture.output.width,
        height: capture.output.height,
        fps: profile.fps,
        bitrateMbps: profile.bitrateMbps,
        encoderPreset: profile.encoderPreset,
        audioBitrateKbps: profile.audioBitrateKbps,
        requestedSystemAudio: capture.requestedSystemAudio,
        hasSystemAudio: capture.hasSystemAudio,
        requestedMic: capture.requestedMic,
        hasMic: capture.hasMic,
        lossless: profile.lossless,
        hardwareEncoding: acceleration.powerEfficient === true,
        ...(profile.lossless ? {
          audioSampleRate: losslessAudioSampleRate,
          audioChannels: losslessAudioChannels
        } : {})
      };
      if (profile.lossless) {
        session = await window.rp4.startLosslessRecording(recordingMeta);
      } else {
        recorder = new MediaRecorder(capture.stream, recorderOptions(profile, codec.mimeType));
        actualMimeType = recorder.mimeType || codec.mimeType;
        recordingMeta.mimeType = actualMimeType;
        session = await window.rp4.startRecording(recordingMeta);
      }

      if (!RP4.lifecycle.isCurrent(operationId, 'starting-recording')) {
        const stop = profile.lossless ? window.rp4.stopLosslessRecording : window.rp4.stopRecording;
        await stop({ sessionId: session.sessionId }).catch(() => {});
        capture.cleanup();
        return;
      }

      const context = {
        ...capture,
        operationId,
        recorder,
        lossless: profile.lossless,
        losslessAudioSampleRate,
        losslessAudioChannels,
        sessionId: session.sessionId,
        codec,
        profile,
        sourceSnapshot,
        actualMimeType,
        writeQueue: Promise.resolve(),
        queuedBytes: 0,
        failure: null,
        finalized: false,
        stopping: false,
        startedAt: Date.now(),
        pausedAccumMs: 0,
        pausedAt: 0,
        isPaused: false
      };
      state.recording = context;
      state.isRecording = true;
      state.isPaused = false;
      state.startedAt = context.startedAt;
      state.pausedAccumMs = 0;
      state.pausedAt = 0;
      RP4.lifecycle.transition(operationId, 'recording');

      if (context.lossless) {
        await startLosslessPipelines(context);
      } else {
        recorder.addEventListener('dataavailable', (event) => {
          if (event.data && event.data.size > 0) {
            enqueueChunk(context, event.data, {
              terminal: Boolean(context.failure || context.stopping || recorder.state === 'inactive')
            });
          }
        });
        recorder.addEventListener('error', (event) => {
          failRecording(
            context,
            event.error || new Error('MediaRecorder가 녹화 중 실패했습니다.')
          );
        });
        recorder.addEventListener('stop', () => {
          void finalizeRecording(context);
        }, { once: true });
        recorder.start(CHUNK_INTERVAL_MS);
      }
      for (const track of capture.stream.getTracks()) {
        track.addEventListener('ended', () => {
          if (!context.stopping) {
            failRecording(context, new Error('캡처 소스가 종료되었습니다.'));
          }
        }, { once: true });
      }

      RP4.app.updateRecordingUi();
      RP4.app.startTimer();

      const label = profile.lossless
        ? '원본 프레임을 무압축 AVI로 기록합니다.'
        : session.directToTarget
        ? `${profile.format.toUpperCase()}로 직접 저장합니다.`
        : '저장 시 빠른 변환이 필요합니다.';
      RP4.ui.setStatus('녹화 중', `${sourceSnapshot.sourceName} · ${label}`, 'recording');
    } catch (error) {
      console.error(error);
      const failedContext = state.recording?.operationId === operationId ? state.recording : null;
      if (failedContext?.lossless) {
        failedContext.stopping = true;
        await stopLosslessPipelines(failedContext).catch(() => {});
      }
      if (session?.sessionId) {
        try {
          if (profile.lossless) {
            await window.rp4.stopLosslessRecording({
              sessionId: session.sessionId,
              failureReason: error?.message || '무압축 녹화를 시작하지 못했습니다.'
            });
          } else {
            await window.rp4.stopRecording({ sessionId: session.sessionId });
          }
        } catch {
          // ignore
        }
      }
      capture?.cleanup();
      resetRecordingState(failedContext);
      RP4.lifecycle.finish(operationId);
      RP4.app.updateRecordingUi();
      if (!state.shuttingDown) await startPreview();
      RP4.ui.setStatus('녹화 실패', '녹화를 시작하지 못했습니다.', 'warn');
      RP4.ui.showToast(localizedCaptureStartError(error));
    }
  }

  function startRecording() {
    if (state.shuttingDown || state.sourceSelectionPending) return Promise.resolve();
    if (state.recordingStartPromise) return state.recordingStartPromise;
    const promise = performStartRecording();
    state.recordingStartPromise = promise;
    const clear = () => {
      if (state.recordingStartPromise === promise) state.recordingStartPromise = null;
    };
    void promise.then(clear, clear);
    return promise;
  }

  /**
   * Queues a chunk write. A failure now aborts the recording instead of only showing a
   * toast and continuing to produce a file with a hole in it.
   */
  function failRecording(context, error) {
    if (context.failure) return;
    context.failure = error?.message || String(error || '데이터를 저장할 수 없습니다.');
    console.error(error);
    RP4.ui.showToast(`녹화를 중지합니다. ${context.failure}`);
    RP4.ui.setStatus('녹화 오류', '데이터를 저장할 수 없어 부분 저장합니다.', 'warn');
    if (context.lossless) {
      void stopRecording();
      return;
    }
    try {
      if (context.recorder.state !== 'inactive') context.recorder.stop();
    } catch {
      // ignore
    }
  }

  function enqueueChunk(context, blob, { terminal = false } = {}) {
    if (!context || context.finalized) return;
    if (!context.failure && context.queuedBytes + blob.size > MAX_QUEUED_BYTES) {
      failRecording(context, new Error('디스크 쓰기 대기열이 256MB를 초과했습니다.'));
      terminal = true;
    }

    context.queuedBytes += blob.size;
    context.writeQueue = context.writeQueue
      .then(async () => {
        // MediaRecorder emits its last dataavailable immediately before stop. Preserve
        // that terminal Blob even when the recording is already marked failed.
        const result = await util.writeBlobInSlices(context.sessionId, blob, {
          terminal: terminal || Boolean(context.failure)
        });
        if (result?.warning) {
          RP4.ui.showToast(result.warning);
          failRecording(context, new Error(result.warning));
        }
      })
      .catch((error) => {
        failRecording(context, error);
      })
      .finally(() => {
        context.queuedBytes = Math.max(0, context.queuedBytes - blob.size);
      });
  }

  async function stopRecording() {
    const context = state.recording;
    if (!context || context.stopping) return;
    context.stopping = true;
    RP4.lifecycle.transition(context.operationId, 'stopping-recording');
    RP4.ui.setStatus('저장 중', '녹화 파일을 마무리하고 있습니다.', 'warn');
    if (context.lossless) {
      await finalizeLosslessRecording(context);
      return;
    }
    if (context.recorder.state === 'inactive') return;
    context.recorder.stop();
  }

  async function finalizeLosslessRecording(context) {
    if (!context || context.finalized) return;
    context.finalized = true;
    const durationMs = elapsedMs(context);
    try {
      await stopLosslessPipelines(context);
      const saved = await window.rp4.stopLosslessRecording({
        sessionId: context.sessionId,
        durationMs,
        failureReason: context.failure,
        meta: {
          mode: context.sourceSnapshot.mode,
          modeLabel: context.sourceSnapshot.modeLabel,
          sourceName: context.sourceSnapshot.sourceName,
          width: context.output.width,
          height: context.output.height,
          fps: context.profile.fps,
          lossless: true,
          hardwareEncoding: false
        }
      });
      resetRecordingState(context);
      RP4.app.updateRecordingUi();
      await RP4.files.render();
      if (!state.shuttingDown) await startPreview();
      if (!saved) {
        RP4.ui.setStatus('저장 취소', '기록된 데이터가 없습니다.', 'warn');
      } else if (saved.status === 'partial') {
        RP4.ui.setStatus('부분 저장됨', saved.name, 'warn');
        RP4.ui.showToast(`무압축 녹화 일부만 저장했습니다: ${saved.name}`);
      } else {
        RP4.ui.setStatus('저장 완료', saved.name, 'ready');
        RP4.ui.showToast(`무압축 무손실 저장 완료: ${saved.name}`);
      }
    } catch (error) {
      console.error(error);
      resetRecordingState(context);
      RP4.app.updateRecordingUi();
      if (!state.shuttingDown) await startPreview();
      RP4.ui.setStatus('저장 실패', '무압축 AVI 저장을 완료하지 못했습니다.', 'warn');
      RP4.ui.showToast(error?.message || '무압축 AVI 저장을 완료하지 못했습니다.');
    }
  }

  /**
   * Finishes the recording. In the normal path the file is already complete on disk, so
   * this is a close plus a rename and returns immediately.
   */
  async function finalizeRecording(context) {
    if (!context) return;

    context.finalized = true;
    const durationMs = elapsedMs(context);
    await context.writeQueue;

    try {
      const saved = await window.rp4.stopRecording({
        sessionId: context.sessionId,
        durationMs,
        failureReason: context.failure
      });
      resetRecordingState(context);
      RP4.app.updateRecordingUi();
      await RP4.files.render();
      if (!state.shuttingDown) await startPreview();

      if (!saved) {
        RP4.ui.setStatus('저장 취소', '기록된 데이터가 없습니다.', 'warn');
        return;
      }

      if (saved.status === 'partial') {
        RP4.ui.setStatus('부분 저장됨', saved.name, 'warn');
        RP4.ui.showToast(`녹화 오류로 일부만 저장했습니다: ${saved.name}`);
      } else if (saved.conversionError) {
        RP4.ui.setStatus('원본 저장됨', saved.name, 'warn');
        RP4.ui.showToast(`원본을 그대로 저장했습니다: ${saved.name}`);
      } else {
        RP4.ui.setStatus('저장 완료', saved.name, 'ready');
        RP4.ui.showToast(`저장 완료: ${saved.name}`);
      }
    } catch (error) {
      console.error(error);
      resetRecordingState(context);
      RP4.app.updateRecordingUi();
      if (!state.shuttingDown) await startPreview();
      RP4.ui.setStatus('저장 실패', '녹화 파일 저장을 완료하지 못했습니다.', 'warn');
      RP4.ui.showToast('녹화 파일 저장을 완료하지 못했습니다.');
    }
  }

  function togglePause() {
    const session = state.recording;
    if (!session || !state.isRecording) return;
    if (session.lossless) {
      if (!session.isPaused) {
        session.isPaused = true;
        state.isPaused = true;
        state.pausedAt = Date.now();
        session.pausedAt = state.pausedAt;
        RP4.app.updateRecordingUi();
        RP4.ui.setStatus('일시정지', '녹화가 일시정지되었습니다.', 'warn');
        return;
      }
      if (state.pausedAt) {
        state.pausedAccumMs += Date.now() - state.pausedAt;
        session.pausedAccumMs = state.pausedAccumMs;
        state.pausedAt = 0;
        session.pausedAt = 0;
      }
      state.isPaused = false;
      session.isPaused = false;
      RP4.app.updateRecordingUi();
      RP4.ui.setStatus('녹화 중', `${RP4.app.getSourceTitle(state.selectedSource)} 녹화 중입니다.`, 'recording');
      return;
    }
    const recorder = session.recorder;

    if (recorder.state === 'recording') {
      recorder.pause();
      session.isPaused = true;
      state.isPaused = true;
      // Remember when the pause began so neither the timer nor the saved duration counts
      // paused time.
      state.pausedAt = Date.now();
      session.pausedAt = state.pausedAt;
      RP4.app.updateRecordingUi();
      RP4.ui.setStatus('일시정지', '녹화가 일시정지되었습니다.', 'warn');
      return;
    }

    if (recorder.state === 'paused') {
      recorder.resume();
      if (state.pausedAt) {
        state.pausedAccumMs += Date.now() - state.pausedAt;
        session.pausedAccumMs = state.pausedAccumMs;
        state.pausedAt = 0;
        session.pausedAt = 0;
      }
      state.isPaused = false;
      session.isPaused = false;
      RP4.app.updateRecordingUi();
      RP4.ui.setStatus('녹화 중', `${RP4.app.getSourceTitle(state.selectedSource)} 녹화 중입니다.`, 'recording');
    }
  }

  function resetRecordingState(context = state.recording) {
    if (context) {
      try {
        context.cleanup();
      } catch {
        // best effort
      }
    }
    if (context && state.recording !== context) {
      RP4.lifecycle.finish(context.operationId);
      return;
    }
    RP4.app.stopTimer();
    state.recording = null;
    state.isRecording = false;
    state.isPaused = false;
    state.startedAt = 0;
    state.pausedAccumMs = 0;
    state.pausedAt = 0;
    if (context) RP4.lifecycle.finish(context.operationId);
  }

  /** Waits for an in-flight recording to finish, used while the app is shutting down. */
  async function finalizeForShutdown() {
    await state.recordingStartPromise?.catch(() => {});
    if (!state.recording) return;
    const done = new Promise((resolve) => {
      const poll = () => {
        if (!state.recording) {
          resolve();
          return;
        }
        window.setTimeout(poll, 100);
      };
      poll();
    });
    await stopRecording();
    await done;
  }

  RP4.recorder = {
    startPreview,
    restartPreview,
    cleanupPreview,
    toggleRecording,
    startRecording,
    stopRecording,
    togglePause,
    elapsedMs,
    finalizeForShutdown
  };
}(window.RP4));
