from __future__ import annotations

from pathlib import Path

import click
from rich.console import Console
from rich.table import Table

from .config import Settings, load_app_config
from .db import connect, init_schema
from .pipeline import run_pipeline
from .supabase_sync import SupabaseConfig, get_client, sync_sqlite_to_supabase

console = Console()


@click.group()
def main() -> None:
    """Spaceport lead research pipeline."""


@main.command("init-db")
def init_db_command() -> None:
    settings = Settings()
    conn = connect(settings.database_url)
    init_schema(conn, Path("sql/schema.sql"))
    console.print("[green]Initialized database[/green]")


@main.command("run")
@click.argument("geo")
@click.option("--limit", default=None, type=int, help="Number of ranked firms to output.")
@click.option("--search-depth", default=None, type=int, help="Search candidates to evaluate.")
@click.option("--sync-supabase", is_flag=True, help="Sync the completed local run to Supabase.")
def run_command(
    geo: str,
    limit: int | None,
    search_depth: int | None,
    sync_supabase: bool,
) -> None:
    settings = Settings()
    config = load_app_config(settings.config_path)
    limit = limit or config["market"]["default_result_limit"]
    search_depth = search_depth or config["market"]["default_search_depth"]

    conn = connect(settings.database_url)
    init_schema(conn, Path("sql/schema.sql"))
    results = run_pipeline(
        conn,
        geo=geo,
        config=config,
        user_agent=settings.user_agent,
        limit=limit,
        search_depth=search_depth,
    )

    table = Table(title=f"Spaceport Lead Ranking: {geo}")
    table.add_column("Rank", justify="right")
    table.add_column("Firm")
    table.add_column("Score", justify="right")
    table.add_column("Decision")
    table.add_column("Website")
    table.add_column("Evidence")

    for index, result in enumerate(results, start=1):
        table.add_row(
            str(index),
            result.name,
            str(result.score),
            result.decision,
            result.url,
            result.reasoning[:180],
        )

    console.print(table)

    if sync_supabase or settings.sync_supabase:
        sync_to_supabase(conn, settings)


@main.command("sync-supabase")
def sync_supabase_command() -> None:
    settings = Settings()
    conn = connect(settings.database_url)
    sync_to_supabase(conn, settings)


def sync_to_supabase(conn, settings: Settings) -> None:
    if not settings.supabase_url or not settings.supabase_service_role_key:
        raise click.ClickException(
            "Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env or ../Supabase.env.txt."
        )
    client = get_client(
        SupabaseConfig(
            url=settings.supabase_url,
            service_role_key=settings.supabase_service_role_key,
        )
    )
    counts = sync_sqlite_to_supabase(conn, client)
    console.print(f"[green]Synced to Supabase[/green]: {counts}")
