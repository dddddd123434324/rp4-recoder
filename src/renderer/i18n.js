'use strict';

(function initI18n(RP4) {
  const ENGLISH = {
    '캡처 소스를 선택해 주세요.': 'Select a capture source.',
    '생성한 프리셋이 없습니다.\n설정에서 프리셋을 만들어 주세요.': 'No custom presets.\nCreate one in Settings.',
    '저장 후 백그라운드에서 파일 구조를 정리합니다. 녹화 저장을 지연시키지 않습니다.': 'Optimizes the file structure in the background after saving.',
    'PNG는 원본 해상도를 무손실로 저장하므로 품질이 최고로 고정됩니다.': 'PNG is saved losslessly at the original resolution.',
    '스크린샷 설정은 녹화 해상도와 녹화 프리셋에 영향을 받지 않습니다.': 'Screenshot settings are independent of recording presets.',
    '최소화되었거나 숨겨진 창을 복원하고 있습니다.': 'Restoring the minimized or hidden window.',
    '이 창을 복원하거나 캡처할 수 없습니다.': 'This window cannot be restored or captured.',
    '아직 녹화 파일이 없습니다.': 'No recordings yet.',
    '선택 가능한 소스가 없습니다.': 'No capture sources are available.',
    '지원되는 녹화 코덱을 찾지 못했습니다.': 'No supported recording codec was found.',
    'H.264로 기록한 뒤 빠른 컨테이너 변환만 수행합니다.': 'Records H.264 and performs a fast container conversion.',
    '이 시스템은 H.264 직접 기록을 지원하지 않아 저장 시 변환이 필요합니다.': 'This system requires conversion when saving.',
    '클립 모드가 메모리에 유지할 최대 용량입니다.': 'Maximum memory used by Clip Mode.',
    '현재 확보 길이 / 목표 클립 길이': 'Buffered duration / target clip duration',
    '메모리 한도로 인해 현재 확보 길이가 목표보다 짧을 수 있습니다.': 'The memory limit may shorten the available clip.',
    '녹화 준비가\n완료되었습니다.': 'Recording is\nready.',
    '캡처 가능한 화면을 찾지 못했습니다.': 'No capturable display was found.',
    '진행 중인 캡처 소스 선택을 먼저 완료해 주세요.': 'Finish selecting the current capture source first.',
    '녹화 중에는 캡처 모드를 바꿀 수 없습니다.': 'Capture mode cannot be changed while recording.',
    '실제 화면에서 녹화할 영역을 드래그하세요.': 'Drag the area to record on the desktop.',
    '영역 선택 화면을 열지 못했습니다.': 'Could not open the area selector.',
    '영역 녹화에 사용할 화면을 찾지 못했습니다.': 'No display is available for area recording.',
    '녹화 중에는 소스를 바꿀 수 없습니다.': 'The source cannot be changed while recording.',
    '녹화 중에는 저장 경로를 바꿀 수 없습니다.': 'The save folder cannot be changed while recording.',
    '저장 경로를 변경하지 못했습니다.': 'Could not change the save folder.',
    '스크린샷 설정을 저장하지 못했습니다.': 'Could not save screenshot settings.',
    '앱 설정을 불러오지 못했습니다.': 'Could not load app settings.',
    '캡처 소스를 불러오지 못했습니다.': 'Could not load capture sources.',
    '설정을 저장하지 못했습니다.': 'Could not save settings.',
    '저장 공간이 거의 없습니다. 녹화를 중지합니다.': 'Storage is almost full. Recording will stop.',
    '녹화 파일 목록을 불러오지 못했습니다.': 'Could not load the recording list.',
    '먼저 캡처 소스를 선택해 주세요.': 'Select a capture source first.',
    '스크린샷 저장에 실패했습니다.': 'Failed to save the screenshot.',
    '파일 작업을 완료하지 못했습니다.': 'Could not complete the file operation.',
    '파일을 찾을 수 없습니다.': 'The file could not be found.',
    '녹화 파일을 재생할 수 없습니다.': 'The recording cannot be played.',
    '이 파일을 휴지통으로 이동할까요?': 'Move this file to the Recycle Bin?',
    '녹화 파일을 삭제하지 못했습니다.': 'Could not delete the recording.',
    '녹화 파일을 휴지통으로 이동했습니다.': 'The recording was moved to the Recycle Bin.',
    '미리보기를 시작하지 못했습니다. 다른 소스를 선택해 주세요.': 'Could not start the preview. Select another source.',
    '이 시스템에서 지원하는 녹화 코덱을 찾지 못했습니다.': 'No supported recording codec was found on this system.',
    '캡처 스트림을 준비하고 있습니다.': 'Preparing the capture stream.',
    '녹화를 시작하지 못했습니다.': 'Could not start recording.',
    '화면 캡처 권한이 없어 녹화를 시작할 수 없습니다.': 'Screen capture permission is required to start recording.',
    '선택한 해상도나 FPS를 이 캡처 소스에서 사용할 수 없습니다.': 'The selected resolution or frame rate is not supported by this capture source.',
    '선택한 창의 캡처를 시작할 수 없습니다. 창을 화면에 띄운 뒤 다시 선택해 주세요.': 'Could not capture the selected window. Show the window and select it again.',
    '캡처 장치를 시작하지 못했습니다. 다른 소스를 선택해 주세요.': 'Could not start the capture device. Select a different source.',
    '데이터를 저장할 수 없어 부분 저장합니다.': 'Data could not be written. Saving a partial recording.',
    '녹화 파일을 마무리하고 있습니다.': 'Finalizing the recording.',
    '기록된 데이터가 없습니다.': 'There is no recorded data.',
    '녹화 파일 저장을 완료하지 못했습니다.': 'Could not finish saving the recording.',
    '녹화가 일시정지되었습니다.': 'Recording is paused.',
    '최근 장면 버퍼를 준비하고 있습니다.': 'Preparing the recent footage buffer.',
    '클립 녹화 모드를 시작하지 못했습니다.': 'Could not start Clip Mode.',
    '클립 버퍼를 정리하고 있습니다.': 'Clearing the clip buffer.',
    '아직 저장할 클립 데이터가 없습니다.': 'There is no clip data to save yet.',
    '클릭 시점까지의 최근 장면을 저장하고 있습니다.': 'Saving recent footage up to the click.',
    '클립 파일 저장을 완료하지 못했습니다.': 'Could not finish saving the clip.',
    '녹화 중에는 프리셋을 바꿀 수 없습니다.': 'Presets cannot be changed while recording.',
    '선택한 프리셋을 저장하지 못했습니다.': 'Could not save the selected preset.',
    '현재 녹화 설정을 새 프리셋으로 저장합니다.': 'Save the current recording settings as a new preset.',
    '이름을 바꾸고 현재 녹화 설정으로 덮어씁니다.': 'Rename and overwrite with the current recording settings.',
    '프리셋을 생성했습니다.': 'Preset created.',
    '프리셋을 저장하지 못했습니다.': 'Could not save the preset.',
    '프리셋을 수정했습니다.': 'Preset updated.',
    '프리셋을 수정하지 못했습니다.': 'Could not update the preset.',
    '프리셋을 삭제했습니다.': 'Preset deleted.',
    '프리셋을 삭제하지 못했습니다.': 'Could not delete the preset.',
    '문자/숫자 키는 Ctrl, Alt, Win 중 하나와 함께 지정해 주세요.': 'Use letter or number keys with Ctrl, Alt, or Win.',
    'Windows나 다른 프로그램이 이미 사용 중인 조합입니다. RP4 창이 활성화되어 있을 때는 내부 단축키로 동작합니다.': 'This shortcut is already used by Windows or another app. It still works while RP4 is focused.',
    '단축키 설정을 불러오지 못했습니다.': 'Could not load shortcut settings.',
    '이미 사용 중인 단축키입니다.': 'This shortcut is already in use.',
    '단축키를 저장했지만 Windows에서 등록하지 못했습니다.': 'The shortcut was saved but could not be registered with Windows.',
    '단축키를 저장했습니다.': 'Shortcut saved.',
    '단축키를 비웠습니다.': 'Shortcut cleared.',
    '단축키 저장에 실패했습니다.': 'Failed to save the shortcut.',
    '단축키를 기본값으로 되돌렸습니다.': 'Shortcuts restored to defaults.',
    '단축키 초기화에 실패했습니다.': 'Failed to reset shortcuts.',
    '미리보기': 'Preview',
    '일시정지 / 재개': 'Pause / Resume',
    '녹화 시작 / 중지': 'Start / Stop Recording',
    '클립 모드 시작 / 중지': 'Start / Stop Clip Mode',
    '클립 녹화 모드 시작': 'Start Clip Mode',
    '클립 녹화 모드 중지': 'Stop Clip Mode',
    '클립 저장 중': 'Saving Clip',
    '클립 저장': 'Save Clip',
    '클립 길이 증가': 'Increase clip duration',
    '클립 길이 감소': 'Decrease clip duration',
    '클립 길이': 'Clip Duration',
    '최근 녹화 파일': 'Recent recordings',
    '최근 파일 가로 목록': 'Horizontal recent files list',
    '목록 새로고침': 'Refresh list',
    '최근 파일': 'Recent Files',
    '녹화 파일': 'Recordings',
    '경로 지정': 'Choose Folder',
    '캡처 모드': 'Capture Mode',
    '전체 화면': 'Full Screen',
    '특정 모니터': 'Specific Monitor',
    '창 선택': 'Select Window',
    '영역 녹화 화면 선택': 'Select Display for Area Recording',
    '영역 녹화': 'Area Recording',
    '녹화 프리셋': 'Recording Presets',
    '저용량 녹화': 'Low Size',
    '일반 녹화': 'Standard',
    '고화질 녹화': 'High Quality',
    '게임 녹화': 'Game Recording',
    '게임 선택': 'Select Game',
    '원본 해상도': 'Native Resolution',
    'AVI 무압축': 'Uncompressed AVI',
    '원본 해상도 · 무압축 무손실 (AVI)': 'Native Resolution · Uncompressed Lossless (AVI)',
    '원본 프레임을 압축하지 않고 AVI로 저장합니다. 파일 용량이 매우 큽니다.': 'Saves native frames to AVI without compression. Files will be extremely large.',
    'Windows Graphics Capture를 사용하고, MP4 선택 시 H.264 하드웨어 인코더를 우선 사용합니다.': 'Uses Windows Graphics Capture and prefers an H.264 hardware encoder when MP4 is selected.',
    '녹화 FPS 표시': 'Show Recording FPS',
    '게임 미리보기와 저장 영상의 왼쪽 위에 실제 캡처 FPS를 표시합니다.': 'Shows the actual capture FPS in the top-left of the preview and saved recording.',
    'FPS 표시 갱신': 'FPS Update Interval',
    '표시되는 캡처 FPS의 계산 주기입니다.': 'How often the displayed capture FPS is recalculated.',
    '게임 인코더': 'Game Encoder',
    '하드웨어 가속 지원 여부 확인 중': 'Checking hardware acceleration support',
    'H.264 하드웨어 인코딩 사용 가능': 'H.264 hardware encoding available',
    '하드웨어 인코딩 사용 가능': 'hardware encoding available',
    '소프트웨어 인코딩으로 대체될 수 있습니다.': 'Software encoding may be used as a fallback.',
    'Chromium이 최적 인코더를 자동 선택합니다.': 'Chromium automatically selects the best encoder.',
    '무압축 AVI는 하드웨어 영상 인코더를 사용하지 않습니다.': 'Uncompressed AVI does not use a hardware video encoder.',
    '원본 프레임을 무압축 AVI로 기록합니다.': 'Records native frames to uncompressed AVI.',
    '무압축 무손실 설정에서는 클립 모드를 사용할 수 없습니다.': 'Clip Mode is unavailable with uncompressed lossless recording.',
    '무압축 AVI 저장을 완료하지 못했습니다.': 'Could not finish saving the uncompressed AVI.',
    '무압축 무손실 저장 완료:': 'Uncompressed lossless recording saved:',
    '생성한 녹화 프리셋': 'Custom Presets',
    '소스 선택': 'Select Source',
    '모니터 선택': 'Select Monitor',
    '설정 종류': 'Settings sections',
    '설정': 'Settings',
    '녹화': 'Recording',
    '스크린샷': 'Screenshot',
    '단축키': 'Shortcuts',
    '언어': 'Language',
    '저장 형식': 'File Format',
    '해상도': 'Resolution',
    '프레임': 'Frame Rate',
    '비트레이트': 'Bitrate',
    '변환 품질': 'Conversion Quality',
    '오디오 품질': 'Audio Quality',
    '매우 빠름': 'Ultra Fast',
    '빠름': 'Fast',
    '균형': 'Balanced',
    '고화질 우선': 'Higher Quality',
    '최고화질 우선': 'Best Quality',
    '마이크': 'Microphone',
    '시스템 오디오': 'System Audio',
    'MP4 최적화': 'Optimize MP4',
    '클립 버퍼 한도': 'Clip Buffer Limit',
    '이 설정의 프리셋 생성': 'Create Preset from These Settings',
    'PNG (무손실)': 'PNG (Lossless)',
    '이미지 품질': 'Image Quality',
    '최고 (100%)': 'Best (100%)',
    '매우 높음 (95%)': 'Very High (95%)',
    '높음 (90%)': 'High (90%)',
    '보통 (80%)': 'Standard (80%)',
    '용량 절약 (70%)': 'Smaller File (70%)',
    '기본값으로 복원': 'Restore Defaults',
    '최소화됨': 'Minimized',
    '최소화': 'Minimize',
    '최대화': 'Maximize',
    '닫기': 'Close',
    '일시정지': 'Pause',
    '재개': 'Resume',
    '소스 없음': 'No Source',
    '창 지정': 'Window',
    '준비 완료': 'Ready',
    '미리보기 실패': 'Preview Failed',
    '녹화 준비 중': 'Preparing Recording',
    '녹화 중': 'Recording',
    '녹화 실패': 'Recording Failed',
    '녹화 오류': 'Recording Error',
    '저장 중': 'Saving',
    '저장 취소': 'Save Cancelled',
    '부분 저장됨': 'Partially Saved',
    '원본 저장됨': 'Original Saved',
    '저장 완료': 'Saved',
    '저장 실패': 'Save Failed',
    '클립 녹화 중': 'Clip Mode Active',
    '클립 저장 완료': 'Clip Saved',
    '클립 저장 실패': 'Clip Save Failed',
    '파일 위치 열기': 'Show File Location',
    '녹화 재생': 'Play Recording',
    '녹화 삭제': 'Delete Recording',
    '부분 저장': 'Partial',
    '검증 중': 'Verifying',
    '검증 실패': 'Verification Failed',
    '원본 보존': 'Original Preserved',
    '복구됨': 'Recovered',
    '새 프리셋': 'New Preset',
    '프리셋 수정': 'Edit Preset',
    '프리셋 삭제': 'Delete Preset',
    '프리셋 이름': 'Preset Name',
    '수정': 'Edit',
    '삭제': 'Delete',
    '저장': 'Save',
    '확인': 'Confirm',
    '취소': 'Cancel',
    '지정 안 함': 'Not Set',
    '입력 중...': 'Listening...',
    '변환 중': 'Converting',
    '컨테이너 정리 중': 'Finalizing Container',
    '저장 파일 검증 중': 'Verifying Saved File',
    'MP4 최적화 중 (백그라운드)': 'Optimizing MP4 (background)',
    '초': 'sec',
    '분': 'min',
    '현재 경로:': 'Current folder:',
    '저장 경로를 변경했습니다:': 'Save folder changed:',
    '스크린샷 저장:': 'Screenshot saved:',
    '영역을 지정했습니다:': 'Area selected:',
    '사용자 프리셋': 'Custom Preset',
    '주 화면': 'Primary',
    '모니터': 'Monitor'
  };

  const replacements = Object.entries(ENGLISH).sort((a, b) => b[0].length - a[0].length);
  const originalText = new WeakMap();
  const originalAttributes = new WeakMap();
  let language = 'ko';

  function translate(value) {
    if (language !== 'en' || value == null) return String(value ?? '');
    let output = String(value);
    for (const [source, target] of replacements) output = output.replaceAll(source, target);
    return output;
  }

  function skipped(node) {
    const element = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
    return Boolean(element?.closest(
      'script, style, [data-i18n-skip], .recording-info strong, .source-card strong, .custom-preset-row .preset-card strong'
    ));
  }

  function translateTextNode(node) {
    if (skipped(node)) return;
    if (language === 'ko') {
      if (originalText.has(node)) {
        node.nodeValue = originalText.get(node);
        originalText.delete(node);
      }
      return;
    }
    const current = node.nodeValue || '';
    if (/[가-힣]/.test(current)) {
      const translated = translate(current);
      const previousOriginal = originalText.get(node);
      if (translated === current) {
        // Assigning the same untranslated Korean text still emits a characterData
        // mutation. The observer would then assign it again forever and freeze the
        // renderer, including on every later launch while English is persisted.
        if (previousOriginal != null && current !== translate(previousOriginal)) {
          originalText.delete(node);
        }
        return;
      }
      if (previousOriginal == null || current !== translate(previousOriginal)) {
        originalText.set(node, current);
      }
      node.nodeValue = translated;
    } else if (originalText.has(node) && current !== translate(originalText.get(node))) {
      originalText.delete(node);
    }
  }

  function translateElement(element) {
    if (skipped(element)) return;
    const attributes = ['title', 'aria-label', 'placeholder'];
    let originals = originalAttributes.get(element);
    for (const name of attributes) {
      const current = element.getAttribute(name);
      if (language === 'ko') {
        if (originals?.has(name)) element.setAttribute(name, originals.get(name));
        continue;
      }
      if (current && /[가-힣]/.test(current)) {
        const translated = translate(current);
        const previousOriginal = originals?.get(name);
        if (translated === current) {
          // setAttribute() also reports a mutation when the assigned value is
          // identical, so unknown Korean attributes need the same no-op guard.
          if (previousOriginal != null && current !== translate(previousOriginal)) {
            originals.delete(name);
          }
          continue;
        }
        if (!originals) {
          originals = new Map();
          originalAttributes.set(element, originals);
        }
        if (previousOriginal == null || current !== translate(previousOriginal)) {
          originals.set(name, current);
        }
        element.setAttribute(name, translated);
      } else if (originals?.has(name) && current !== translate(originals.get(name))) {
        originals.delete(name);
      }
    }
    if (language === 'en' && originals?.size === 0) originalAttributes.delete(element);
    if (language === 'ko' && originals) originalAttributes.delete(element);
  }

  function apply(root = document.body) {
    if (!root) return;
    if (root.nodeType === Node.TEXT_NODE) translateTextNode(root);
    if (root.nodeType === Node.ELEMENT_NODE) translateElement(root);
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      if (walker.currentNode.nodeType === Node.TEXT_NODE) translateTextNode(walker.currentNode);
      else translateElement(walker.currentNode);
    }
    document.documentElement.lang = language;
  }

  function setLanguage(next) {
    language = next === 'en' ? 'en' : 'ko';
    apply();
  }

  const observer = new MutationObserver((records) => {
    if (language !== 'en') return;
    for (const record of records) {
      if (record.type === 'characterData') translateTextNode(record.target);
      if (record.type === 'attributes') translateElement(record.target);
      for (const node of record.addedNodes || []) apply(node);
    }
  });
  observer.observe(document.body, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
    attributeFilter: ['title', 'aria-label', 'placeholder']
  });

  RP4.i18n = { apply, setLanguage, translate, get language() { return language; } };
}(window.RP4));
