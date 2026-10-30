# GameShelf's OCR and window helper for the Arabic subtitle overlay.
#
# Started once by the app (desktop/localization/ocr.js) and kept running. It
# reads one request per line on stdin, "<id>\t<op>\t<argument>", and writes one
# JSON reply per line on stdout:
#   ping                       -> {"id":1,"pong":true}
#   ocr     <base64 BMP image> -> {"id":2,"lines":[{"text":"...","box":{x,y,w,h}}],"ms":31}
#   window  <pid,pid,...>      -> {"id":3,"window":{"hwnd":"...","x":0,"y":0,"w":1920,"h":1080,"minimized":false}}
# The first line it writes says whether OCR is available.
#
# OCR is Windows' own (Windows.Media.Ocr, Windows 10 and 11), so the screen
# never leaves the computer.

$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding $false
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false

Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.Foundation.IAsyncOperation`1, Windows.Foundation, ContentType = WindowsRuntime]
$null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
$null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Foundation, ContentType = WindowsRuntime]
$null = [Windows.Graphics.Imaging.SoftwareBitmap, Windows.Foundation, ContentType = WindowsRuntime]
$null = [Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime]
$null = [Windows.Storage.Streams.IRandomAccessStream, Windows.Storage.Streams, ContentType = WindowsRuntime]
$null = [Windows.Globalization.Language, Windows.Foundation, ContentType = WindowsRuntime]

# Waits for a WinRT IAsyncOperation<T> and returns its result.
$getAwaiter = [System.WindowsRuntimeSystemExtensions].GetMember('GetAwaiter') |
  Where-Object { $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' } |
  Select-Object -First 1
function Await($operation, [Type]$resultType) {
  $getAwaiter.MakeGenericMethod($resultType).Invoke($null, @($operation)).GetResult()
}

Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;

public static class GameShelfWindows {
  [StructLayout(LayoutKind.Sequential)]
  public struct RECT { public int Left, Top, Right, Bottom; }
  private delegate bool EnumProc(IntPtr hwnd, IntPtr lParam);
  [DllImport("user32.dll")] private static extern bool EnumWindows(EnumProc proc, IntPtr lParam);
  [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
  [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll")] private static extern bool IsIconic(IntPtr hwnd);
  [DllImport("user32.dll")] private static extern IntPtr GetWindow(IntPtr hwnd, uint cmd);
  [DllImport("user32.dll")] private static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);
  [DllImport("dwmapi.dll")] private static extern int DwmGetWindowAttribute(IntPtr hwnd, int attribute, out RECT rect, int size);
  [DllImport("user32.dll")] private static extern bool SetProcessDpiAwarenessContext(IntPtr value);

  // Window positions in real screen pixels, whatever the display scaling.
  public static void UseScreenPixels() {
    try { SetProcessDpiAwarenessContext(new IntPtr(-4)); } catch (Exception) { }
  }

  // The biggest visible top-level window of these processes:
  // "hwnd|x|y|width|height|minimized", or null.
  public static string Find(uint[] pids) {
    HashSet<uint> wanted = new HashSet<uint>(pids);
    IntPtr best = IntPtr.Zero;
    long bestArea = 0;
    RECT bestRect = new RECT();
    EnumWindows(delegate (IntPtr hwnd, IntPtr lParam) {
      uint pid;
      GetWindowThreadProcessId(hwnd, out pid);
      if (!wanted.Contains(pid) || !IsWindowVisible(hwnd) || GetWindow(hwnd, 4) != IntPtr.Zero) return true;
      RECT rect;
      // The window as drawn, without the invisible resize borders.
      if (DwmGetWindowAttribute(hwnd, 9, out rect, Marshal.SizeOf(typeof(RECT))) != 0) GetWindowRect(hwnd, out rect);
      long area = (long)(rect.Right - rect.Left) * (rect.Bottom - rect.Top);
      if (area > bestArea) { best = hwnd; bestArea = area; bestRect = rect; }
      return true;
    }, IntPtr.Zero);
    if (best == IntPtr.Zero) return null;
    return string.Format("{0}|{1}|{2}|{3}|{4}|{5}", best.ToInt64(), bestRect.Left, bestRect.Top,
      bestRect.Right - bestRect.Left, bestRect.Bottom - bestRect.Top, IsIconic(best) ? 1 : 0);
  }
}
'@
[GameShelfWindows]::UseScreenPixels()

# English OCR when it's installed (it is on English Windows; elsewhere it's the
# "English" optional feature under Language settings), else the user's languages.
$engine = $null
$english = New-Object Windows.Globalization.Language 'en-US'
if ([Windows.Media.Ocr.OcrEngine]::IsLanguageSupported($english)) {
  $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($english)
}
if (-not $engine) { $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages() }

$scratch = Join-Path ([System.IO.Path]::GetTempPath()) "gameshelf-ocr-$PID.bmp"

function Read-Bitmap([byte[]]$bytes) {
  try {
    $memory = New-Object System.IO.MemoryStream (, $bytes)
    $stream = [System.IO.WindowsRuntimeStreamExtensions]::AsRandomAccessStream($memory)
  } catch {
    # Older .NET: go through a file instead.
    [System.IO.File]::WriteAllBytes($scratch, $bytes)
    $file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($scratch)) ([Windows.Storage.StorageFile])
    $stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
  }
  $decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
  Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
}

function Read-Text([byte[]]$bytes) {
  $bitmap = Read-Bitmap $bytes
  try {
    $result = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
  } finally {
    $bitmap.Dispose()
  }
  foreach ($line in $result.Lines) {
    $left = [double]::MaxValue; $top = [double]::MaxValue; $right = 0; $bottom = 0
    foreach ($word in $line.Words) {
      $r = $word.BoundingRect
      if ($r.X -lt $left) { $left = $r.X }
      if ($r.Y -lt $top) { $top = $r.Y }
      if ($r.X + $r.Width -gt $right) { $right = $r.X + $r.Width }
      if ($r.Y + $r.Height -gt $bottom) { $bottom = $r.Y + $r.Height }
    }
    if ($right -le 0) { continue }
    @{ text = $line.Text; box = @{ x = [int]$left; y = [int]$top; w = [int]($right - $left); h = [int]($bottom - $top) } }
  }
}

$ready = @{ type = 'ready'; ocr = [bool]$engine; language = $(if ($engine) { $engine.RecognizerLanguage.LanguageTag } else { $null }) }
[Console]::Out.WriteLine(($ready | ConvertTo-Json -Compress))
[Console]::Out.Flush()

while ($true) {
  $request = [Console]::In.ReadLine()
  if ($null -eq $request) { break }
  $parts = $request.Split([char]9, 3)
  $reply = @{ id = [int]$parts[0] }
  try {
    switch ($parts[1]) {
      'ping' { $reply.pong = $true }
      'ocr' {
        if (-not $engine) { throw 'Windows has no OCR language installed.' }
        $watch = [System.Diagnostics.Stopwatch]::StartNew()
        $reply.lines = @(Read-Text ([Convert]::FromBase64String($parts[2])))
        $reply.ms = $watch.ElapsedMilliseconds
      }
      'window' {
        $pids = @($parts[2].Split(',') | Where-Object { $_ } | ForEach-Object { [uint32]$_ })
        $found = [GameShelfWindows]::Find([uint32[]]$pids)
        if ($found) {
          $f = $found.Split('|')
          $reply.window = @{ hwnd = $f[0]; x = [int]$f[1]; y = [int]$f[2]; w = [int]$f[3]; h = [int]$f[4]; minimized = ($f[5] -eq '1') }
        } else {
          $reply.window = $null
        }
      }
      default { throw "Unknown request: $($parts[1])" }
    }
  } catch {
    $reply.error = $_.Exception.Message
  }
  [Console]::Out.WriteLine(($reply | ConvertTo-Json -Compress -Depth 6))
  [Console]::Out.Flush()
}
Remove-Item -LiteralPath $scratch -ErrorAction SilentlyContinue
