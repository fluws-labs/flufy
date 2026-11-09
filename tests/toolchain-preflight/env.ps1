# Dot-source from any working directory: . .\tests\toolchain-preflight\env.ps1
# Changes only this PowerShell process; no installation or global configuration.
$env:CARGO_HOME = Join-Path $PSScriptRoot 'cargo-home'
$env:RUSTUP_HOME = Join-Path $PSScriptRoot 'rustup-home'
$cargoBin = Join-Path $env:CARGO_HOME 'bin'
if (-not (Test-Path -LiteralPath (Join-Path $cargoBin 'cargo.exe'))) {
    throw 'The existing project-local Cargo installation was not found.'
}
if (-not (Test-Path -LiteralPath (Join-Path $env:RUSTUP_HOME 'toolchains\stable-x86_64-pc-windows-msvc\bin\rustc.exe'))) {
    throw 'The existing stable MSVC toolchain was not found.'
}
if (($env:PATH -split ';') -notcontains $cargoBin) {
    $env:PATH = "$cargoBin;$env:PATH"
}
