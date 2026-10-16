$ErrorActionPreference = "Stop"

$projectRoot = $PSScriptRoot
Set-Location -LiteralPath $projectRoot

$environmentFile = Join-Path $projectRoot ".env"
if (-not (Test-Path -LiteralPath $environmentFile -PathType Leaf)) {
  throw "Missing .env. Copy .env.example to .env and configure it first."
}

$settings = @{}
foreach ($line in Get-Content -LiteralPath $environmentFile) {
  if ($line -match '^\s*(PORT|PUBLIC_HOST)\s*=\s*(.*?)\s*$') {
    $value = $Matches[2].Trim()
    if ($value.Length -ge 2 -and (($value[0] -eq '"' -and $value[-1] -eq '"') -or ($value[0] -eq "'" -and $value[-1] -eq "'"))) {
      $value = $value.Substring(1, $value.Length - 2)
    }
    $settings[$Matches[1]] = $value
  }
}

$port = 0
if (-not [int]::TryParse($settings["PORT"], [ref]$port) -or $port -lt 1024 -or $port -gt 65535) {
  throw "Set PORT in .env to a number between 1024 and 65535."
}
$publicHost = $settings["PUBLIC_HOST"]
if ([string]::IsNullOrWhiteSpace($publicHost) -or $publicHost -notmatch '^[A-Za-z0-9.-]+$') {
  throw "Set PUBLIC_HOST in .env to the ngrok domain without https:// or a path."
}

$ngrokCommand = Get-Command ngrok -ErrorAction Stop
if (Get-Process -Name ngrok -ErrorAction SilentlyContinue) {
  throw "ngrok is already running. Stop its existing window with Ctrl+C before using this launcher."
}

$npxCommand = Get-Command npx.cmd -ErrorAction Stop
$serverStarted = $false

try {
  $serverStarted = $true
  & $npxCommand.Source --no-install pm2 startOrRestart ecosystem.config.cjs --only secure-mcp-file-server
  if ($LASTEXITCODE -ne 0) {
    throw "PM2 could not start the MCP server. Check the PM2 output above."
  }

  $ready = $false
  for ($attempt = 0; $attempt -lt 20; $attempt++) {
    $status = & curl.exe -sS -o NUL -w "%{http_code}" --max-time 2 "http://127.0.0.1:$port/mcp"
    if ($LASTEXITCODE -eq 0 -and $status -eq "401") {
      $ready = $true
      break
    }
    Start-Sleep -Seconds 1
  }

  if (-not $ready) {
    throw "The MCP server did not become ready at http://127.0.0.1:$port/mcp. Check logs/mcp-error.log."
  }

  $ngrokArguments = @(
    "http",
    "http://127.0.0.1:$port",
    "--url",
    "https://$publicHost",
    "--inspect=false"
  )
  Write-Host "MCP server is responding. ngrok is running in this window. Press Ctrl+C here to stop both."
  Write-Host "Claude and ChatGPT connect to https://smitten-darkish-many.ngrok-free.dev/mcp"
  & $ngrokCommand.Source @ngrokArguments
} finally {
  if ($serverStarted) {
    Write-Host "Stopping the MCP server..."
    & $npxCommand.Source --no-install pm2 stop secure-mcp-file-server
  }
}
