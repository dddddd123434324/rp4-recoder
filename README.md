# RP4 Recorder

Windows용 게임/화면 녹화 프로그램입니다. 화면 전체 녹화, 모니터 지정 녹화, 창 지정 녹화, 영역 녹화, 스크린샷, 녹화 프리셋, 단축키, 클립 녹화 모드를 제공합니다.

Electron의 데스크톱 캡처 API와 FFmpeg 변환 파이프라인으로 구성되어 있습니다. OBS 소스는 장기적인 캡처 백엔드와 인코더 구조를 참고하기 위한 자료로만 두었고, 이 저장소에는 OBS 코드를 포함하지 않습니다.

## 주요 기능

- 전체 화면, 특정 모니터, 창, 사용자 지정 영역 녹화
- MP4 또는 WebM 저장
- 저용량, 일반, 고화질, 게임 녹화 프리셋
- 해상도, FPS, 비트레이트, 오디오 설정
- 마이크/시스템 오디오 녹음 설정
- 스크린샷 저장
- 녹화 시작/중지, 일시정지, 스크린샷, 클립 녹화 단축키
- 클립 녹화 모드
- 저장 폴더 열기

## 개발 실행

```powershell
npm.cmd install
npm.cmd start
```

PowerShell 실행 환경에서는 `npm` 대신 `npm.cmd`를 쓰면 명령 해석 문제가 적습니다.

## 빌드

```powershell
npm.cmd run dist
```

빌드 결과는 `dist/`에 생성됩니다.

- 설치형 EXE: `dist/RP4 Recorder Setup <version>.exe`
- 포터블 EXE: `dist/RP4-Recorder-Portable-<version>.exe`

`icon.ico`가 앱과 EXE 아이콘으로 사용됩니다. Windows 코드 서명 인증서는 포함되어 있지 않으므로 배포 시 SmartScreen 경고가 뜰 수 있습니다.

## 기본 저장 위치

현재 앱은 Windows에서 다음 경로를 기본 저장 위치로 사용합니다.

- 녹화 파일: `D:\RP4\recordings`
- 스크린샷: `D:\RP4\recordings\screenshots`
- 설정 파일: `D:\RP4\config\rp4-recorder-settings.json`

MP4 저장은 FFmpeg 변환을 거친 H.264/AAC 파일입니다. MP4 변환이 실패하면 녹화 데이터가 사라지지 않도록 `_fallback.webm` 원본을 남깁니다. 별도 `.json` 메타 파일은 저장하지 않습니다.

## 라이선스

MIT License로 배포합니다.
