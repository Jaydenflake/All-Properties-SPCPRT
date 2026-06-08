from __future__ import annotations

import sqlite3
from dataclasses import dataclass

from supabase import Client, create_client


@dataclass(frozen=True)
class SupabaseConfig:
    url: str
    service_role_key: str


def get_client(config: SupabaseConfig) -> Client:
    return create_client(config.url, config.service_role_key)


def sync_sqlite_to_supabase(conn: sqlite3.Connection, client: Client) -> dict[str, int]:
    firm_id_map: dict[int, int] = {}
    counts = {
        "firms": 0,
        "firm_sources": 0,
        "firm_scores": 0,
        "contacts": 0,
        "research_runs": 0,
        "research_run_firms": 0,
    }

    firms = conn.execute("SELECT * FROM firms ORDER BY id").fetchall()
    for row in firms:
        payload = {
            "name": row["name"],
            "website_url": row["website_url"],
            "hq_city": row["hq_city"],
            "hq_state": row["hq_state"],
            "market": row["market"],
            "description": row["description"],
        }
        result = (
            client.table("firms")
            .upsert(payload, on_conflict="name,website_url")
            .execute()
        )
        if result.data:
            firm_id_map[int(row["id"])] = int(result.data[0]["id"])
            counts["firms"] += 1

    for row in conn.execute("SELECT * FROM firm_sources ORDER BY id").fetchall():
        remote_firm_id = firm_id_map.get(int(row["firm_id"]))
        if not remote_firm_id:
            continue
        payload = {
            "firm_id": remote_firm_id,
            "source_type": row["source_type"],
            "url": row["url"],
            "title": row["title"],
            "snippet": row["snippet"],
            "raw_text": row["raw_text"],
        }
        client.table("firm_sources").upsert(payload, on_conflict="firm_id,url").execute()
        counts["firm_sources"] += 1

    for row in conn.execute("SELECT * FROM firm_scores ORDER BY id").fetchall():
        remote_firm_id = firm_id_map.get(int(row["firm_id"]))
        if not remote_firm_id:
            continue
        payload = {
            "firm_id": remote_firm_id,
            "land_development_focus": row["land_development_focus"],
            "civil_3d_likelihood": row["civil_3d_likelihood"],
            "drafting_intensity": row["drafting_intensity"],
            "ai_fit": row["ai_fit"],
            "firm_size": row["firm_size"],
            "total_score": row["total_score"],
            "decision": row["decision"],
            "reasoning": row["reasoning"],
        }
        client.table("firm_scores").insert(payload).execute()
        counts["firm_scores"] += 1

    return counts
