from __future__ import annotations

import sqlite3
from pathlib import Path
from typing import Any


def sqlite_path_from_url(database_url: str) -> Path:
    if not database_url.startswith("sqlite:///"):
        raise ValueError("Only sqlite:/// URLs are supported in Phase 1.")
    return Path(database_url.removeprefix("sqlite:///"))


def connect(database_url: str) -> sqlite3.Connection:
    db_path = sqlite_path_from_url(database_url)
    db_path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def init_schema(conn: sqlite3.Connection, schema_path: Path) -> None:
    with schema_path.open("r", encoding="utf-8") as f:
        conn.executescript(f.read())
    conn.commit()


def upsert_firm(
    conn: sqlite3.Connection,
    *,
    name: str,
    website_url: str,
    market: str,
    description: str = "",
) -> int:
    conn.execute(
        """
        INSERT OR IGNORE INTO firms (name, website_url, market, description)
        VALUES (?, ?, ?, ?)
        """,
        (name, website_url, market, description),
    )
    row = conn.execute(
        "SELECT id FROM firms WHERE name = ? AND website_url = ?",
        (name, website_url),
    ).fetchone()
    if row is None:
        raise RuntimeError(f"Unable to upsert firm: {name}")
    return int(row["id"])


def add_source(
    conn: sqlite3.Connection,
    *,
    firm_id: int,
    source_type: str,
    url: str,
    title: str,
    snippet: str,
    raw_text: str,
) -> None:
    conn.execute(
        """
        INSERT OR IGNORE INTO firm_sources
            (firm_id, source_type, url, title, snippet, raw_text)
        VALUES (?, ?, ?, ?, ?, ?)
        """,
        (firm_id, source_type, url, title, snippet, raw_text),
    )


def add_score(conn: sqlite3.Connection, firm_id: int, score: dict[str, Any]) -> None:
    conn.execute(
        """
        INSERT INTO firm_scores (
            firm_id, land_development_focus, civil_3d_likelihood,
            drafting_intensity, ai_fit, firm_size, total_score, decision, reasoning
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            firm_id,
            score["land_development_focus"],
            score["civil_3d_likelihood"],
            score["drafting_intensity"],
            score["ai_fit"],
            score["firm_size"],
            score["total_score"],
            score["decision"],
            score["reasoning"],
        ),
    )


def ranked_firms(conn: sqlite3.Connection, limit: int) -> list[sqlite3.Row]:
    return conn.execute(
        """
        SELECT
            f.name,
            f.website_url,
            f.market,
            s.total_score,
            s.decision,
            s.reasoning
        FROM firms f
        JOIN firm_scores s ON s.firm_id = f.id
        WHERE s.id = (
            SELECT id FROM firm_scores
            WHERE firm_id = f.id
            ORDER BY scored_at DESC, id DESC
            LIMIT 1
        )
        ORDER BY s.total_score DESC, f.name
        LIMIT ?
        """,
        (limit,),
    ).fetchall()
