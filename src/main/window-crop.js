'use strict';

const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const readline = require('node:readline');

const paths = require('./paths');

/*
 * Window capture includes the DWM frame and drop shadow, so the client rectangle has to
 * be queried from Win32 in order to crop it away.
 *
 * The previous implementation spawned powershell.exe and recompiled a C# type on *every*
 * call - which meant every preview restart (including changing the bitrate dropdown) paid
 * a multi-second cost against an 8s timeout, and the result was cached for the lifetime of
 * the stream so moving the captured window left the crop stale.
 *
 * This version keeps one PowerShell host alive, compiles the helper once, and answers
 * subsequent queries over stdin/stdout in well under a millisecond. That makes it cheap
 * enough to re-poll continuously while recording.
 */

const READY_TOKEN = 'RP4:READY';
const RESPONSE_PREFIX = 'RP4:';
const READY_TIMEOUT_MS = 20000;
const REQUEST_TIMEOUT_MS = 4000;

const HOST_SCRIPT = `
$ErrorActionPreference = 'Stop'
$OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$code = @'
using System;
using System.Collections.Generic;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Text;

public static class Rp4WindowCrop
{
    public sealed class WindowInfo
    {
        public string hwnd;
        public string title;
        public uint processId;
        public bool minimized;
    }

    private delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }

    [StructLayout(LayoutKind.Sequential)]
    public struct POINT { public int X; public int Y; }

    [DllImport("user32.dll")] private static extern bool IsWindow(IntPtr hWnd);
    [DllImport("user32.dll")] private static extern bool IsIconic(IntPtr hWnd);
    [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")] private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
    [DllImport("user32.dll")] private static extern int GetWindowTextLength(IntPtr hWnd);
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
    [DllImport("user32.dll")] private static extern bool ShowWindowAsync(IntPtr hWnd, int command);
    [DllImport("user32.dll")] private static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] private static extern bool GetClientRect(IntPtr hWnd, out RECT lpRect);
    [DllImport("user32.dll")] private static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
    [DllImport("user32.dll")] private static extern bool ClientToScreen(IntPtr hWnd, ref POINT lpPoint);
    [DllImport("dwmapi.dll")] private static extern int DwmGetWindowAttribute(IntPtr hwnd, int dwAttribute, out RECT pvAttribute, int cbAttribute);
    [DllImport("user32.dll")] private static extern bool SetProcessDpiAwarenessContext(IntPtr dpiContext);

    private const int DWMWA_EXTENDED_FRAME_BOUNDS = 9;
    private const int SW_RESTORE = 9;

    public static void Init()
    {
        // Per-monitor-v2 so the coordinates we read are not DPI virtualized.
        try { SetProcessDpiAwarenessContext(new IntPtr(-4)); } catch { }
    }

    private static string Escape(int value)
    {
        return value.ToString(CultureInfo.InvariantCulture);
    }

    public static WindowInfo[] ListWindows()
    {
        List<WindowInfo> result = new List<WindowInfo>();
        EnumWindows(delegate(IntPtr hWnd, IntPtr unused)
        {
            try
            {
                if (!IsWindowVisible(hWnd)) return true;
                int length = GetWindowTextLength(hWnd);
                if (length <= 0 || length > 32768) return true;
                StringBuilder title = new StringBuilder(length + 1);
                if (GetWindowText(hWnd, title, title.Capacity) <= 0) return true;
                uint processId;
                GetWindowThreadProcessId(hWnd, out processId);
                result.Add(new WindowInfo {
                    hwnd = hWnd.ToInt64().ToString(CultureInfo.InvariantCulture),
                    title = title.ToString(),
                    processId = processId,
                    minimized = IsIconic(hWnd)
                });
            }
            catch { }
            return true;
        }, IntPtr.Zero);
        return result.ToArray();
    }

    public static bool Restore(long hwndValue)
    {
        try
        {
            IntPtr hWnd = new IntPtr(hwndValue);
            if (!IsWindow(hWnd)) return false;
            if (IsIconic(hWnd)) ShowWindowAsync(hWnd, SW_RESTORE);
            SetForegroundWindow(hWnd);
            return true;
        }
        catch { return false; }
    }

    public static string Query(string id, long hwndValue)
    {
        try
        {
            IntPtr hWnd = new IntPtr(hwndValue);
            if (!IsWindow(hWnd) || IsIconic(hWnd)) return "RP4:" + id + ":null";

            RECT frame;
            int hr = DwmGetWindowAttribute(hWnd, DWMWA_EXTENDED_FRAME_BOUNDS, out frame, Marshal.SizeOf(typeof(RECT)));
            if (hr != 0 && !GetWindowRect(hWnd, out frame)) return "RP4:" + id + ":null";

            RECT client;
            if (!GetClientRect(hWnd, out client)) return "RP4:" + id + ":null";

            POINT topLeft = new POINT(); topLeft.X = client.Left; topLeft.Y = client.Top;
            POINT bottomRight = new POINT(); bottomRight.X = client.Right; bottomRight.Y = client.Bottom;
            if (!ClientToScreen(hWnd, ref topLeft) || !ClientToScreen(hWnd, ref bottomRight))
            {
                return "RP4:" + id + ":null";
            }

            int frameWidth = Math.Max(1, frame.Right - frame.Left);
            int frameHeight = Math.Max(1, frame.Bottom - frame.Top);
            int x = Math.Max(0, topLeft.X - frame.Left);
            int y = Math.Max(0, topLeft.Y - frame.Top);
            int width = Math.Max(1, bottomRight.X - topLeft.X);
            int height = Math.Max(1, bottomRight.Y - topLeft.Y);

            if (x + width > frameWidth) width = Math.Max(1, frameWidth - x);
            if (y + height > frameHeight) height = Math.Max(1, frameHeight - y);

            return "RP4:" + id + ":{\\"x\\":" + Escape(x)
                + ",\\"y\\":" + Escape(y)
                + ",\\"width\\":" + Escape(width)
                + ",\\"height\\":" + Escape(height)
                + ",\\"frameWidth\\":" + Escape(frameWidth)
                + ",\\"frameHeight\\":" + Escape(frameHeight) + "}";
        }
        catch
        {
            return "RP4:" + id + ":null";
        }
    }
}
'@

Add-Type -TypeDefinition $code
[Rp4WindowCrop]::Init()
[Console]::Out.WriteLine('${READY_TOKEN}')
[Console]::Out.Flush()

while ($true) {
    $line = [Console]::In.ReadLine()
    if ($null -eq $line) { break }
    $line = $line.Trim()
    if ($line.Length -eq 0) { continue }
    if ($line -eq 'quit') { break }

    $parts = $line.Split(' ')
    if ($parts.Length -lt 2) { continue }
    try {
        if ($parts[1] -eq 'list') {
            $json = ConvertTo-Json -InputObject @([Rp4WindowCrop]::ListWindows()) -Compress
            [Console]::Out.WriteLine('RP4:' + $parts[0] + ':' + $json)
        } elseif ($parts[1] -eq 'restore' -and $parts.Length -ge 3) {
            $restored = [Rp4WindowCrop]::Restore([int64]$parts[2])
            [Console]::Out.WriteLine('RP4:' + $parts[0] + ':' + $(if ($restored) { 'true' } else { 'false' }))
        } else {
            [Console]::Out.WriteLine([Rp4WindowCrop]::Query($parts[0], [int64]$parts[1]))
        }
    } catch {
        [Console]::Out.WriteLine('RP4:' + $parts[0] + ':null')
    }
    [Console]::Out.Flush()
}
`;
const HOST_SCRIPT_HASH = crypto.createHash('sha256').update(HOST_SCRIPT, 'utf8').digest('hex');
const POWERSHELL_PATH = path.join(
  process.env.SystemRoot || 'C:\\Windows',
  'System32',
  'WindowsPowerShell',
  'v1.0',
  'powershell.exe'
);

class WindowCropService {
  constructor() {
    this.child = null;
    this.ready = null;
    this.pending = new Map();
    this.nextId = 1;
    this.generation = 0;
    this.disposed = false;
    this.unsupported = process.platform !== 'win32';
  }

  async hostScriptPath() {
    const target = path.join(paths.configDir(), `rp4-window-crop-host-${crypto.randomUUID()}.ps1`);
    await fs.mkdir(path.dirname(target), { recursive: true });
    const handle = await fs.open(target, 'wx');
    try {
      await handle.writeFile(HOST_SCRIPT, 'utf8');
    } finally {
      await handle.close();
    }
    return target;
  }

  terminateHost(child, generation) {
    if (this.child === child && this.generation === generation) {
      this.child = null;
      this.ready = null;
      this.generation += 1;
    }
    for (const [id, entry] of this.pending) {
      if (entry.child !== child) continue;
      clearTimeout(entry.timer);
      entry.resolve(null);
      this.pending.delete(id);
    }
    if (child && !child.killed) child.kill();
  }

  async ensureHost() {
    if (this.unsupported || this.disposed) return null;
    if (this.ready) return this.ready;

    const generation = ++this.generation;
    const ready = (async () => {
      const scriptPath = await this.hostScriptPath();
      const actualHash = crypto.createHash('sha256')
        .update(await fs.readFile(scriptPath))
        .digest('hex');
      if (actualHash !== HOST_SCRIPT_HASH) {
        await fs.rm(scriptPath, { force: true });
        throw new Error('window crop host script verification failed');
      }
      let child;
      try {
        child = spawn(POWERSHELL_PATH, [
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy', 'Bypass',
          '-File', scriptPath
        ], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      } catch (error) {
        await fs.rm(scriptPath, { force: true }).catch(() => {});
        throw error;
      }

      if (this.disposed || generation !== this.generation) {
        child.kill();
        await fs.rm(scriptPath, { force: true }).catch(() => {});
        return null;
      }
      this.child = child;
      child.stderr.resume();

      // Pipe failures are emitted asynchronously when PowerShell exits between the
      // writable check and write(). Without a listener, Node treats EPIPE as an
      // uncaught error and can terminate the Electron main process.
      child.stdin.on('error', () => {
        this.terminateHost(child, generation);
      });

      const rl = readline.createInterface({ input: child.stdout });
      let readySettled = false;
      let cleaned = false;
      let resolveReady;
      let rejectReady;
      const readySignal = new Promise((resolve, reject) => {
        resolveReady = resolve;
        rejectReady = reject;
      });
      const cleanup = () => {
        if (cleaned) return;
        cleaned = true;
        rl.close();
        if (!readySettled) {
          readySettled = true;
          rejectReady(new Error('window crop host exited'));
        }
        if (this.child === child && this.generation === generation) {
          this.child = null;
          this.ready = null;
        }
        for (const [id, entry] of this.pending) {
          if (entry.child !== child || entry.generation !== generation) continue;
          clearTimeout(entry.timer);
          entry.resolve(null);
          this.pending.delete(id);
        }
        void fs.rm(scriptPath, { force: true }).catch(() => {});
      };
      rl.on('line', (value) => {
        const line = value.trim();
        if (line === READY_TOKEN) {
          if (!readySettled && this.child === child && this.generation === generation) {
            readySettled = true;
            resolveReady();
          }
          return;
        }
        this.handleLine(child, generation, line);
      });
      child.once('error', cleanup);
      child.once('exit', cleanup);

      const timer = setTimeout(() => {
        if (!readySettled) {
          readySettled = true;
          rejectReady(new Error('window crop host timed out'));
        }
        if (!child.killed) child.kill();
        cleanup();
      }, READY_TIMEOUT_MS);

      try {
        await readySignal;
      } finally {
        clearTimeout(timer);
      }

      // PowerShell has already loaded the script; remove the writable file immediately.
      await fs.rm(scriptPath, { force: true }).catch(() => {});

      if (this.child !== child || this.generation !== generation || this.disposed) {
        if (!child.killed) child.kill();
        cleanup();
        return null;
      }

      return child;
    })().catch(() => {
      if (this.generation === generation) {
        this.ready = null;
      }
      return null;
    });

    this.ready = ready;
    return ready;
  }

  handleLine(child, generation, line) {
    if (this.child !== child || this.generation !== generation) return;
    if (!line.startsWith(RESPONSE_PREFIX)) return;

    const rest = line.slice(RESPONSE_PREFIX.length);
    const separator = rest.indexOf(':');
    if (separator < 0) return;

    const id = rest.slice(0, separator);
    const body = rest.slice(separator + 1);
    const entry = this.pending.get(id);
    if (!entry) return;

    this.pending.delete(id);
    clearTimeout(entry.timer);

    if (body === 'null') {
      entry.resolve(null);
      return;
    }
    try {
      entry.resolve(JSON.parse(body));
    } catch {
      entry.resolve(null);
    }
  }

  /**
   * Returns the client rectangle of a window relative to its captured frame, or null when
   * it cannot be determined (minimized, closed, non-Windows, helper unavailable).
   */
  async query(hwnd) {
    if (this.unsupported || this.disposed) return null;
    const numeric = String(hwnd || '').trim();
    if (!/^\d+$/.test(numeric)) return null;

    return this.request(numeric);
  }

  async listWindows() {
    const result = await this.request('list');
    if (!Array.isArray(result)) return [];
    return result.filter((entry) => (
      entry && /^\d+$/.test(String(entry.hwnd || ''))
        && typeof entry.title === 'string' && entry.title.trim()
    )).slice(0, 512);
  }

  async restore(hwnd) {
    const numeric = String(hwnd || '').trim();
    if (!/^\d+$/.test(numeric)) return false;
    return (await this.request(`restore ${numeric}`)) === true;
  }

  async request(command) {
    if (this.unsupported || this.disposed) return null;
    const child = await this.ensureHost();
    if (!child || !child.stdin.writable) return null;
    const generation = this.generation;

    const id = `q${this.nextId++}`;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve(null);
        this.terminateHost(child, generation);
      }, REQUEST_TIMEOUT_MS);

      this.pending.set(id, { resolve, timer, child, generation });
      try {
        child.stdin.write(`${id} ${command}\n`, (error) => {
          if (!error) return;
          const entry = this.pending.get(id);
          if (entry) {
            this.pending.delete(id);
            clearTimeout(entry.timer);
            entry.resolve(null);
          }
          this.terminateHost(child, generation);
        });
      } catch {
        this.pending.delete(id);
        clearTimeout(timer);
        resolve(null);
        this.terminateHost(child, generation);
      }
    });
  }

  async dispose() {
    this.disposed = true;
    this.generation += 1;
    const child = this.child;
    this.child = null;
    this.ready = null;
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.resolve(null);
    }
    this.pending.clear();
    if (!child) return;
    const exited = new Promise((resolve) => {
      if (child.exitCode != null || child.signalCode != null) resolve(true);
      else child.once('exit', () => resolve(true));
    });
    try {
      child.stdin.write('quit\n');
      child.stdin.end();
    } catch {
      // ignore
    }
    const graceful = await Promise.race([
      exited,
      new Promise((resolve) => setTimeout(() => resolve(false), 500))
    ]);
    if (!graceful && !child.killed) {
      child.kill();
      await Promise.race([
        exited,
        new Promise((resolve) => setTimeout(resolve, 500))
      ]);
    }
  }
}

function parseWindowHandle(sourceId) {
  const match = /^window:(\d+):/.exec(String(sourceId || ''));
  return match ? match[1] : null;
}

module.exports = { WindowCropService, parseWindowHandle };
