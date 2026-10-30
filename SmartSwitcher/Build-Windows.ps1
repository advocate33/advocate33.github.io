# Tested by GitHub Actions on Windows. Requires .NET SDK 10.
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root
if (-not (Get-Command dotnet -ErrorAction SilentlyContinue)) {
    throw 'Install .NET SDK 10 first.'
}
Write-Host '1/3 Core self-tests'
& dotnet run --project 'tests/SmartSwitcher.SelfTests/SmartSwitcher.SelfTests.csproj' -c Release
if ($LASTEXITCODE -ne 0) { throw 'Core self-tests failed.' }
Write-Host '2/3 Publish Windows desktop app'
$publish = Join-Path $root 'out/publish'
if (Test-Path $publish) { Remove-Item $publish -Recurse -Force }
& dotnet publish 'src/SmartSwitcher.Desktop/SmartSwitcher.Desktop.csproj' -c Release -r win-x64 --self-contained true -p:PublishSingleFile=true -p:IncludeNativeLibrariesForSelfExtract=true -o $publish
if ($LASTEXITCODE -ne 0) { throw 'Windows publish failed.' }
$exe = Join-Path $publish 'SmartSwitcher.exe'
if (-not (Test-Path $exe)) { throw 'SmartSwitcher.exe is missing.' }
Write-Host '3/3 Create artifact ZIP'
$archive = Join-Path $root 'out/SmartSwitcher-win-x64-v0.1.0.zip'
if (Test-Path $archive) { Remove-Item $archive -Force }
Compress-Archive -Path (Join-Path $publish '*') -DestinationPath $archive
Get-FileHash $exe -Algorithm SHA256 | Format-List
Write-Host "Package: $archive"
