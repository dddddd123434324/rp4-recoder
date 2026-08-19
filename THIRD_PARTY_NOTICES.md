# Third-party notices

RP4 Recorder bundles `ffmpeg-static` 5.3.0 and its FFmpeg executable for media
conversion, validation, thumbnail generation, and lossless AVI finalization.

- `ffmpeg-static` is licensed under GPL-3.0-or-later.
- The bundled Windows executable ships with its upstream `ffmpeg.exe.LICENSE` and
  `ffmpeg.exe.README` files beside the executable in the unpacked application resources.
- FFmpeg licensing depends on the configuration of the bundled binary. Before redistributing
  a modified binary, inspect `ffmpeg -buildconf` and comply with the licenses reported there.

Upstream projects:

- https://github.com/eugeneware/ffmpeg-static
- https://ffmpeg.org/legal.html
