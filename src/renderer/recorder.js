'use strict';

/*
 * Preview and normal (start/stop) recording.
 */
(function initRecorder(RP4) {
  const { state, els, util } = RP4;

  const CHUNK_INTERVAL_MS = 2000;
  const FALLBACK_MAX_QUEUED_BYTES = 128 * 1024 * 1024;
  const MAX_LOSSLESS_FRAME_BYTES = 192 * 1024 * 1024;
  const MAX_LOSSLESS_IN_FLIGHT_BYTES = 192 * 1024 * 1024;
  const LOSSLESS_FRAME_QUEUE_SIZE = 3;
  const LOSSLESS_ACK_TIMEOUT_MS = 15000;
  const LOSSLESS_DRAIN_TIMEOUT_MS = 15000;
  const MAX_LOSSLESS_AUDIO_QUEUE_BYTES = 8 * 1024 * 1024;
  const RECORDER_STOP_TIMEOUT_MS = 15000;
  const SHUTDOWN_FINALIZE_TIMEOUT_MS = 18000;

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

  function localizedRecordingStartError(error) {
    const known = {
      INSUFFICIENT_SPACE: '무압축 녹화에는 최소 2GB 이상의 여유 공간이 필요합니다.',
      FRAME_TOO_LARGE: '원본 프레임이 192MiB 안전 한도를 초과해 무압축 녹화를 시작할 수 없습니다.',
      MESSAGE_PORT_UNAVAILABLE: '이 시스템은 고속 무압축 프레임 전송을 지원하지 않습니다.',
      FOLDER_DIALOG_ACTIVE: '저장 폴더를 선택하는 동안에는 녹화를 시작할 수 없습니다.'
    };
    const key = known[String(error?.code || '')];
    if (key) return RP4.i18n.translate(key);
    const message = String(error?.message || '')
      .replace(/^Error invoking remote method '[^']+':\s*/i, '')
      .trim()
      .slice(0, 300);
    if (!message) return RP4.i18n.translate('녹화를 시작하지 못했습니다.');
    const translated = RP4.i18n.translate(message);
    if (RP4.i18n.language === 'en' && translated === message && /[가-힣]/.test(message)) {
      return RP4.i18n.translate('녹화를 시작하지 못했습니다.');
    }
    return translated;
  }

  function losslessTransportError(payload = {}) {
    const error = new Error(String(payload.message || '무압축 녹화 전송에 실패했습니다.'));
    if (typeof payload.code === 'string') error.code = payload.code;
    return error;
  }

  function settleLosslessWriter(writer) {
    if (writer.pending.size > 0) return;
    for (const resolve of writer.drainWaiters.splice(0)) resolve();
  }

  function failLosslessWriter(writer, error) {
    if (!writer.failure) writer.failure = error;
    clearTimeout(writer.readyTimeout);
    writer.rejectReady(writer.failure);
    for (const pending of writer.pending.values()) {
      window.clearTimeout(pending.timer);
      if (pending.frameBuffer) writer.framePool.push(pending.frameBuffer);
      pending.reject(writer.failure);
    }
    writer.pending.clear();
    settleLosslessWriter(writer);
  }

  function losslessInFlightFrameLimit(frameBytes, preferred = LOSSLESS_FRAME_QUEUE_SIZE) {
    const boundedFrameBytes = Math.max(1, Number(frameBytes) || 1);
    return Math.max(1, Math.min(
      LOSSLESS_FRAME_QUEUE_SIZE,
      Math.max(1, Math.floor(MAX_LOSSLESS_IN_FLIGHT_BYTES / boundedFrameBytes)),
      Math.max(1, Number(preferred) || 1)
    ));
  }

  async function openLosslessWriter(context) {
    if (typeof window.MessageChannel !== 'function') {
      throw losslessTransportError({
        code: 'MESSAGE_PORT_UNAVAILABLE',
        message: '이 시스템은 고속 무압축 프레임 전송을 지원하지 않습니다.'
      });
    }
    const channel = new window.MessageChannel();
    const writer = {
      port: channel.port1,
      nextId: 1,
      pending: new Map(),
      drainWaiters: [],
      failure: null,
      resolveReady: null,
      rejectReady: null,
      ready: null,
      readyTimeout: null,
      unsubscribe: null,
      framePool: []
    };
    writer.ready = new Promise((resolve, reject) => {
      writer.resolveReady = resolve;
      writer.rejectReady = reject;
    });
    writer.unsubscribe = window.rp4.onLosslessWriterMessage((message = {}) => {
      if (message.sessionId !== context.sessionId) return;
      if (message.type === 'ready') {
        clearTimeout(writer.readyTimeout);
        writer.resolveReady();
        return;
      }
      if (message.type === 'fatal') {
        failLosslessWriter(writer, losslessTransportError(message.error));
        return;
      }
      if (message.type !== 'ack') return;
      const pending = writer.pending.get(Number(message.id));
      if (!pending) return;
      writer.pending.delete(Number(message.id));
      window.clearTimeout(pending.timer);
      if (pending.frameBuffer) writer.framePool.push(pending.frameBuffer);
      if (message.ok === true) pending.resolve(message.result);
      else pending.reject(losslessTransportError(message.error));
      settleLosslessWriter(writer);
    });
    writer.port.addEventListener('messageerror', () => failLosslessWriter(
      writer,
      losslessTransportError({
        code: 'MESSAGE_PORT_ERROR',
        message: '무압축 녹화 전송 채널에서 손상된 메시지를 받았습니다.'
      })
    ));
    writer.port.start();
    writer.readyTimeout = window.setTimeout(() => failLosslessWriter(
      writer,
      losslessTransportError({
        code: 'MESSAGE_PORT_TIMEOUT',
        message: '무압축 녹화 전송 채널 준비 시간이 초과되었습니다.'
      })
    ), 5000);
    context.losslessWriter = writer;
    window.postMessage({
      type: 'rp4:lossless-writer-port',
      sessionId: context.sessionId
    }, '*', [channel.port2]);
    await writer.ready;

    const frameBytes = Number(context.losslessFrameBytes)
      || Number(context.output?.width) * Number(context.output?.height) * 4;
    if (Number.isSafeInteger(frameBytes) && frameBytes > 0
      && frameBytes <= MAX_LOSSLESS_FRAME_BYTES) {
      const maxInFlightFrames = losslessInFlightFrameLimit(
        frameBytes,
        context.losslessMaxInFlightFrames
      );
      context.losslessMaxInFlightFrames = maxInFlightFrames;
      writer.framePool = Array.from(
        { length: maxInFlightFrames },
        () => new ArrayBuffer(frameBytes)
      );
    }
  }

  async function writeLosslessPacket(context, kind, buffer, timestampUs = null) {
    const writer = context.losslessWriter;
    if (!writer) throw new Error('무압축 녹화 전송 채널이 열리지 않았습니다.');
    await writer.ready;
    if (writer.failure) throw writer.failure;
    if (!(buffer instanceof ArrayBuffer)
      || buffer.byteLength <= 0 || buffer.byteLength > MAX_LOSSLESS_FRAME_BYTES) {
      throw new Error('한 번에 전송할 수 있는 데이터 크기를 초과했습니다.');
    }
    const id = writer.nextId++;
    const completion = new Promise((resolve, reject) => {
      const timer = window.setTimeout(() => failLosslessWriter(
        writer,
        losslessTransportError({
          code: 'MESSAGE_PORT_ACK_TIMEOUT',
          message: '무압축 녹화 패킷 응답 시간이 초과되었습니다.'
        })
      ), LOSSLESS_ACK_TIMEOUT_MS);
      writer.pending.set(id, {
        resolve,
        reject,
        timer,
        frameBuffer: kind === 'frame' ? buffer : null
      });
    });
    try {
      // Electron 41 delivers a detached zero-byte payload to the main process when this
      // renderer-owned buffer is placed in the transfer list. Keep the bounded
      // three-buffer structured-clone path: adding `[buffer]` here corrupts recordings.
      writer.port.postMessage(['write', id, kind, timestampUs, buffer]);
    } catch (error) {
      const pending = writer.pending.get(id);
      writer.pending.delete(id);
      window.clearTimeout(pending?.timer);
      if (kind === 'frame') writer.framePool.push(buffer);
      settleLosslessWriter(writer);
      throw error;
    }
    return completion;
  }

  async function closeLosslessWriter(context) {
    const writer = context.losslessWriter;
    if (!writer) return;
    await writer.ready.catch(() => {});
    if (writer.pending.size > 0) {
      let timer;
      await Promise.race([
        new Promise((resolve) => writer.drainWaiters.push(resolve)),
        new Promise((resolve) => {
          timer = window.setTimeout(() => {
            failLosslessWriter(writer, losslessTransportError({
              code: 'MESSAGE_PORT_DRAIN_TIMEOUT',
              message: '무압축 녹화 전송 종료 대기 시간이 초과되었습니다.'
            }));
            resolve();
          }, LOSSLESS_DRAIN_TIMEOUT_MS);
        })
      ]);
      window.clearTimeout(timer);
    }
    writer.unsubscribe?.();
    writer.port.close();
    context.losslessWriter = null;
    if (writer.failure) throw writer.failure;
  }

  function updateLosslessPerformance(context) {
    const elapsed = Math.max(1, elapsedMs(context));
    context.losslessActualFps = context.losslessWrittenFrames * 1000 / elapsed;
    if (elapsed < 3000 || context.losslessPerformanceWarned) return;
    if (context.losslessDroppedFrames === 0
      && context.losslessActualFps >= context.profile.fps * 0.85) return;
    context.losslessPerformanceWarned = true;
    RP4.ui.showToast(RP4.i18n.translate(
      '저장 장치 처리 속도가 목표 FPS를 따라가지 못해 일부 프레임이 누락되고 있습니다.'
    ));
  }

  /** Maps source timestamps onto the active recording timeline, excluding pauses. */
  function normalizeLosslessTimestamp(context, sourceTimestampUs) {
    if (!Number.isFinite(sourceTimestampUs) || sourceTimestampUs < 0) return null;
    if (context.losslessSourceFirstTimestampUs == null) {
      context.losslessSourceFirstTimestampUs = sourceTimestampUs;
    }
    const normalized = Math.max(
      context.losslessLastTimestampUs == null ? 0 : context.losslessLastTimestampUs,
      sourceTimestampUs - context.losslessSourceFirstTimestampUs
        - (context.losslessPausedAccumUs || 0)
    );
    if (context.losslessFirstTimestampUs == null) {
      context.losslessFirstTimestampUs = normalized;
    }
    context.losslessLastTimestampUs = normalized;
    return normalized;
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
    context.losslessAudioQueuedBytes = 0;
    context.losslessFrameWrites = new Set();
    context.losslessInputFrames = 0;
    context.losslessWrittenFrames = 0;
    context.losslessDroppedFrames = 0;
    context.losslessFirstTimestampUs = null;
    context.losslessLastTimestampUs = null;
    context.losslessActualFps = 0;
    context.losslessPerformanceWarned = false;

    const audioTracks = context.stream.getAudioTracks();
    if (audioTracks.length > 0) {
      const audioStream = new MediaStream(audioTracks.map((track) => track.clone()));
      const audioContext = context.audioContext || new AudioContext({
        sampleRate: context.losslessAudioSampleRate
      });
      context.losslessAudioStream = audioStream;
      context.losslessPcmContext = audioContext;
      context.losslessOwnsPcmContext = audioContext !== context.audioContext;
      if (audioContext.state === 'suspended') await audioContext.resume();
      if (audioContext.state !== 'running') {
        throw new Error('무압축 PCM 오디오 처리기를 시작할 수 없습니다.');
      }
      const channels = context.losslessAudioChannels;
      const source = audioContext.createMediaStreamSource(audioStream);
      context.losslessPcmSource = source;
      const processor = audioContext.createScriptProcessor(4096, channels, channels);
      context.losslessPcmProcessor = processor;
      const silentOutput = audioContext.createGain();
      context.losslessPcmSilentOutput = silentOutput;
      silentOutput.gain.value = 0;
      source.connect(processor);
      processor.connect(silentOutput).connect(audioContext.destination);

      processor.onaudioprocess = (event) => {
        if (context.stopping || context.isPaused || !context.losslessActive) return;
        const input = event.inputBuffer;
        const frameCount = input.length;
        const channelData = Array.from({ length: channels }, (_unused, channel) => (
          input.getChannelData(Math.min(channel, input.numberOfChannels - 1))
        ));
        const bytes = frameCount * channels * 2;
        if (context.losslessAudioQueuedBytes + bytes > MAX_LOSSLESS_AUDIO_QUEUE_BYTES) {
          failRecording(context, new Error('무압축 오디오 쓰기 대기열이 8MB를 초과했습니다.'));
          return;
        }
        const buffer = new ArrayBuffer(bytes);
        const view = new DataView(buffer);
        let offset = 0;
        for (let frame = 0; frame < frameCount; frame += 1) {
          for (let channel = 0; channel < channels; channel += 1) {
            const sample = Math.max(-1, Math.min(1, channelData[channel][frame]));
            view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
            offset += 2;
          }
        }
        context.losslessAudioQueuedBytes += bytes;
        context.losslessAudioWriteQueue = context.losslessAudioWriteQueue.then(async () => {
          const result = await writeLosslessPacket(context, 'audio', buffer);
          if (result?.warning) throw new Error(result.warning);
        }).catch((error) => {
          failRecording(context, error);
        }).finally(() => {
          context.losslessAudioQueuedBytes = Math.max(
            0,
            context.losslessAudioQueuedBytes - bytes
          );
        });
      };
    }

    context.losslessPumpPromise = (async () => {
      while (!context.stopping) {
        const { value: frame, done } = await reader.read();
        if (done || !frame) break;
        let reservedBuffer = null;
        try {
          if (context.isPaused || !context.losslessActive) continue;
          context.losslessInputFrames += 1;
          const sourceTimestampUs = Number(frame.timestamp);
          const timestampUs = normalizeLosslessTimestamp(context, sourceTimestampUs);
          if (context.losslessFrameWrites.size >= context.losslessMaxInFlightFrames) {
            context.losslessDroppedFrames += 1;
            updateLosslessPerformance(context);
            continue;
          }
          const width = frame.displayWidth || frame.codedWidth;
          const height = frame.displayHeight || frame.codedHeight;
          if (width !== context.output.width || height !== context.output.height) {
            throw new Error(`무압축 프레임 크기가 변경되었습니다. (${width}x${height})`);
          }
          const writer = context.losslessWriter;
          reservedBuffer = writer?.framePool.pop() || null;
          if (!reservedBuffer) {
            context.losslessDroppedFrames += 1;
            updateLosslessPerformance(context);
            continue;
          }
          await frame.copyTo(new Uint8Array(reservedBuffer), {
            format: 'BGRA',
            layout: [{ offset: 0, stride: width * 4 }]
          });
          const write = writeLosslessPacket(
            context,
            'frame',
            reservedBuffer,
            timestampUs
          ).then((result) => {
            context.losslessWrittenFrames = Math.max(
              context.losslessWrittenFrames + 1,
              Number(result?.frames) || 0
            );
            if (result?.warning) throw new Error(result.warning);
            updateLosslessPerformance(context);
          }).catch((error) => {
            if (!context.stopping) failRecording(context, error);
          }).finally(() => {
            context.losslessFrameWrites.delete(write);
          });
          context.losslessFrameWrites.add(write);
          reservedBuffer = null;
        } finally {
          if (reservedBuffer) context.losslessWriter?.framePool.push(reservedBuffer);
          frame.close();
        }
      }
      await Promise.allSettled([...context.losslessFrameWrites]);
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
    await Promise.allSettled([...(context.losslessFrameWrites || [])]);
    await context.losslessAudioWriteQueue?.catch(() => {});
    await closeLosslessWriter(context).catch((error) => {
      if (!context.failure) context.failure = error?.message || String(error);
    });
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
    if (state.captureLifecycle === 'starting-recording') {
      await stopRecording();
      return;
    }
    if (state.captureLifecycle === 'recording') {
      await stopRecording();
      return;
    }
    if (RP4.lifecycle.isBusy()) return;
    await startRecording();
  }

  function assertStartStillCurrent(context) {
    if (context.cancelled || context.stopping
      || !RP4.lifecycle.isCurrent(context.operationId, 'starting-recording')) {
      const error = new Error('녹화 시작이 취소되었습니다.');
      error.code = 'RECORDING_START_CANCELLED';
      throw error;
    }
  }

  async function performStartRecording() {
    const operationId = RP4.lifecycle.begin('starting-recording');
    if (operationId == null) return;
    // Claim the in-flight start synchronously.  A stop request can otherwise land
    // during source/capture setup, before there is a full recording context to mark.
    const startGate = {
      operationId,
      cancelled: false,
      stopping: false,
      starting: true
    };
    state.startingRecording = startGate;
    RP4.app.updateRecordingUi();

    if (!state.selectedSource) {
      await RP4.app.selectDefaultScreen();
    }
    if (startGate.cancelled || startGate.stopping
      || !RP4.lifecycle.isCurrent(operationId, 'starting-recording')) {
      if (state.startingRecording === startGate) state.startingRecording = null;
      RP4.lifecycle.finish(operationId);
      RP4.app.updateRecordingUi();
      return;
    }
    if (!state.selectedSource) {
      if (state.startingRecording === startGate) state.startingRecording = null;
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
    if (startGate.cancelled || startGate.stopping
      || !RP4.lifecycle.isCurrent(operationId, 'starting-recording')) {
      if (state.startingRecording === startGate) state.startingRecording = null;
      RP4.lifecycle.finish(operationId);
      RP4.app.updateRecordingUi();
      return;
    }
    if (!codec) {
      if (state.startingRecording === startGate) state.startingRecording = null;
      RP4.lifecycle.finish(operationId);
      RP4.app.updateRecordingUi();
      RP4.ui.showToast('이 시스템에서 지원하는 녹화 코덱을 찾지 못했습니다.');
      return;
    }

    let session = null;
    let recorder = null;
    let capture = null;
    let context = null;
    let processingFailure = null;
    let failurePhase = 'capture';

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
        areaSelection: sourceSnapshot.areaSelection,
        onVideoProcessingFailure: (error) => {
          processingFailure ||= error;
          if (context) failRecording(context, error);
        }
      });
      failurePhase = 'recording';
      if (processingFailure) throw processingFailure;
      assertStartStillCurrent(startGate);

      if (profile.lossless
        && capture.output.width * capture.output.height * 4 > MAX_LOSSLESS_FRAME_BYTES) {
        const error = new Error(
          '원본 프레임이 192MiB 안전 한도를 초과해 무압축 녹화를 시작할 수 없습니다.'
        );
        error.code = 'FRAME_TOO_LARGE';
        throw error;
      }

      els.previewVideo.srcObject = capture.stream;
      els.previewVideo.muted = true;
      await playPreview();
      assertStartStillCurrent(startGate);
      els.previewPlaceholder.classList.add('hidden');

      RP4.capture.notifyAudioStatus(capture);

      let actualMimeType = 'video/x-raw;format=bgra';
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
        // Chromium selects the available encoder; no mode-specific hardware encoder
        // contract is exposed by RP4.
        hardwareEncoding: false,
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

      if (startGate.cancelled || startGate.stopping
        || !RP4.lifecycle.isCurrent(operationId, 'starting-recording')) {
        const stop = profile.lossless ? window.rp4.stopLosslessRecording : window.rp4.stopRecording;
        await stop({ sessionId: session.sessionId }).catch(() => {});
        assertStartStillCurrent(startGate);
      }

      context = {
        ...capture,
        operationId,
        recorder,
        lossless: profile.lossless,
        losslessFrameBytes: session.frameBytes,
        losslessMaxInFlightFrames: Math.max(
          1,
          Math.min(LOSSLESS_FRAME_QUEUE_SIZE, Number(session.maxInFlightFrames) || 1)
        ),
        losslessAudioSampleRate,
        losslessAudioChannels,
        sessionId: session.sessionId,
        codec,
        profile,
        sourceSnapshot,
        actualMimeType,
        maxQueuedBytes: Math.max(1, Number(session.maxQueuedBytes) || FALLBACK_MAX_QUEUED_BYTES),
        writeQueue: Promise.resolve(),
        queuedBytes: 0,
        failure: null,
        finalized: false,
        stopping: startGate.stopping,
        cancelled: startGate.cancelled,
        starting: true,
        losslessActive: false,
        startedAt: 0,
        pausedAccumMs: 0,
        pausedAt: 0,
        isPaused: false,
        losslessPausedAccumUs: 0,
        losslessSourceFirstTimestampUs: null
      };
      state.startingRecording = context;
      assertStartStillCurrent(context);

      if (context.lossless) {
        await openLosslessWriter(context);
        assertStartStillCurrent(context);
        await startLosslessPipelines(context);
        assertStartStillCurrent(context);
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
        assertStartStillCurrent(context);
      }
      context.startedAt = Date.now();
      context.starting = false;
      context.losslessActive = true;
      state.recording = context;
      state.startingRecording = null;
      state.isRecording = true;
      state.isPaused = false;
      state.startedAt = context.startedAt;
      state.pausedAccumMs = 0;
      state.pausedAt = 0;
      RP4.lifecycle.transition(operationId, 'recording');
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
      const startCancelled = error?.code === 'RECORDING_START_CANCELLED';
      if (!startCancelled) console.error(error);
      const failedContext = state.recording?.operationId === operationId
        ? state.recording
        : state.startingRecording?.operationId === operationId ? state.startingRecording : null;
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
      try {
        if (recorder?.state && recorder.state !== 'inactive') recorder.stop();
      } catch {
        // capture cleanup below still releases the source tracks.
      }
      capture?.cleanup();
      resetRecordingState(failedContext);
      RP4.lifecycle.finish(operationId);
      RP4.app.updateRecordingUi();
      if (!state.shuttingDown) await startPreview();
      if (startCancelled) return;
      RP4.ui.setStatus('녹화 실패', '녹화를 시작하지 못했습니다.', 'warn');
      RP4.ui.showToast(failurePhase === 'capture'
        ? localizedCaptureStartError(error)
        : localizedRecordingStartError(error));
    } finally {
      if (state.startingRecording?.operationId === operationId) {
        state.startingRecording = null;
      }
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
      if (context.recorder.state !== 'inactive') {
        context.recorder.stop();
        armRecorderStopTimeout(context);
      } else {
        void finalizeRecording(context);
      }
    } catch {
      void finalizeRecording(context);
    }
  }

  function enqueueChunk(context, blob, { terminal = false } = {}) {
    if (!context || context.finalized) return;
    if (!context.failure && context.queuedBytes + blob.size > context.maxQueuedBytes) {
      const limitMb = Math.round(context.maxQueuedBytes / 1024 / 1024);
      failRecording(context, new Error(`디스크 쓰기 대기열이 ${limitMb}MB를 초과했습니다.`));
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

  function armRecorderStopTimeout(context) {
    if (!context || context.lossless || context.finalized) return;
    window.clearTimeout(context.stopTimeout);
    context.stopTimeout = window.setTimeout(() => {
      if (context.finalized) return;
      context.failure ||= 'MediaRecorder 종료 응답 시간이 초과되었습니다.';
      // Do not leave the app indefinitely waiting for a browser stop event.  The main
      // process still preserves the bytes already flushed to its staging file.
      void finalizeRecording(context);
    }, RECORDER_STOP_TIMEOUT_MS);
  }

  async function stopRecording() {
    const starting = state.startingRecording;
    if (starting && !state.recording) {
      starting.cancelled = true;
      starting.stopping = true;
      RP4.ui.setStatus('녹화 시작 취소', '녹화 준비를 정리하고 있습니다.', 'warn');
      return state.recordingStartPromise?.catch(() => {});
    }
    const context = state.recording;
    if (!context || context.stopping) return;
    context.stopping = true;
    RP4.lifecycle.transition(context.operationId, 'stopping-recording');
    RP4.ui.setStatus('저장 중', '녹화 파일을 마무리하고 있습니다.', 'warn');
    if (context.lossless) {
      await finalizeLosslessRecording(context);
      return;
    }
    if (context.recorder.state === 'inactive') {
      await finalizeRecording(context);
      return;
    }
    try {
      context.recorder.stop();
      armRecorderStopTimeout(context);
    } catch (error) {
      context.failure ||= error?.message || 'MediaRecorder를 중지하지 못했습니다.';
      await finalizeRecording(context);
    }
  }

  async function finalizeLosslessRecording(context) {
    if (!context) return { ok: true, saved: null };
    if (context.finalizePromise) return context.finalizePromise;
    if (context.finalized) return context.finalizeResult || { ok: true, saved: null };
    context.finalized = true;
    context.finalizePromise = (async () => {
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
            hardwareEncoding: false,
            inputFrames: context.losslessInputFrames,
            droppedFrames: context.losslessDroppedFrames,
            capturedFrames: context.losslessWrittenFrames,
            effectiveFps: context.losslessActualFps,
            firstFrameTimestampUs: context.losslessFirstTimestampUs,
            lastFrameTimestampUs: context.losslessLastTimestampUs,
            performanceDegraded: context.losslessDroppedFrames > 0
              || context.losslessActualFps < context.profile.fps * 0.85
          }
        });
        resetRecordingState(context);
        RP4.app.updateRecordingUi();
        await RP4.files.render();
        if (!state.shuttingDown) await startPreview();
        if (RP4.lifecycle.isCurrent(context.operationId, 'idle') && !state.recording) {
          if (!saved) {
            RP4.ui.setStatus('저장 취소', '기록된 데이터가 없습니다.', 'warn');
          } else if (saved.status === 'partial') {
            RP4.ui.setStatus('부분 저장됨', saved.name, 'warn');
            RP4.ui.showToast(`무압축 녹화 일부만 저장했습니다: ${saved.name}`);
          } else {
            RP4.ui.setStatus('저장 완료', saved.name, 'ready');
            RP4.ui.showToast(`무압축 무손실 저장 완료: ${saved.name}`);
          }
        }
        context.finalizeResult = { ok: true, saved };
        return context.finalizeResult;
      } catch (error) {
        console.error(error);
        context.finalizeError = error;
        resetRecordingState(context);
        RP4.app.updateRecordingUi();
        if (!state.shuttingDown) await startPreview();
        if (RP4.lifecycle.isCurrent(context.operationId, 'idle') && !state.recording) {
          RP4.ui.setStatus('저장 실패', '무압축 AVI 저장을 완료하지 못했습니다.', 'warn');
          RP4.ui.showToast(error?.message || '무압축 AVI 저장을 완료하지 못했습니다.');
        }
        context.finalizeResult = { ok: false, saved: null, error };
        return context.finalizeResult;
      }
    })();
    return context.finalizePromise;
  }

  /**
   * Finishes the recording. In the normal path the file is already complete on disk, so
   * this is a close plus a rename and returns immediately.
   */
  async function finalizeRecording(context) {
    if (!context) return { ok: true, saved: null };
    if (context.finalizePromise) return context.finalizePromise;
    if (context.finalized) return context.finalizeResult || { ok: true, saved: null };

    context.finalized = true;
    window.clearTimeout(context.stopTimeout);
    context.finalizePromise = (async () => {
      const durationMs = elapsedMs(context);
      try {
        await context.writeQueue;
        const saved = await window.rp4.stopRecording({
          sessionId: context.sessionId,
          durationMs,
          failureReason: context.failure
        });
        resetRecordingState(context);
        RP4.app.updateRecordingUi();
        await RP4.files.render();
        if (!state.shuttingDown) await startPreview();
        if (RP4.lifecycle.isCurrent(context.operationId, 'idle') && !state.recording) {
          if (!saved) {
            RP4.ui.setStatus('저장 취소', '기록된 데이터가 없습니다.', 'warn');
          } else if (saved.status === 'partial') {
            RP4.ui.setStatus('부분 저장됨', saved.name, 'warn');
            RP4.ui.showToast(`녹화 오류로 일부만 저장했습니다: ${saved.name}`);
          } else if (saved.conversionError) {
            RP4.ui.setStatus('원본 저장됨', saved.name, 'warn');
            RP4.ui.showToast(`원본을 그대로 저장했습니다: ${saved.name}`);
          } else {
            RP4.ui.setStatus('저장 완료', saved.name, 'ready');
            RP4.ui.showToast(`저장 완료: ${saved.name}`);
          }
        }
        context.finalizeResult = { ok: true, saved };
        return context.finalizeResult;
      } catch (error) {
        console.error(error);
        context.finalizeError = error;
        resetRecordingState(context);
        RP4.app.updateRecordingUi();
        if (!state.shuttingDown) await startPreview();
        if (RP4.lifecycle.isCurrent(context.operationId, 'idle') && !state.recording) {
          RP4.ui.setStatus('저장 실패', '녹화 파일 저장을 완료하지 못했습니다.', 'warn');
          RP4.ui.showToast('녹화 파일 저장을 완료하지 못했습니다.');
        }
        context.finalizeResult = { ok: false, saved: null, error };
        return context.finalizeResult;
      }
    })();
    return context.finalizePromise;
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
        session.losslessPausedAccumUs = Math.round(session.pausedAccumMs * 1000);
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
    if (context && state.startingRecording === context) {
      state.startingRecording = null;
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
    if (state.startingRecording) {
      state.startingRecording.cancelled = true;
      state.startingRecording.stopping = true;
    }
    await state.recordingStartPromise?.catch(() => {});
    if (!state.recording) return;
    const context = state.recording;
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
    let timer;
    const finalized = await Promise.race([
      done.then(() => true),
      new Promise((resolve) => {
        timer = window.setTimeout(() => resolve(false), SHUTDOWN_FINALIZE_TIMEOUT_MS);
      })
    ]);
    window.clearTimeout(timer);
    if (!finalized && state.recording) {
      state.recording.failure ||= '앱 종료 중 녹화 마무리 시간이 초과되었습니다.';
      const forced = context.lossless
        ? await finalizeLosslessRecording(context)
        : await finalizeRecording(context);
      if (forced?.ok === false) {
        throw forced.error || new Error('앱 종료 중 녹화 파일을 저장하지 못했습니다.');
      }
      return;
    }
    const outcome = await context.finalizePromise;
    if (outcome?.ok === false) {
      throw outcome.error || new Error('앱 종료 중 녹화 파일을 저장하지 못했습니다.');
    }
  }

  async function smokeLosslessTransport(sessionId, frameBytes) {
    const context = { sessionId, losslessWriter: null, losslessFrameBytes: frameBytes };
    await openLosslessWriter(context);
    try {
      const buffer = context.losslessWriter.framePool.pop();
      return await writeLosslessPacket(context, 'frame', buffer, 0);
    } finally {
      await closeLosslessWriter(context);
    }
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
    normalizeLosslessTimestamp,
    finalizeForShutdown,
    smokeLosslessTransport
  };
}(window.RP4));
