PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS firms (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    website_url TEXT,
    hq_city TEXT,
    hq_state TEXT,
    market TEXT,
    description TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(name, website_url)
);

CREATE TABLE IF NOT EXISTS firm_sources (
    id INTEGER PRIMARY KEY,
    firm_id INTEGER NOT NULL REFERENCES firms(id) ON DELETE CASCADE,
    source_type TEXT NOT NULL,
    url TEXT NOT NULL,
    title TEXT,
    snippet TEXT,
    raw_text TEXT,
    fetched_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(firm_id, url)
);

CREATE TABLE IF NOT EXISTS firm_scores (
    id INTEGER PRIMARY KEY,
    firm_id INTEGER NOT NULL REFERENCES firms(id) ON DELETE CASCADE,
    land_development_focus INTEGER NOT NULL,
    civil_3d_likelihood INTEGER NOT NULL,
    drafting_intensity INTEGER NOT NULL,
    ai_fit INTEGER NOT NULL,
    firm_size INTEGER NOT NULL,
    total_score INTEGER NOT NULL,
    decision TEXT NOT NULL,
    reasoning TEXT NOT NULL,
    scored_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS contacts (
    id INTEGER PRIMARY KEY,
    firm_id INTEGER NOT NULL REFERENCES firms(id) ON DELETE CASCADE,
    full_name TEXT,
    title TEXT,
    email TEXT,
    phone TEXT,
    profile_url TEXT,
    source_url TEXT,
    confidence INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS research_runs (
    id INTEGER PRIMARY KEY,
    geo TEXT NOT NULL,
    status TEXT NOT NULL,
    requested_limit INTEGER NOT NULL,
    notes TEXT,
    started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    completed_at TEXT
);

CREATE TABLE IF NOT EXISTS research_run_firms (
    research_run_id INTEGER NOT NULL REFERENCES research_runs(id) ON DELETE CASCADE,
    firm_id INTEGER NOT NULL REFERENCES firms(id) ON DELETE CASCADE,
    rank INTEGER,
    PRIMARY KEY (research_run_id, firm_id)
);

CREATE INDEX IF NOT EXISTS idx_firm_scores_total ON firm_scores(total_score DESC);
CREATE INDEX IF NOT EXISTS idx_firm_scores_firm_id ON firm_scores(firm_id);
CREATE INDEX IF NOT EXISTS idx_firms_market ON firms(market);
CREATE INDEX IF NOT EXISTS idx_contacts_firm ON contacts(firm_id);
CREATE INDEX IF NOT EXISTS idx_research_run_firms_firm_id ON research_run_firms(firm_id);
