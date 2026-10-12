# Reva PC-control worker: reads one JSON command per line on stdin, answers one JSON line on stdout.
# Uses Windows UI Automation (no screenshots): list windows, read a window's controls as text, click / type / press keys.
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes, System.Windows.Forms, System.Drawing
Add-Type -TypeDefinition @"
using System; using System.Runtime.InteropServices; using System.Text;
public static class W32 {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, int data, UIntPtr extra);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
  [DllImport("user32.dll")] public static extern uint SendInput(uint n, INPUT[] inputs, int size);
  [DllImport("user32.dll")] public static extern int GetSystemMetrics(int i);
  [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public KEYBDINPUT ki; public long pad; }
  [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT { public ushort vk; public ushort scan; public uint flags; public uint time; public IntPtr extra; }
  public static void TypeText(string s) {
    foreach (char c in s) {
      INPUT[] a = new INPUT[2];
      a[0].type = 1; a[0].ki.scan = c; a[0].ki.flags = 4;          // KEYEVENTF_UNICODE
      a[1].type = 1; a[1].ki.scan = c; a[1].ki.flags = 4 | 2;      // ... | KEYUP
      SendInput(2, a, Marshal.SizeOf(typeof(INPUT)));
      System.Threading.Thread.Sleep(4);
    }
  }
}
"@
Add-Type -TypeDefinition @"
using System; using System.Runtime.InteropServices;
public static class Touch {
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int x; public int y; }
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int left; public int top; public int right; public int bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct POINTER_INFO { public uint pointerType; public uint pointerId; public uint frameId; public uint pointerFlags; public IntPtr sourceDevice; public IntPtr hwndTarget; public POINT ptPixelLocation; public POINT ptHimetricLocation; public POINT ptPixelLocationRaw; public POINT ptHimetricLocationRaw; public uint dwTime; public uint historyCount; public int InputData; public uint dwKeyStates; public ulong PerformanceCount; public int ButtonChangeType; }
  [StructLayout(LayoutKind.Sequential)] public struct POINTER_TOUCH_INFO { public POINTER_INFO pointerInfo; public uint touchFlags; public uint touchMask; public RECT rcContact; public RECT rcContactRaw; public uint orientation; public uint pressure; }
  [DllImport("user32.dll", SetLastError = true)] static extern bool InitializeTouchInjection(uint max, uint mode);
  [DllImport("user32.dll", SetLastError = true)] static extern bool InjectTouchInput(uint count, [In] POINTER_TOUCH_INFO[] contacts);
  [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(POINT p);
  [DllImport("user32.dll")] static extern bool ScreenToClient(IntPtr h, ref POINT p);
  [DllImport("user32.dll")] static extern bool PostMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);
  static bool ready; static bool tried;
  public static bool Init() { if (!tried) { tried = true; try { ready = InitializeTouchInjection(1, 3); } catch { ready = false; } } return ready; }
  static bool Send(uint flags, int x, int y) {
    POINTER_TOUCH_INFO[] c = new POINTER_TOUCH_INFO[1];
    c[0].pointerInfo.pointerType = 2; c[0].pointerInfo.pointerId = 0; c[0].pointerInfo.pointerFlags = flags;
    c[0].pointerInfo.ptPixelLocation.x = x; c[0].pointerInfo.ptPixelLocation.y = y;
    c[0].touchMask = 7; c[0].rcContact.left = x - 2; c[0].rcContact.right = x + 2; c[0].rcContact.top = y - 2; c[0].rcContact.bottom = y + 2; c[0].orientation = 90; c[0].pressure = 32000;
    return InjectTouchInput(1, c);
  }
  public static bool Down(int x, int y) { return Send(0x10000 | 0x4 | 0x2, x, y); }
  public static bool Move(int x, int y) { return Send(0x20000 | 0x4 | 0x2, x, y); }
  public static bool Up(int x, int y) { return Send(0x40000, x, y); }
  // fallback for apps that ignore touch: plain window messages to the control under the point (no pointer movement at all)
  public static void PostClick(int x, int y, bool right) {
    POINT p; p.x = x; p.y = y; IntPtr h = WindowFromPoint(p); if (h == IntPtr.Zero) return; POINT c = p; ScreenToClient(h, ref c);
    IntPtr lp = (IntPtr)(((c.y & 0xFFFF) << 16) | (c.x & 0xFFFF)); uint d = right ? 0x204u : 0x201u, u = right ? 0x205u : 0x202u;
    PostMessage(h, d, (IntPtr)(right ? 2 : 1), lp); System.Threading.Thread.Sleep(40); PostMessage(h, u, IntPtr.Zero, lp);
  }
  public static void PostWheel(int x, int y, int delta) {
    POINT p; p.x = x; p.y = y; IntPtr h = WindowFromPoint(p); if (h == IntPtr.Zero) return;
    PostMessage(h, 0x20A, (IntPtr)(delta << 16), (IntPtr)(((y & 0xFFFF) << 16) | (x & 0xFFFF)));
  }
}
"@
Add-Type -TypeDefinition @"
using System; using System.Runtime.InteropServices;
public static class DpiFix { [DllImport("user32.dll")] public static extern bool SetProcessDPIAware(); [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr v); }
"@
# per-monitor aware (v2): coordinates are real screen pixels on every monitor, whatever its scaling; falls back to system-aware on old Windows
try { if (-not [DpiFix]::SetProcessDpiAwarenessContext([IntPtr](-4))) { [void][DpiFix]::SetProcessDPIAware() } } catch { try { [void][DpiFix]::SetProcessDPIAware() } catch {} }

$AE = [System.Windows.Automation.AutomationElement]
$script:refs = @{}
$script:n = 0
$walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker

function ScreensText() {
  $i = 0; $parts = @()
  foreach ($s in [System.Windows.Forms.Screen]::AllScreens) { $i++; $b = $s.Bounds; $parts += ("$i = " + $b.Width + 'x' + $b.Height + ' at ' + $b.X + ',' + $b.Y + $(if ($s.Primary) { ' (main)' } else { '' })) }
  return 'Screens: ' + ($parts -join '  |  ')
}function Short($s, $max) { if ($null -eq $s) { return '' }; $s = [string]$s; $s = $s -replace '\s+', ' '; if ($s.Length -gt $max) { return $s.Substring(0, $max) + '...' }; return $s }
function TypeName($el) { try { return ($el.Current.ControlType.ProgrammaticName -replace '^ControlType\.', '') } catch { return '?' } }
function Rect($el) { try { $r = $el.Current.BoundingRectangle; if ($r.IsEmpty -or [double]::IsInfinity($r.X)) { return $null }; return $r } catch { return $null } }
function WinList() {
  $root = $AE::RootElement; $out = @()
  $fg = [W32]::GetForegroundWindow().ToInt64()
  $kids = $root.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition)
  foreach ($k in $kids) {
    try {
      $name = $k.Current.Name; if (-not $name) { continue }
      $min = $false; try { $wp = $k.GetCurrentPattern([System.Windows.Automation.WindowPattern]::Pattern); $min = ($wp.Current.WindowVisualState -eq 'Minimized') } catch {}
      if ($k.Current.IsOffscreen -and -not $min) { continue }
      $r = Rect $k
      if (-not $min) { if ($null -eq $r) { continue }; if ($r.Width -lt 40 -or $r.Height -lt 30) { continue } }
      $rx = 0; $ry = 0; $rw = 0; $rh = 0; if ($null -ne $r -and -not $min) { $rx = [int]$r.X; $ry = [int]$r.Y; $rw = [int]$r.Width; $rh = [int]$r.Height }
      $pid2 = $k.Current.ProcessId; $pn = ''; try { $pn = (Get-Process -Id $pid2 -ErrorAction Stop).ProcessName } catch {}
      if ($pn -eq 'Reva' -or $pn -eq 'electron') { }
      $hwnd = $k.Current.NativeWindowHandle
      $out += [pscustomobject]@{ title = $name; process = $pn; pid = $pid2; hwnd = $hwnd; x = $rx; y = $ry; w = $rw; h = $rh; minimized = $min; foreground = ($hwnd -eq $fg); el = $k }
    } catch {}
  }
  return $out
}
function FindWindow($q) {
  $list = WinList
  if (-not $q) { $f = $list | Where-Object { $_.foreground } | Select-Object -First 1; if ($f) { return $f }; return ($list | Select-Object -First 1) }
  if ($q -match '^\d+$') { $f = $list | Where-Object { $_.hwnd -eq [int]$q -or $_.pid -eq [int]$q } | Select-Object -First 1; if ($f) { return $f } }
  $f = $list | Where-Object { $_.title -like "*$q*" -or $_.process -like "*$q*" } | Select-Object -First 1
  if (-not $f) { throw "No window matches '$q'. Use pc_windows to list them." }
  return $f
}
function Focus($w) {
  $h = [IntPtr]$w.hwnd; if ($h -eq [IntPtr]::Zero) { return }
  if ([W32]::IsIconic($h)) { [void][W32]::ShowWindow($h, 9) }
  [W32]::keybd_event(0x12, 0, 0, [UIntPtr]::Zero); [W32]::keybd_event(0x12, 0, 2, [UIntPtr]::Zero)   # ALT tap lets SetForegroundWindow succeed
  [void][W32]::SetForegroundWindow($h); Start-Sleep -Milliseconds 120
}
function Ref($el) { $script:n++; $id = 'e' + $script:n; $script:refs[$id] = $el; return $id }
function GetRef($id) {
  if (-not $id) { throw 'ref is required' }
  if (-not $script:refs.ContainsKey($id)) { throw "Unknown ref '$id'. Take a new pc_snapshot (refs are replaced by every snapshot)." }
  return $script:refs[$id]
}
$INTERACTIVE = @('Button','CheckBox','ComboBox','Edit','Hyperlink','ListItem','MenuItem','RadioButton','Slider','TabItem','TreeItem','Spinner','SplitButton','Document','DataItem','Menu','ToolBar','Tab','List','Tree','Table','Group','Pane','Window','Text','Image','Header','HeaderItem','ScrollBar','StatusBar','TitleBar','Custom','DataGrid','ToolTip')
$SKIP_NAMELESS = @('Pane','Group','Custom','Image','Text','Header','HeaderItem','Window','Menu','ToolBar','Tab','List','Tree','Table','StatusBar','TitleBar','ScrollBar','DataGrid','ToolTip')
function Describe($el, $withRef) {
  $t = TypeName $el; $c = $el.Current; $r = Rect $el
  $s = ''
  if ($withRef) { $s = (Ref $el) + ' ' }
  $s += $t
  $nm = Short $c.Name 90; if ($nm) { $s += ' "' + $nm + '"' }
  if ($c.AutomationId) { $s += ' #' + (Short $c.AutomationId 40) }
  try { $vp = $el.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern); $v = Short $vp.Current.Value 80; if ($v) { $s += ' value="' + $v + '"' }; if ($vp.Current.IsReadOnly) { $s += ' readonly' } } catch {}
  try { $tp = $el.GetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern); $s += ' [' + $tp.Current.ToggleState + ']' } catch {}
  try { $sp = $el.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern); if ($sp.Current.IsSelected) { $s += ' [selected]' } } catch {}
  try { $ep = $el.GetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern); $s += ' [' + $ep.Current.ExpandCollapseState + ']' } catch {}
  if (-not $c.IsEnabled) { $s += ' (disabled)' }
  if ($r) { $s += ' @' + [int]($r.X + $r.Width / 2) + ',' + [int]($r.Y + $r.Height / 2) }
  return $s
}
function Snapshot($q, $depth, $max, $all) {
  $script:refs = @{}; $script:n = 0
  $w = FindWindow $q
  if ($w.minimized) { Focus $w; Start-Sleep -Milliseconds 400; $w = FindWindow $q }   # a minimized window has no readable controls: restore it first
  $lines = New-Object System.Collections.ArrayList
  $count = 0; $deadline = (Get-Date).AddSeconds(9)
  [void]$lines.Add("Window: " + (Short $w.title 100) + " (" + $w.process + ", pid " + $w.pid + ") " + $w.w + "x" + $w.h + " at " + $w.x + "," + $w.y + $(if ($w.foreground) { ' [foreground]' } else { '' }))
  function Walk($el, $d) {
    if ($script:count -ge $max -or (Get-Date) -gt $deadline) { return }
    $child = $walker.GetFirstChild($el)
    while ($null -ne $child) {
      if ($script:count -ge $max -or (Get-Date) -gt $deadline) { return }
      $skip = $false
      try { if ($child.Current.IsOffscreen) { $skip = $true } } catch {}
      if (-not $skip) {
        $t = TypeName $child; $nm = ''; try { $nm = $child.Current.Name } catch {}
        $show = $all -or (($INTERACTIVE -contains $t) -and (-not (($SKIP_NAMELESS -contains $t) -and -not $nm)))
        if ($t -eq 'Text' -and -not $all) { $show = [bool]$nm }
        if ($show) { [void]$lines.Add(('  ' * [Math]::Min($d, 8)) + (Describe $child $true)); $script:count++ }
        if ($d -lt $depth) { Walk $child ($d + 1) }
      }
      $child = $walker.GetNextSibling($child)
    }
  }
  $script:count = 0
  Walk $w.el 0
  if ($script:count -ge $max) { [void]$lines.Add("(truncated at $max elements - pass a smaller window/depth or raise max)") }
  return ($lines -join "`n")
}
# The AI never uses the user's mouse: clicks are injected as a touch tap (or window messages), the pointer is left where it is.
function Tap($x, $y, $hold, $double) {
  $save = [System.Windows.Forms.Cursor]::Position
  if ([Touch]::Init()) {
    $n = 1; if ($double) { $n = 2 }
    for ($i = 0; $i -lt $n; $i++) { [void][Touch]::Down([int]$x, [int]$y); Start-Sleep -Milliseconds $hold; [void][Touch]::Up([int]$x, [int]$y); Start-Sleep -Milliseconds 80 }
  } else {
    $n = 1; if ($double) { $n = 2 }
    for ($i = 0; $i -lt $n; $i++) { [Touch]::PostClick([int]$x, [int]$y, ($hold -gt 500)); Start-Sleep -Milliseconds 80 }
  }
  Start-Sleep -Milliseconds 40
  $now = [System.Windows.Forms.Cursor]::Position
  if ($now.X -eq [int]$x -and $now.Y -eq [int]$y -and ($save.X -ne $now.X -or $save.Y -ne $now.Y)) { [System.Windows.Forms.Cursor]::Position = $save }   # Windows may have promoted the touch to a pointer move: put the user's pointer back
}
function ClickAt($x, $y, $button, $double) {
  if ($button -eq 'middle') { throw 'Middle click is not available (the AI does not use your mouse). Use a keyboard shortcut or the control''s own action.' }
  $hold = 45; if ($button -eq 'right') { $hold = 950 }   # a long press opens the context menu
  Tap $x $y $hold $double
}function Center($el) { $r = Rect $el; if ($null -eq $r) { throw 'That element has no on-screen position.' }; return @([int]($r.X + $r.Width / 2), [int]($r.Y + $r.Height / 2)) }
function WindowOf($el) { $p = $el; while ($null -ne $p) { try { if ((TypeName $p) -eq 'Window') { $h = $p.Current.NativeWindowHandle; if ($h) { return @{ hwnd = $h } } } } catch {}; $p = $walker.GetParent($p) }; return $null }
$VK = @{ enter=0x0D; return=0x0D; tab=0x09; esc=0x1B; escape=0x1B; space=0x20; backspace=0x08; delete=0x2E; del=0x2E; home=0x24; end=0x23; pageup=0x21; pagedown=0x22; left=0x25; up=0x26; right=0x27; down=0x28; ctrl=0x11; control=0x11; alt=0x12; shift=0x10; win=0x5B; windows=0x5B; insert=0x2D; f1=0x70; f2=0x71; f3=0x72; f4=0x73; f5=0x74; f6=0x75; f7=0x76; f8=0x77; f9=0x78; f10=0x79; f11=0x7A; f12=0x7B }
function PressKeys($combo) {
  $parts = ($combo -split '\+') | ForEach-Object { $_.Trim().ToLower() } | Where-Object { $_ }
  $codes = @()
  foreach ($p in $parts) {
    if ($VK.ContainsKey($p)) { $codes += [byte]$VK[$p] }
    elseif ($p.Length -eq 1) { $codes += [byte][char]$p.ToUpper() }
    else { throw "Unknown key '$p'" }
  }
  foreach ($c in $codes) { [W32]::keybd_event($c, 0, 0, [UIntPtr]::Zero); Start-Sleep -Milliseconds 15 }
  [array]::Reverse($codes)
  foreach ($c in $codes) { [W32]::keybd_event($c, 0, 2, [UIntPtr]::Zero); Start-Sleep -Milliseconds 15 }
}

function Handle($cmd) {
  switch ($cmd.op) {
    'windows' {
      $l = WinList | ForEach-Object { ($(if ($_.foreground) { '* ' } else { '  ' })) + '"' + (Short $_.title 80) + '"  ' + $_.process + '  pid ' + $_.pid + $(if ($_.minimized) { '  [MINIMIZED - in the taskbar; pc_focus restores it]' } else { '  ' + $_.w + 'x' + $_.h + ' at ' + $_.x + ',' + $_.y }) }
      return ((ScreensText) + "`n" + ($l -join "`n"))
    }
    'snapshot' {
      $depth = 14; if ($cmd.depth) { $depth = [int]$cmd.depth }; $max = 300; if ($cmd.max) { $max = [int]$cmd.max }
      return (Snapshot $cmd.window $depth $max ([bool]$cmd.all))
    }
    'describe' {
      if ($cmd.ref) { $el = GetRef $cmd.ref; return (Describe $el $false) }
      return ''
    }
    'focus' { $w = FindWindow $cmd.window; Focus $w; return ('Focused "' + (Short $w.title 80) + '"') }
    'click' {
      $button = 'left'; if ($cmd.button) { $button = $cmd.button }
      if ($cmd.ref) {
        $el = GetRef $cmd.ref; $what = Describe $el $false
        $physical = [bool]$cmd.physical -or $button -ne 'left' -or [bool]$cmd.double
        if (-not $physical) {
          try { $ip = $el.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern); $ip.Invoke(); return "Invoked: $what" } catch {}
          try { $sp = $el.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern); $sp.Select(); return "Selected: $what" } catch {}
          try { $tp = $el.GetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern); $tp.Toggle(); return "Toggled: $what" } catch {}
          try { $ep = $el.GetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern); if ($ep.Current.ExpandCollapseState -eq 'Collapsed') { $ep.Expand() } else { $ep.Collapse() }; return "Expanded/collapsed: $what" } catch {}
        }
        $w = WindowOf $el; if ($w) { Focus $w }
        $c = Center $el; ClickAt $c[0] $c[1] $button ([bool]$cmd.double); return "Clicked ($button) at $($c[0]),$($c[1]): $what"
      }
      if ($null -ne $cmd.x -and $null -ne $cmd.y) { ClickAt $cmd.x $cmd.y $button ([bool]$cmd.double); return "Clicked ($button) at $($cmd.x),$($cmd.y)" }
      throw 'Give ref, or x and y.'
    }
    'type' {
      $text = [string]$cmd.text
      if ($cmd.ref) {
        $el = GetRef $cmd.ref
        $w = WindowOf $el; if ($w) { Focus $w }
        if ($cmd.replace) {
          $done = $false
          try { $vp = $el.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern); if (-not $vp.Current.IsReadOnly) { $vp.SetValue($text); $done = $true } } catch {}
          if ($done) { if ($cmd.enter) { PressKeys 'enter' }; return 'Set value.' }
        }
        try { $el.SetFocus() } catch { $c = Center $el; ClickAt $c[0] $c[1] 'left' $false }
        Start-Sleep -Milliseconds 80
        if ($cmd.replace) { PressKeys 'ctrl+a'; Start-Sleep -Milliseconds 40 }
      }
      [W32]::TypeText($text)
      if ($cmd.enter) { Start-Sleep -Milliseconds 40; PressKeys 'enter' }
      return ('Typed ' + $text.Length + ' characters.')
    }
    'key' { PressKeys ([string]$cmd.keys); return ('Pressed ' + $cmd.keys) }
    'scroll' {
      $amount = 3; if ($cmd.amount) { $amount = [int]$cmd.amount }
      $dirDown = ($cmd.direction -eq 'down')
      $x = $null; $y = $null
      if ($cmd.ref) {
        $el = GetRef $cmd.ref
        try {
          $sp = $el.GetCurrentPattern([System.Windows.Automation.ScrollPattern]::Pattern)
          $va = [System.Windows.Automation.ScrollAmount]::LargeIncrement; if (-not $dirDown) { $va = [System.Windows.Automation.ScrollAmount]::LargeDecrement }
          for ($i = 0; $i -lt $amount; $i++) { $sp.Scroll([System.Windows.Automation.ScrollAmount]::NoAmount, $va) }
          return "Scrolled $($cmd.direction) x$amount"
        } catch {}
        $c = Center $el; $x = $c[0]; $y = $c[1]
      } else {
        $w = FindWindow $null; $x = [int]($w.x + $w.w / 2); $y = [int]($w.y + $w.h / 2)
      }
      $d = 120; if ($dirDown) { $d = -120 }
      for ($i = 0; $i -lt $amount; $i++) { [Touch]::PostWheel($x, $y, $d); Start-Sleep -Milliseconds 40 }
      return "Scrolled $($cmd.direction) x$amount"
    }    'drag' {
      $x1 = [int]$cmd.x1; $y1 = [int]$cmd.y1; $x2 = [int]$cmd.x2; $y2 = [int]$cmd.y2
      if (-not [Touch]::Init()) { throw 'Dragging needs touch injection, which is not available on this PC.' }
      $save = [System.Windows.Forms.Cursor]::Position
      [void][Touch]::Down($x1, $y1); Start-Sleep -Milliseconds 120
      $steps = 18
      for ($i = 1; $i -le $steps; $i++) { [void][Touch]::Move([int]($x1 + ($x2 - $x1) * $i / $steps), [int]($y1 + ($y2 - $y1) * $i / $steps)); Start-Sleep -Milliseconds 16 }
      Start-Sleep -Milliseconds 80; [void][Touch]::Up($x2, $y2); Start-Sleep -Milliseconds 40
      $now = [System.Windows.Forms.Cursor]::Position; if ($now.X -eq $x2 -and $now.Y -eq $y2) { [System.Windows.Forms.Cursor]::Position = $save }
      return 'Dragged.'
    }    'read' {
      $el = GetRef $cmd.ref
      try { $tp = $el.GetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern); return (Short ($tp.DocumentRange.GetText(20000)) 20000) } catch {}
      try { $vp = $el.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern); return [string]$vp.Current.Value } catch {}
      return [string]$el.Current.Name
    }
    'launch' {
      $target = [string]$cmd.target
      if (-not $cmd.new_instance -and $target -notmatch '^[A-Za-z][A-Za-z0-9+.-]*://') {
        $stem = [IO.Path]::GetFileNameWithoutExtension($target)
        if ($stem) {
          $hit = WinList | Where-Object { $_.process -like "*$stem*" -or $_.title -like "*$stem*" } | Select-Object -First 1
          if ($hit) {
            $was = ''; if ($hit.minimized) { $was = ' (it was minimized in the taskbar)' }
            Focus $hit
            return ('Already open: "' + (Short $hit.title 70) + '" - brought to the front' + $was + ' instead of starting another copy. Pass new_instance to force a new one.')
          }
        }
      }
      $p = $null
      if ($cmd.args) { $p = Start-Process -FilePath $target -ArgumentList $cmd.args -PassThru } else { $p = Start-Process -FilePath $target -PassThru }
      Start-Sleep -Milliseconds 1500
      return ('Started ' + $target + ' (pid ' + $p.Id + ').')
    }    'wait' {
      $limit = 10; if ($cmd.timeout) { $limit = [Math]::Min(60, [int]$cmd.timeout) }
      $end = (Get-Date).AddSeconds($limit)
      do {
        if ($cmd.text) {
          $hit = WinList | Where-Object { $_.title -like ('*' + $cmd.text + '*') } | Select-Object -First 1
          if ($hit) { return ('Found window "' + (Short $hit.title 80) + '"') }
        } else { Start-Sleep -Milliseconds ([int]$cmd.ms); return 'Waited.' }
        Start-Sleep -Milliseconds 300
      } while ((Get-Date) -lt $end)
      return 'Timed out waiting.'
    }
    'fgcenter' {
      try { $f = FindWindow $null; if ($f.w -gt 0) { return ('{"x":' + [int]($f.x + $f.w / 2) + ',"y":' + [int]($f.y + $f.h / 2) + '}') } } catch {}
      return 'null'
    }
    'locate' {
      if ($cmd.ref) { $el = GetRef $cmd.ref; $c = Center $el; return ('{"x":' + $c[0] + ',"y":' + $c[1] + '}') }
      return 'null'
    }
    'move' {
      if ($cmd.ref) { $el = GetRef $cmd.ref; $c = Center $el; return "AI cursor moved to $($c[0]),$($c[1]) (it has its own cursor; your mouse did not move, so hover effects are not triggered)." }
      return "AI cursor moved to $($cmd.x),$($cmd.y) (your mouse did not move)."
    }    'screenshot' {
      $vs = [System.Windows.Forms.SystemInformation]::VirtualScreen
      if ($cmd.window) { $w = FindWindow $cmd.window; $x = [Math]::Max($vs.X, $w.x); $y = [Math]::Max($vs.Y, $w.y); $wd = [Math]::Min($w.w, $vs.Right - $x); $ht = [Math]::Min($w.h, $vs.Bottom - $y); $what = 'window "' + (Short $w.title 60) + '"' }
      elseif ($cmd.monitor -eq 'all') { $x = $vs.X; $y = $vs.Y; $wd = $vs.Width; $ht = $vs.Height; $what = 'all screens' }
      else {
        $all = [System.Windows.Forms.Screen]::AllScreens; $sc = $null; $label = ''; $mon = [string]$cmd.monitor
        if ($mon -match '^\d+$' -and [int]$mon -ge 1 -and [int]$mon -le $all.Count) { $sc = $all[[int]$mon - 1]; $label = 'screen ' + $mon }
        elseif ($mon -eq 'main') { $sc = [System.Windows.Forms.Screen]::PrimaryScreen; $label = 'the main screen' }
        else { $fw = FindWindow $null; $sc = [System.Windows.Forms.Screen]::FromPoint((New-Object System.Drawing.Point([int]($fw.x + $fw.w / 2), [int]($fw.y + $fw.h / 2)))); $label = 'the screen with the active window' }
        $b = $sc.Bounds; $x = $b.X; $y = $b.Y; $wd = $b.Width; $ht = $b.Height; $what = $label
      }
      $maxw = 1568; if ($cmd.max_width) { $maxw = [int]$cmd.max_width }
      $scale = [Math]::Min(1.0, $maxw / [double]$wd)
      $bmp = New-Object System.Drawing.Bitmap($wd, $ht)
      $g = [System.Drawing.Graphics]::FromImage($bmp); $g.CopyFromScreen($x, $y, 0, 0, (New-Object System.Drawing.Size($wd, $ht))); $g.Dispose()
      $nw = [int]($wd * $scale); $nh = [int]($ht * $scale)
      $out = New-Object System.Drawing.Bitmap($nw, $nh); $g2 = [System.Drawing.Graphics]::FromImage($out); $g2.InterpolationMode = 'HighQualityBicubic'; $g2.DrawImage($bmp, 0, 0, $nw, $nh); $g2.Dispose(); $bmp.Dispose()
      $enc = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' }
      $ep = New-Object System.Drawing.Imaging.EncoderParameters(1); $ep.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter([System.Drawing.Imaging.Encoder]::Quality, [long]72)
      $ms = New-Object System.IO.MemoryStream; $out.Save($ms, $enc, $ep); $out.Dispose()
      $res = @{ b64 = [Convert]::ToBase64String($ms.ToArray()); w = $nw; h = $nh; x = $x; y = $y; sw = $wd; sh = $ht; scale = $scale; what = $what }
      return ($res | ConvertTo-Json -Compress)
    }    'ping' { return 'pong' }
    default { throw ('Unknown op ' + $cmd.op) }
  }
}

[Console]::Out.WriteLine('{"ready":true}'); [Console]::Out.Flush()
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  $line = $line.TrimStart([char]0xFEFF)
  if (-not $line.Trim()) { continue }
  $id = 0
  try {
    $cmd = $line | ConvertFrom-Json; $id = $cmd.id
    $res = Handle $cmd
    $o = @{ id = $id; ok = $true; result = [string]$res }
  } catch {
    $o = @{ id = $id; ok = $false; error = [string]$_.Exception.Message }
  }
  [Console]::Out.WriteLine(($o | ConvertTo-Json -Compress -Depth 4)); [Console]::Out.Flush()
}