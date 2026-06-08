# Hermes Setup Status

Hermes Agent was installed locally on Windows.

Verified:

```text
Hermes Agent v0.16.0 (2026.6.5)
Install path: C:\Users\judds\AppData\Local\hermes\hermes-agent
Hermes home: C:\Users\judds\AppData\Local\hermes
```

Configured:

```text
model.openai_runtime = codex_app_server
```

Remaining interactive steps:

```powershell
hermes auth login codex
codex login
hermes
```

Inside Hermes:

```text
/codex-runtime
```

It should report `codex_app_server`. If it does not, run:

```text
/codex-runtime codex_app_server
```

Notes:

- The first Hermes installer attempt timed out while downloading dependencies.
- The second pass completed and created the CLI, config, venv, and bundled skills.
- Hermes optional browser/TUI npm installation initially failed because Windows selected an old npm during installer execution.
- The Spaceport project has its own Playwright Chromium installed and does not depend on Hermes browser tooling for Phase 1.
