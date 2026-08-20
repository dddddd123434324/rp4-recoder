# Third-party notices

RP4 Recorder itself is licensed under the MIT License. The application is distributed
with separate third-party components under their own licenses.

## FFmpeg and ffmpeg-static

RP4 Recorder bundles `ffmpeg-static` 5.3.0 and the Windows x64 FFmpeg executable
distributed by that package. RP4 launches FFmpeg as a separate process for local media
conversion, validation, thumbnail generation, and lossless AVI finalization.

- `ffmpeg-static` is licensed under GPL-3.0-or-later.
- The bundled executable is FFmpeg 6.1.1, Gyan Doshi's essentials build, configured with
  `--enable-gpl --enable-version3` and licensed under GPL version 3.
- The exact version, build configuration, upstream README, license, and corresponding-source
  information are included in the `legal` directory.

Upstream projects:

- https://github.com/eugeneware/ffmpeg-static/tree/b6.1.1
- https://github.com/FFmpeg/FFmpeg/commit/e38092ef93
- https://www.gyan.dev/ffmpeg/builds/
- https://ffmpeg.org/legal.html

## PyeojinGothic

The user interface bundles PyeojinGothic webfonts. PyeojinGothic and its upstream font
components are distributed under the SIL Open Font License 1.1. The complete copyright
notice and license are included at `legal/PyeojinGothic-OFL-1.1.txt` and beside the font
files at `src/fonts/LICENSE-PyeojinGothic.txt`.

- https://github.com/Jihwan-Suh/PyeojinGothic
