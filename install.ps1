# Install `fb` on Windows: prebuilt binary from the latest GitHub release, else build from source with cargo.
# Usage (PowerShell):  irm https://raw.githubusercontent.com/hieu-lee/facebook-cli/main/install.ps1 | iex
$ErrorActionPreference = 'Stop'
$repo = 'hieu-lee/facebook-cli'
$binDir = if ($env:FB_BIN_DIR) { $env:FB_BIN_DIR } else { Join-Path $env:LOCALAPPDATA 'fb\bin' }
New-Item -ItemType Directory -Force -Path $binDir | Out-Null
$arch = if ([Environment]::Is64BitOperatingSystem) { 'x86_64' } else { throw '64-bit Windows is required' }
$installed = $null
$dest = Join-Path $binDir 'fb.exe'
# a running daemon locks the exe: stop it before replacing (it restarts on the next command)
if (Test-Path $dest) { try { & $dest stop 2>$null | Out-Null } catch { } ; Start-Sleep -Milliseconds 800 }
$tmp = Join-Path ([IO.Path]::GetTempPath()) ("fb-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $tmp | Out-Null
try {
  $zip = Join-Path $tmp 'fb.zip'
  $exe = Join-Path $tmp 'fb.exe'
  $usable = $false
  try {
    Invoke-WebRequest -UseBasicParsing "https://github.com/$repo/releases/latest/download/fb-$arch-windows.zip" -OutFile $zip
    Expand-Archive -Force $zip -DestinationPath $tmp
    $usable = (Test-Path $exe) -and ((& $exe help 2>$null) -ne $null)
  } catch { Write-Verbose "no usable prebuilt binary: $_" }
  if ($usable) {
    # the daemon may still be shutting down and holding the exe: retry for a few seconds, then fail loudly
    for ($i = 1; $i -le 10; $i++) {
      try { Copy-Item -Force $exe $dest; break } catch { if ($i -eq 10) { throw }; Start-Sleep -Seconds 1 }
    }
    $installed = 'prebuilt binary'
  }
  if (-not $installed) {
    if (-not (Get-Command cargo -ErrorAction SilentlyContinue)) {
      Write-Error "fb: no prebuilt binary and no Rust toolchain. Install Rust from https://rustup.rs and run this again."
      exit 1
    }
    cargo install --locked --git "https://github.com/$repo" --root (Join-Path $tmp 'cargo') fb
    Copy-Item -Force (Join-Path $tmp 'cargo\bin\fb.exe') $dest
    $installed = 'built from source'
  }
} finally { Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue }
Write-Host "fb installed to $dest ($installed)"
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if (($userPath -split ';') -notcontains $binDir) {
  [Environment]::SetEnvironmentVariable('Path', "$userPath;$binDir", 'User')
  Write-Host "added $binDir to your PATH (open a new terminal to use `fb`)"
}
Write-Host "next: fb login    (reuses the Facebook session of your normal Chrome; one Allow click)"
