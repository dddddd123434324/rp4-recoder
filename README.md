# RP4 Recorder

Windows용 화면·게임 녹화 프로그램입니다. H.264 영상을 MP4로 바로 기록해 녹화 중지 후 저장합니다.

## 주요 기능

- 전체 화면, 특정 모니터, 창, 사용자 지정 영역 녹화
- MP4(H.264/AAC) 및 WebM(VP9/Opus) 저장
- 녹화 일시정지·재개 및 마이크·시스템 오디오 조절
- 해상도, FPS, 비트레이트를 포함한 녹화 설정과 사용자 프리셋
- 원본 해상도 스크린샷과 별도 이미지 형식·품질 설정
- 최근 장면을 되돌려 저장하는 클립 녹화
- 녹화, 일시정지, 스크린샷, 클립 기능 전역 단축키
- 최근 파일 썸네일, 재생, 위치 열기, 삭제
- 저장 경로 지정, 비정상 종료 파일 복구, 저장 파일 검증

## 다운로드

[GitHub Releases](https://github.com/dddddd123434324/rp4-recoder/releases/latest)에서 설치판 또는 포터블 버전을 받을 수 있습니다.

- `RP4.Recorder.Setup.<version>.exe`: 설치판
- `RP4-Recorder-Portable-<version>.exe`: 포터블 버전

Windows 코드 서명 인증서는 포함되어 있지 않아 SmartScreen 경고가 표시될 수 있습니다.

## 개발 실행

```powershell
npm.cmd install
npm.cmd start
```

## 검사 및 빌드

```powershell
npm.cmd test
npm.cmd run dist
```

빌드 결과는 `dist/`에 생성됩니다. 테스트는 별도 임시 폴더에서 실행되며 실제 설정과 녹화 파일을 사용하지 않습니다.

## 기본 저장 위치

- 녹화 파일: `%USERPROFILE%\Videos\RP4 Recorder`
- 스크린샷: 녹화 폴더 아래 `screenshots`
- 설정 파일: `%APPDATA%\RP4 Recorder\rp4-recorder-settings.json`

녹화 폴더는 앱의 `경로 지정` 버튼에서 변경할 수 있습니다.

## 라이선스

MIT License
