# RP4 Recorder

[한국어](#한국어) · [English](#english)

## 한국어

Windows용 화면 녹화 프로그램입니다. H.264 영상을 MP4로 바로 기록해 녹화 중지 후 저장합니다.

### 주요 기능

- 전체 화면, 특정 모니터, 실행 중인 창, 사용자 지정 영역 녹화
- 최소화된 창을 목록에 표시하고 선택 시 자동 복원
- MP4(H.264/AAC) 및 WebM(VP9/Opus) 저장
- 녹화 일시정지·재개, 마이크·시스템 오디오 조절
- 녹화 설정, 사용자 프리셋, 전역 단축키
- 원본 해상도 스크린샷과 별도 이미지 설정
- 최근 장면을 되돌려 저장하는 클립 녹화
- 최근 파일 썸네일, 재생, 위치 열기, 삭제
- 한국어·영어 UI 및 다국어 설치 프로그램
- 저장 경로 지정, 비정상 종료 복구, 저장 파일 검증

### 다운로드

[GitHub Releases](https://github.com/dddddd123434324/rp4-recoder/releases/latest)에서 설치판 또는 포터블 버전을 받을 수 있습니다.

Windows 코드 서명 인증서는 포함되어 있지 않습니다.

## English

RP4 Recorder is a Windows screen recorder. It writes H.264 video directly to MP4 for fast finalization when recording stops.

### Features

- Record the full screen, a monitor, any running window, or a custom area
- Show minimized windows in the picker and restore them when selected
- Save as MP4 (H.264/AAC) or WebM (VP9/Opus)
- Pause and resume recording with microphone and system-audio controls
- Recording settings, custom presets, and global shortcuts
- Full-resolution screenshots with independent image settings
- Replay-style Clip Mode for saving recent footage
- Recent-file thumbnails, playback, reveal, and delete actions
- Korean and English UI with a multilingual installer
- Custom save folders, crash recovery, and saved-file validation

### Download

Download the installer or portable build from [GitHub Releases](https://github.com/dddddd123434324/rp4-recoder/releases/latest).

The Windows binaries are currently unsigned.

## Development

```powershell
npm.cmd install
npm.cmd start
npm.cmd test
npm.cmd run dist
```

Build output is created in `dist/`. Tests use an isolated temporary profile and do not access the user's settings or recordings.

## Default paths

- Recordings: `%USERPROFILE%\Videos\RP4 Recorder`
- Screenshots: `screenshots` inside the recordings folder
- Settings: `%APPDATA%\RP4 Recorder\rp4-recorder-settings.json`

## License

MIT License
