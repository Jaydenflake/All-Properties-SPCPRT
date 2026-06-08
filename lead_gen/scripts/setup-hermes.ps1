$ErrorActionPreference = "Stop"

Write-Host "Installing Hermes Agent for native Windows PowerShell..."
iex (irm https://hermes-agent.nousresearch.com/install.ps1)

Write-Host ""
Write-Host "Next steps:"
Write-Host "1. Restart PowerShell so PATH changes load."
Write-Host "2. Run: hermes setup"
Write-Host "3. Run: hermes auth login codex"
Write-Host "4. In Hermes, run: /codex-runtime codex_app_server"
