# Spaceport Lead Research

This folder now contains two workflows:

- `src/spaceport_leads`: the new SQLite-first Spaceport ICP research pipeline.
- `lead_automation.py`: the older Google Sheets batch filler, preserved for continuity.

Start here:

```powershell
cd C:\Users\judds\OneDrive\Desktop\safe-social\All-Properties-SPCPRT\lead_gen
.\scripts\setup-dev.ps1
.\.venv\Scripts\spaceport-leads.exe run "Phoenix, Arizona" --limit 25
```

Hermes setup:

```powershell
.\scripts\setup-hermes.ps1
hermes setup
hermes auth login codex
hermes
/codex-runtime codex_app_server
```

See `docs/ARCHITECTURE.md` and `docs/ROADMAP.md` for the Phase 1 architecture and implementation plan.

---

# Legacy Lead List Automation (Cloud-Run Every 30 Minutes)

This automation is designed to run in the cloud (GitHub Actions) every 30 minutes.

It updates two tabs in your Google Sheet:

- `In Person`: fills local visit targets near Provo/SLC corridor (minimum target ~15).
- `Cold Call`: adds **5 validated firms per run** until reaching 400 unique firms.

## Validation behavior
Each candidate is checked for ICP fit before being added:

- Must align with civil/structural/land-development style drafting workflows.
- Must show evidence of drafting/revisions (CAD, plan sets, construction docs, grading/drainage/site plans).
- Excludes non-fit categories like electrical-only, plumbing-only, survey-only, geotech-only, etc.
- If a candidate fails, it is discarded and replaced by another candidate until the batch is filled or sources are exhausted.

## Cloud deployment (GitHub Actions)

This repository includes:

- `.github/workflows/lead_gen_every_30m.yml`

That workflow runs every 30 minutes and executes one batch (`--batch-size 5`).

### Required GitHub Secrets

Set these in your repo Settings → Secrets and variables → Actions:

1. `LEAD_SHEET_ID`
   - `1RjcG8tRxnkeQApg1S0ejpk3yLXrHcaNta_mysOcG48M`
2. `GOOGLE_SERVICE_ACCOUNT_JSON`
   - Full JSON credentials payload for your Google service account (single-line JSON string).

Also share the spreadsheet with the service-account email in that JSON.

## Manual cloud trigger

You can also run immediately using **Actions → Lead Gen Every 30 Minutes → Run workflow**.

## Local fallback (optional)

If needed, you can still run a single batch manually:

```bash
export LEAD_SHEET_ID=1RjcG8tRxnkeQApg1S0ejpk3yLXrHcaNta_mysOcG48M
export GOOGLE_SERVICE_ACCOUNT_JSON='{"type":"service_account", ...}'
python lead_gen/lead_automation.py --batch-size 5 --target-cold 400 --fill-in-person
```

## Notes

- The workflow is **not** one-shot overall; it is recurring every 30 minutes in the cloud.
- Deduplication runs each execution.
- Once `Cold Call` reaches 400, no additional rows are added.
