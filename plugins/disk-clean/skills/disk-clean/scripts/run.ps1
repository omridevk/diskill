$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$pluginRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path
switch ([System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture) {
  'X64' { $asset = 'disk-clean-windows-x86_64.zip' }
  'Arm64' { $asset = 'disk-clean-windows-arm64.zip' }
  default { $asset = '' }
}

$data = ''
$rest = @()
if ($args.Count -gt 0) {
  $data = [string]$args[0]
  $rest = @($args | Select-Object -Skip 1)
}
if ($data -eq '' -or $data.Contains('${')) {
  $data = Join-Path $HOME '.cache\disk-clean'
}
$data = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($data)

function Write-Stderr([string]$Message) {
  [Console]::Error.WriteLine($Message)
}

function Invoke-Binary([string]$Path) {
  try {
    [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
  } catch {
    $null = $_
  }
  & $Path @rest
  exit $LASTEXITCODE
}

$manifest = Join-Path $pluginRoot '.claude-plugin\plugin.json'
$version = ''
$line = Select-String -LiteralPath $manifest -Pattern '^\s*"version"\s*:\s*"([^"]*)"' -ErrorAction SilentlyContinue |
  Select-Object -First 1
if ($line) {
  $version = $line.Matches[0].Groups[1].Value
}
if ($version -notmatch '^[0-9A-Za-z.+-]+$') {
  Write-Stderr "disk-clean: could not read a valid version from $manifest"
  exit 1
}

$bin = Join-Path $data "bin\disk-clean-$version.exe"
if (Test-Path -LiteralPath $bin -PathType Leaf) {
  Invoke-Binary $bin
}

$null = New-Item -ItemType Directory -Force -Path (Join-Path $data 'bin')
$tmp = Join-Path $data ("bin\.install." + [System.IO.Path]::GetRandomFileName())
$null = New-Item -ItemType Directory -Path $tmp
$ready = Join-Path $tmp 'ready'

function Save-Url([string]$Url, [string]$OutFile) {
  for ($try = 0; $try -lt 3; $try++) {
    try {
      Invoke-WebRequest -UseBasicParsing -Uri $Url -OutFile $OutFile
      return $true
    } catch {
      $null = $_
    }
  }
  return $false
}

function Get-Release {
  if ($asset -eq '') { return $false }
  $url = "https://github.com/omridevk/mopper/releases/download/disk-clean--v$version/$asset"
  [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor
    [Net.SecurityProtocolType]::Tls12
  Write-Stderr "disk-clean: downloading release v$version..."
  $zip = Join-Path $tmp $asset
  if (-not (Save-Url $url $zip)) { return $false }
  if (-not (Save-Url "$url.sha256" "$zip.sha256")) { return $false }
  $fields = @(([System.IO.File]::ReadAllText("$zip.sha256").Trim()) -split '\s+')
  if ($fields.Count -ne 2 -or $fields[1] -cne $asset -or
    $fields[0] -ne (Get-FileHash -Algorithm SHA256 -LiteralPath $zip).Hash) {
    Write-Stderr "disk-clean: checksum mismatch on the downloaded v$version release, refusing to run it"
    exit 1
  }
  try {
    Expand-Archive -LiteralPath $zip -DestinationPath (Join-Path $tmp 'unzip')
    Move-Item -LiteralPath (Join-Path $tmp 'unzip\disk-clean.exe') -Destination $ready
  } catch {
    return $false
  }
  return $true
}

function Build-Source {
  if (-not (Get-Command cargo -ErrorAction SilentlyContinue)) { return $false }
  Write-Stderr "disk-clean: no release download for v$version, building from source with cargo (first run only)..."
  $previous = $env:CARGO_TARGET_DIR
  $env:CARGO_TARGET_DIR = Join-Path $data 'target'
  try {
    & cargo build --release --locked --manifest-path (Join-Path $pluginRoot 'cli\Cargo.toml') |
      ForEach-Object { Write-Stderr $_ }
    $built = $LASTEXITCODE -eq 0
  } finally {
    $env:CARGO_TARGET_DIR = $previous
  }
  if (-not $built) { return $false }
  try {
    Copy-Item -LiteralPath (Join-Path $data 'target\release\disk-clean.exe') -Destination $ready
  } catch {
    return $false
  }
  return $true
}

try {
  if (-not (Get-Release) -and -not (Build-Source)) {
    Write-Stderr "disk-clean: could not get the disk-clean binary for v$version."
    Write-Stderr '  Either install Rust (https://rustup.rs) so it can be built from source on first run,'
    Write-Stderr '  or install a plugin version that has a published release:'
    Write-Stderr '  https://github.com/omridevk/mopper/releases'
    exit 1
  }
  try {
    [System.IO.File]::Move($ready, $bin)
  } catch {
    if (-not (Test-Path -LiteralPath $bin -PathType Leaf)) { throw }
  }
} finally {
  Remove-Item -Recurse -Force -LiteralPath $tmp -ErrorAction SilentlyContinue
}
Invoke-Binary $bin
