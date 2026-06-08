from __future__ import annotations

from pathlib import Path
from typing import Any

import yaml
from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    database_url: str = "sqlite:///data/spaceport_leads.db"
    config_path: Path = Path("config/spaceport.yaml")
    user_agent: str = "SpaceportLeadResearch/0.1"
    sync_supabase: bool = False
    supabase_url: str | None = Field(default=None, validation_alias="SUPABASE_URL")
    supabase_service_role_key: str | None = Field(
        default=None,
        validation_alias="SUPABASE_SERVICE_ROLE_KEY",
    )

    model_config = SettingsConfigDict(
        env_file=(".env", "../Supabase.env.txt"),
        env_prefix="SPACEPORT_",
        extra="ignore",
    )


def load_app_config(path: Path) -> dict[str, Any]:
    with path.open("r", encoding="utf-8") as f:
        return yaml.safe_load(f) or {}
