# Kill stale hotfix-drill serve processes (safe: matches full command line)
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File tools/kill-drill-server.ps1
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -like '*hotfix-drill.js serve*' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force; Write-Output ("killed " + $_.ProcessId) }
Write-Output "done"
