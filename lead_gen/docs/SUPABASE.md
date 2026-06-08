# Supabase Backend

## Auth

There are two workable auth paths:

1. Use the Supabase MCP server with OAuth in Codex.
   - `.mcp.json` points at `https://mcp.supabase.com/mcp`.
   - Trigger Supabase MCP auth in the Codex UI, complete the browser login, then reload the session.
   - Once MCP tools are visible, apply `sql/supabase_schema.sql` with the MCP SQL execution tool.

2. Use an existing Supabase project URL and service-role key.
   - Store them in `.env` or the existing repo-root `Supabase.env.txt`.
   - Do not expose the service-role key in frontend code.

3. Use the Supabase CLI token flow.
   - This Codex shell is non-interactive, so `supabase login` browser OAuth cannot run directly here.
   - Create a token at `https://supabase.com/dashboard/account/tokens`.
   - Set it locally as `SUPABASE_ACCESS_TOKEN`.
   - Then run `scripts/setup-supabase-project.ps1`.

Example:

```powershell
$env:SUPABASE_ACCESS_TOKEN = "<token from Supabase dashboard>"
.\scripts\setup-supabase-project.ps1 `
  -OrgId "<your-org-id>" `
  -DbPassword "<new database password>" `
  -ProjectName "spaceport-lead-gen" `
  -Region "us-west-1"
```

You can list org IDs after setting the token:

```powershell
supabase orgs list
```

## Schema Setup

Apply:

```text
sql/supabase_schema.sql
```

The schema creates:

- `firms`
- `firm_sources`
- `firm_scores`
- `contacts`
- `research_runs`
- `research_run_firms`

RLS is enabled on every table. Public `anon` and `authenticated` access is revoked. Backend writes use the service role.

## Sync Local Data

```powershell
cd C:\Users\judds\OneDrive\Desktop\safe-social\All-Properties-SPCPRT\lead_gen
.\.venv\Scripts\spaceport-leads.exe sync-supabase
```

Or run and sync in one step:

```powershell
.\.venv\Scripts\spaceport-leads.exe run "Phoenix, Arizona" --limit 25 --sync-supabase
```
