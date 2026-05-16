"""Shared PostHog analytics client for Canyon Vista unit scripts."""
from __future__ import annotations

import os
import socket
from functools import lru_cache

from dotenv import load_dotenv

load_dotenv()


@lru_cache(maxsize=1)
def get_client():
    """Return a lazily-initialized PostHog client, or None if not configured."""
    api_key = os.environ.get("POSTHOG_API_KEY", "")
    host = os.environ.get("POSTHOG_HOST", "")
    if not api_key:
        return None
    try:
        from posthog import Posthog
        kwargs = {"api_key": api_key}
        if host:
            kwargs["host"] = host
        return Posthog(**kwargs)
    except ImportError:
        return None


def _distinct_id() -> str:
    """Use the machine hostname as a stable CLI identity."""
    return socket.gethostname()


def capture(event: str, properties: dict | None = None) -> None:
    """Capture a PostHog event. Silently no-ops if client is unavailable."""
    client = get_client()
    if client is None:
        return
    try:
        client.capture(
            distinct_id=_distinct_id(),
            event=event,
            properties=properties or {},
        )
    except Exception:
        pass


def shutdown() -> None:
    """Flush pending events before process exit."""
    client = get_client()
    if client is not None:
        try:
            client.shutdown()
        except Exception:
            pass
