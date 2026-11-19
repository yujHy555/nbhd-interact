# Start the NBHD Interact dev server on port 3000
Set-Location $PSScriptRoot
$existing = Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue
if ($existing) {
  Stop-Process -Id $existing.OwningProcess -Force -ErrorAction SilentlyContinue
  Start-Sleep -Milliseconds 500
}
$cmd = '/c cd /d "' + $PSScriptRoot + '" && npm run dev'
$proc = Start-Process -FilePath 'cmd.exe' -ArgumentList $cmd -WindowStyle Hidden -PassThru
Start-Sleep -Seconds 5
try {
  $r = Invoke-WebRequest -Uri 'http://localhost:3000/' -TimeoutSec 10 -UseBasicParsing
  Write-Output "Started PID $($proc.Id)"
  Write-Output "HTTP $($r.StatusCode)"
} catch {
  Write-Output "Server started but not responding yet"
}
