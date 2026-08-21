# serve.ps1
# Servidor estático mínimo en PowerShell puro (sin depender de Python) para
# usar como respaldo cuando la máquina no tiene "py"/"python" instalado.
# Sirve los archivos de esta carpeta en http://localhost:<Port>/.

param(
  [int]$Port = 8000
)

$root = $PSScriptRoot

$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://localhost:$Port/")
$listener.Start()

$mimeTypes = @{
  ".html"  = "text/html; charset=utf-8"
  ".htm"   = "text/html; charset=utf-8"
  ".js"    = "text/javascript; charset=utf-8"
  ".css"   = "text/css; charset=utf-8"
  ".json"  = "application/json; charset=utf-8"
  ".png"   = "image/png"
  ".jpg"   = "image/jpeg"
  ".jpeg"  = "image/jpeg"
  ".gif"   = "image/gif"
  ".svg"   = "image/svg+xml"
  ".ico"   = "image/x-icon"
  ".txt"   = "text/plain; charset=utf-8"
  ".woff"  = "font/woff"
  ".woff2" = "font/woff2"
}

$rootFull = [System.IO.Path]::GetFullPath($root)

while ($listener.IsListening) {
  try {
    $context = $listener.GetContext()
  } catch {
    break
  }

  $request = $context.Request
  $response = $context.Response
  try {
    $path = [Uri]::UnescapeDataString($request.Url.AbsolutePath)
    if ($path -eq "/") { $path = "/index.html" }
    $filePath = [System.IO.Path]::GetFullPath((Join-Path $rootFull $path.TrimStart("/")))

    if (-not $filePath.StartsWith($rootFull, [StringComparison]::OrdinalIgnoreCase)) {
      $response.StatusCode = 403
    } elseif (Test-Path -LiteralPath $filePath -PathType Leaf) {
      $ext = [System.IO.Path]::GetExtension($filePath).ToLower()
      $contentType = $mimeTypes[$ext]
      if (-not $contentType) { $contentType = "application/octet-stream" }
      $response.ContentType = $contentType
      $bytes = [System.IO.File]::ReadAllBytes($filePath)
      $response.ContentLength64 = $bytes.Length
      $response.OutputStream.Write($bytes, 0, $bytes.Length)
    } else {
      $response.StatusCode = 404
      $notFound = [System.Text.Encoding]::UTF8.GetBytes("404 Not Found")
      $response.OutputStream.Write($notFound, 0, $notFound.Length)
    }
  } catch {
  } finally {
    $response.OutputStream.Close()
  }
}
