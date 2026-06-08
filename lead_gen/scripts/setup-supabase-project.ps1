param(
    [Parameter(Mandatory = $true)]
    [string]$OrgId,

    [Parameter(Mandatory = $true)]
    [string]$DbPassword,

    [string]$ProjectName = "spaceport-lead-gen",
    [string]$Region = ""
)

$ErrorActionPreference = "Stop"

if (-not $env:SUPABASE_ACCESS_TOKEN) {
    throw "Set SUPABASE_ACCESS_TOKEN first. Create one at https://supabase.com/dashboard/account/tokens"
}

Write-Host "Creating Supabase project '$ProjectName' in org '$OrgId'..."
$createArgs = @(
    "projects", "create", $ProjectName,
    "--org-id", $OrgId,
    "--db-password", $DbPassword,
    "--output", "json"
)

if ($Region) {
    $createArgs += @("--region", $Region)
}

$projectJson = supabase @createArgs

if ($LASTEXITCODE -ne 0) {
    throw "Supabase project creation failed. If the error mentions regions, upgrade the CLI or rerun without -Region."
}

$project = $projectJson | ConvertFrom-Json
$projectRef = $project.id
if (-not $projectRef) { $projectRef = $project.ref }
if (-not $projectRef) { $projectRef = $project.project_ref }
if (-not $projectRef) {
    throw "Could not read project ref from Supabase CLI response."
}

Write-Host "Project created: $projectRef"
Write-Host "Waiting for project database to become reachable..."
Start-Sleep -Seconds 60

supabase link --project-ref $projectRef --password $DbPassword
supabase db push --password $DbPassword

Write-Host "Fetching API keys..."
$keysJson = supabase projects api-keys --project-ref $projectRef --output json
$keys = $keysJson | ConvertFrom-Json
$anon = ($keys | Where-Object { $_.name -eq "anon" -or $_.name -eq "anon key" } | Select-Object -First 1).api_key
$service = ($keys | Where-Object { $_.name -eq "service_role" -or $_.name -eq "service_role key" } | Select-Object -First 1).api_key

if (-not $anon -or -not $service) {
    Write-Warning "Project was created and schema was pushed, but API keys were not parsed. Check Supabase dashboard."
    exit 0
}

@"
SUPABASE_URL=https://$projectRef.supabase.co
SUPABASE_ANON_KEY=$anon
SUPABASE_SERVICE_ROLE_KEY=$service
"@ | Set-Content -Path "..\Supabase.env.txt" -Encoding UTF8

Write-Host "Wrote Supabase credentials to ..\Supabase.env.txt"
Write-Host "Testing sync..."
.\.venv\Scripts\spaceport-leads.exe sync-supabase
