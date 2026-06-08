$ErrorActionPreference = "Stop"

if (Get-Command py -ErrorAction SilentlyContinue) {
    $python = "py"
    $pythonArgs = @("-3")
} elseif (Get-Command python -ErrorAction SilentlyContinue) {
    $python = "python"
    $pythonArgs = @()
} else {
    throw "Python 3.11+ was not found."
}

& $python @pythonArgs -m venv .venv
.\.venv\Scripts\python.exe -m pip install --upgrade pip
.\.venv\Scripts\python.exe -m pip install -e .
.\.venv\Scripts\python.exe -m playwright install chromium
.\.venv\Scripts\spaceport-leads.exe init-db

Write-Host "Dev environment ready."
Write-Host "Run: .\.venv\Scripts\spaceport-leads.exe run `"Phoenix, Arizona`" --limit 25"
