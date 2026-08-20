# FFmpeg corresponding source information

RP4 Recorder bundles the Windows x64 executable installed by
`ffmpeg-static` 5.3.0 (`ffmpeg-static` binary release `b6.1.1`). The executable
identifies itself as `FFmpeg 6.1.1-essentials_build-www.gyan.dev` and is licensed
under GPL version 3.

## Exact upstream references

- Bundled binary release: https://github.com/eugeneware/ffmpeg-static/releases/tag/b6.1.1
- `ffmpeg-static` package source: https://github.com/eugeneware/ffmpeg-static/tree/b6.1.1
- FFmpeg source revision: https://github.com/FFmpeg/FFmpeg/commit/e38092ef93
- FFmpeg source archive: https://github.com/FFmpeg/FFmpeg/archive/e38092ef93.tar.gz
- Windows binary supplier and build information: https://www.gyan.dev/ffmpeg/builds/

The bundled `FFMPEG-UPSTREAM-README.txt` records the versions of the statically
linked external libraries. `FFMPEG_VERSION.txt` and `FFMPEG_BUILDCONF.txt` are
generated directly from the executable by `npm run legal:update`.

RP4 does not modify the bundled FFmpeg executable. For help locating the source
of a component listed in the upstream README, open an issue at
https://github.com/dddddd123434324/rp4-recoder/issues.

RP4 Recorder source for each distributed version is available from the matching
tag at https://github.com/dddddd123434324/rp4-recoder/tags.
