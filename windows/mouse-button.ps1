Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class NotchMouseButton {
  [StructLayout(LayoutKind.Sequential)]
  public struct POINT {
    public int X;
    public int Y;
  }

  [StructLayout(LayoutKind.Sequential)]
  public struct RECT {
    public int Left;
    public int Top;
    public int Right;
    public int Bottom;
  }

  [DllImport("user32.dll")]
  public static extern short GetAsyncKeyState(int virtualKey);

  [DllImport("user32.dll")]
  public static extern bool GetCursorPos(out POINT point);

  [DllImport("user32.dll")]
  public static extern bool GetWindowRect(IntPtr windowHandle, out RECT rect);
}
"@

$handleLine = [Console]::In.ReadLine()
$windowHandle = [IntPtr]::new([Int64]$handleLine.Trim())

while ($true) {
  $buttonState = [NotchMouseButton]::GetAsyncKeyState(1)
  $cursorPoint = New-Object NotchMouseButton+POINT
  [void][NotchMouseButton]::GetCursorPos([ref]$cursorPoint)
  $windowRect = New-Object NotchMouseButton+RECT
  [void][NotchMouseButton]::GetWindowRect($windowHandle, [ref]$windowRect)
  $buttonName = "up"
  if ($buttonState -lt 0) { $buttonName = "down" }
  [Console]::Out.WriteLine("$buttonName $($cursorPoint.X) $($cursorPoint.Y) $($windowRect.Left) $($windowRect.Top) $($windowRect.Right) $($windowRect.Bottom)")
  [Console]::Out.Flush()
  Start-Sleep -Milliseconds 16
}
