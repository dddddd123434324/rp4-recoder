# Microsoft Store submission notes

## Product identity

- Product name: RP4 Recorder
- Store ID: `9PHTX1234TFZ`
- Package identity name: `REAN.RP4Recorder`
- Publisher: `CN=577818EC-6A79-4ADE-BF63-73675DD6E6F2`
- Publisher display name: `REAN`

## Certification notes

RP4 Recorder is a local-only open-source desktop screen recorder.

Test procedure:

1. Launch RP4 Recorder.
2. Select Full Screen.
3. Click the circular record button.
4. Record for approximately 10 seconds.
5. Click the record button again to stop.
6. Verify that an MP4 file appears in the user's `Videos\RP4 Recorder` folder.

The app uses the `runFullTrust` capability to run the Electron desktop process,
register user-configurable global hotkeys, launch the bundled FFmpeg executable for
local media processing, access user-selected recording folders, and query Win32 window
bounds for window capture.

The application uses a fixed, locally generated PowerShell/C# helper solely to query
Win32 window bounds for window capture. The helper is generated from code embedded in
the application, its SHA-256 is verified before execution, and the temporary script is
removed after the helper starts. It does not download or execute remote code and does not
install drivers or Windows services.

The app does not require an account, contain advertising or analytics, upload recordings
or screenshots, download executable code, or install drivers or Windows services. All
recordings, screenshots, settings, and temporary recovery data remain on the user's device.

Windows App Certification Kit 10.0.26100.7705 reported an overall `PASS` for the
0.4.0.0 x64 AppX package on 2026-08-20. Its optional blocked-executable analysis detected
normal process-launching references in Electron and FFmpeg and the literal PowerShell helper
path described above. All required package, manifest, branding, security, architecture, and
DPI tests passed.

## Public links

- Source: https://github.com/dddddd123434324/rp4-recoder
- Privacy policy: https://github.com/dddddd123434324/rp4-recoder/blob/main/legal/PRIVACY.md
- Support: https://github.com/dddddd123434324/rp4-recoder/issues
