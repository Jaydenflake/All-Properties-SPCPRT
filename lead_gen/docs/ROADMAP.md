# Development Roadmap

## Phase 1: Local Foundation

- Install Hermes Agent on Windows.
- Connect Hermes to Codex with `/codex-runtime codex_app_server`.
- Create SQLite-first repository structure.
- Create schema for firms, contacts, sources, scores, notes, and research runs.
- Build deterministic ICP scoring so early runs are cheap and inspectable.
- Add a CLI that runs one geography and returns ranked firms.

## Phase 2: First End-to-End Pipeline

Input:

```text
Phoenix, Arizona
```

Output:

```text
Top 25 land development civil engineering firms with 0-100 scores and evidence.
```

Implementation tasks:

1. Improve candidate discovery with more query templates and dedupe by domain.
2. Add Playwright fallback for pages with little static HTML text.
3. Add contact discovery for CAD Managers, Design Managers, PMs, Principals, and land/site development leaders.
4. Add CSV export and optional Google Sheet sync.
5. Add an LLM review pass only for borderline or high-value candidates to minimize API cost.
6. Add Hermes memory notes for what signals produced good leads.

## Phase 1.5: Supabase Backend

- Apply `sql/supabase_schema.sql` to a Supabase project.
- Keep SQLite as the local scratch database.
- Use `spaceport-leads sync-supabase` to push local research data to Supabase.
- Use service-role credentials only in backend/local automation, never in a browser client.
- Keep public table access revoked for `anon` and `authenticated` until an internal UI needs scoped access.

## Phase 3: Productionization

- Move from SQLite to PostgreSQL or Supabase.
- Add scheduled Hermes or VPS cron runs by market.
- Add proxy/rate-limit hygiene.
- Add dashboard or report export.
- Track outreach attempts, replies, converted titles, and lost reasons.

## First Implementation Tasks

- Run `.\scripts\setup-dev.ps1`.
- Run `spaceport-leads run "Phoenix, Arizona" --limit 25`.
- Inspect false positives and update `config/spaceport.yaml`.
- Add Playwright fallback only after identifying static scrape gaps.
- Add contacts once firm ranking quality is acceptable.
