# launch.ps1
# Levanta un servidor local (Web Bluetooth exige http://localhost o HTTPS, no file://)
# y abre la app en una ventana de Chrome en "modo app" (sin pestañas ni barra de
# direcciones, como un programa nativo). Si el servidor ya está corriendo en el
# puerto, no lo vuelve a levantar. El servidor queda corriendo en segundo plano
# aunque cierres la ventana -- así reabrir la app es instantáneo la próxima vez.

$root = $PSScriptRoot
Set-Location $root
$port = 8000
$url = "http://localhost:$port/"

$listening = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
if (-not $listening) {
  # Busca un Python real (evita el stub de Microsoft Store que existe aunque
  # Python no esté instalado, y falla con código 49 al invocarlo).
  $pyCmd = $null
  foreach ($candidate in @("py", "python3", "python")) {
    $cmdInfo = Get-Command $candidate -ErrorAction SilentlyContinue
    if ($cmdInfo) {
      try {
        & $candidate --version *> $null
        if ($LASTEXITCODE -eq 0) { $pyCmd = $candidate; break }
      } catch {}
    }
  }

  if ($pyCmd) {
    Start-Process -FilePath $pyCmd -ArgumentList "-m", "http.server", "$port" -WindowStyle Hidden
  } else {
    # Sin Python disponible: usa el servidor de respaldo en PowerShell puro.
    Start-Process -FilePath "powershell" -ArgumentList "-NoProfile", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden", "-File", "`"$root\serve.ps1`"", "-Port", "$port" -WindowStyle Hidden
  }
  Start-Sleep -Milliseconds 800
}

# Perfil de Chrome dedicado (no el del usuario) para que la app tenga su propia
# ventana y recuerde los permisos de Bluetooth que otorgues, entre sesión y sesión.
$profileDir = Join-Path $env:LOCALAPPDATA "DRVREntrenadorCiclismo\ChromeProfile"
New-Item -ItemType Directory -Force -Path $profileDir | Out-Null

$chromeCandidates = @(
  "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
  "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
  "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
)
$browserExe = $chromeCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $browserExe) { $browserExe = "msedge" } # Edge también soporta Web Bluetooth

Start-Process -FilePath $browserExe -ArgumentList "--app=$url", "--user-data-dir=$profileDir"
