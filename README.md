# RP4 Recorder

Windows용 게임/화면 녹화 프로그램입니다. 화면 전체 녹화, 모니터 지정 녹화, 창 지정 녹화, 영역 녹화, 스크린샷, 녹화 프리셋, 단축키, 클립 녹화 모드를 제공합니다.

Electron의 데스크톱 캡처 API를 사용하며, H.264 영상을 MP4 컨테이너에 **직접 기록**합니다. OBS 소스는 캡처 백엔드와 인코더 구조를 참고하기 위한 자료로만 두었고, 이 저장소에는 OBS 코드를 포함하지 않습니다.

## 주요 기능

- 전체 화면, 특정 모니터, 창, 사용자 지정 영역 녹화
- MP4(H.264/AAC) 또는 WebM(VP9/Opus) 저장
- 저용량, 일반, 고화질, 게임 녹화 프리셋
- 현재 녹화 설정 기반 사용자 프리셋 생성, 수정, 삭제
- 해상도, FPS, 비트레이트, 오디오 설정
- 마이크/시스템 오디오 녹음 설정 (녹화 중 볼륨 실시간 조절)
- 원본 해상도 스크린샷 저장
- 녹화 시작/중지, 일시정지, 스크린샷, 클립 녹화 단축키
- 최근 장면을 되돌려 저장하는 클립 녹화 모드
- 최근 녹화 파일 목록 및 저장 폴더 열기
- 녹화 파일 저장 경로 지정 및 유지

## 저장 속도

**중지를 누르면 기다리지 않고 바로 저장됩니다.**

이전 버전은 VP8/WebM으로 녹화한 뒤 저장 시점에 `libx264`로 MP4를 다시 인코딩했기 때문에, 10분짜리 녹화를 저장하는 데 수 분이 걸렸습니다.

현재는 `MediaRecorder`가 처리하는 H.264 스트림을 MP4 컨테이너로 그대로 디스크에 흘려보냅니다. 중지 시 하는 일은 파일 핸들을 닫고 이름을 바꾸는 것뿐입니다.

| 작업 | 소요 시간 |
| --- | --- |
| 중지 후 저장 (일반 녹화) | 약 2~3 ms |
| 클립 저장 | 직접 H.264는 수 초 이내, 호환성 변환 시 영상 길이에 따라 증가 |
| 예전 방식(libx264 재인코딩) | 4초 영상당 약 1,060 ms |

측정값은 `npm.cmd run test:integration`으로 재현할 수 있습니다.

영상 인코딩은 Chromium이 GPU 하드웨어 H.264 인코더를 사용하므로, 일반적인 녹화 경로에서는 `libx264`가 전혀 실행되지 않습니다. FFmpeg은 다음 경우에만 사용됩니다.

- **클립 저장**: 클릭 시점까지의 최근 구간을 추출. H.264는 영상 스트림을 복사하고, 비호환 코덱은 MP4로 재인코딩
- **MP4 최적화**: 저장이 끝난 *뒤* 백그라운드에서 `moov` 위치를 정리 (설정에서 끌 수 있으며, 저장을 지연시키지 않음)
- **호환성 대비**: H.264 직접 기록을 지원하지 않는 환경에서만 재인코딩

## 클립 녹화 모드

짧은 완결 MediaRecorder epoch를 순환 보관하고, 저장할 때 필요한 최근 epoch만 FFmpeg로 결합한 뒤 클릭 시점 이전 구간을 추출합니다. 개별 dataavailable Blob을 독립 미디어 파일로 가정하지 않습니다. H.264는 영상 스트림을 복사하고, VP8/VP9 같은 비호환 코덱은 MP4로 재인코딩합니다. 시간·메모리 상한을 함께 적용하며 전송 중인 snapshot도 총 메모리 계산에 포함합니다.

클립 길이는 저장할 최근 구간의 목표값이고, 메모리 용량(기본 256MB, 최대 512MB)은 실제 확보 가능한 길이의 상한입니다. 화면에는 `현재 확보 길이 / 목표 길이`가 표시되며, 용량 한도로 버퍼가 회전하면 목표 길이보다 짧아질 수 있습니다. 저장 시에는 클릭 순간 고정한 스냅샷만 메인 프로세스로 순차 전송해 저장 중 새 장면이 섞이거나 하나의 대형 IPC 복사본이 생기지 않게 합니다.

## 개발 실행

```powershell
npm.cmd install
npm.cmd start
```

PowerShell 실행 환경에서는 `npm` 대신 `npm.cmd`를 쓰면 명령 해석 문제가 적습니다.

## 검사

```powershell
npm.cmd run lint              # ESLint
npm.cmd run lint:syntax       # src/, scripts/ 전체 구문 검사
npm.cmd run smoke             # 실제 시작 경로 검증 후 종료 코드 반환
npm.cmd run test:integration  # 녹화 파이프라인 종단 회귀 검증
npm.cmd test                  # 위 항목 일괄 실행
```

`test:integration`은 임시 폴더를 별도의 `userData`로 사용하므로 실제 설정과 녹화 파일에는 영향을 주지 않습니다. 저장 즉시성, 파일 유효성, 이름 충돌 방지, 임시 파일 복구, 권한 검사 등을 확인합니다.

## 빌드

```powershell
npm.cmd run dist
```

빌드 결과는 `dist/`에 생성됩니다.

- 설치형 EXE: `dist/RP4 Recorder Setup <version>.exe`
- 포터블 EXE: `dist/RP4-Recorder-Portable-<version>.exe`

`icon.ico`가 앱과 EXE 아이콘으로 사용됩니다. Windows 코드 서명 인증서는 포함되어 있지 않으므로 배포 시 SmartScreen 경고가 뜰 수 있습니다.

## 저장 위치

경로는 Windows 표준 위치를 사용합니다.

- 설정 파일: `%APPDATA%\RP4 Recorder\rp4-recorder-settings.json`
- 녹화 파일: `%USERPROFILE%\Videos\RP4 Recorder`
- 스크린샷: 녹화 폴더 아래 `screenshots`
- 작업 중 임시 파일: 녹화 폴더 아래 `.rp4-recorder-temp`

앱의 `경로 지정` 버튼으로 녹화 폴더를 바꿀 수 있고 이후 실행에서도 유지됩니다. 선택한 폴더에 실제로 쓸 수 있는지 확인한 뒤 적용합니다.

이전 버전이 사용하던 `D:\RP4` 경로는 자동으로 이전됩니다. 기존 설정 파일이 있으면 새 위치로 복사하고, `D:\RP4\recordings` 폴더가 남아 있으면 계속 그 폴더를 사용합니다. 설정된 폴더를 쓸 수 없는 경우에는 사용 가능한 기본 폴더로 내려가며 그 사실을 알립니다.

비정상 종료로 `.rp4-recorder-temp`에 남은 RP4 소유 녹화는 다음 실행에서 녹화 폴더로 복구합니다. 녹화 중 창을 닫으면 먼저 확인을 거친 뒤 파일을 정상적으로 마무리합니다.

## 구조

```
src/
  main.js              앱 수명 주기, 종료 처리
  main/
    paths.js           경로 확인, 레거시 이전, 쓰기 가능 검사
    settings.js        설정 정규화 및 원자적 저장
    recording.js       세션, 파일 마무리, 인덱스, 임시 파일 정리
    ffmpeg.js          FFmpeg 실행, 진행률, 취소
    displays.js        디스플레이 정보, 영역 좌표 변환
    window-crop.js     창 클라이언트 영역 조회 (상주 헬퍼)
    hotkeys.js         전역 단축키 등록
    windows.js         창 생성, 보안 설정, 영역 선택 창
    ipc.js             IPC 핸들러
  preload.js           메인 창 브리지
  preload-area.js      영역 선택 창 브리지
  renderer/            렌더러 모듈 (core, modal, capture, profile,
                       recorder, clips, hotkeys, files, app)
```

## 라이선스

MIT License로 배포합니다.
