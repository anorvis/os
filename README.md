# Anorvis OS

Local-first Anorvis backend and LLM Wiki engine.

## Requirements

- [Bun](https://bun.sh) 1.3+

## Install & run

```bash
bun install --frozen-lockfile
bun run dev
```

The gateway listens on:

```text
http://127.0.0.1:8787
```

## Configuration

Everything works with defaults; override with environment variables when needed:

| Variable                      | Default                          | Purpose              |
| ----------------------------- | -------------------------------- | -------------------- |
| `ANORVIS_OS_HOST`             | `127.0.0.1`                      | Bind host            |
| `ANORVIS_OS_PORT` (or `PORT`) | `8787`                           | Bind port            |
| `ANORVIS_DB_PATH`             | `~/.anorvis/data/anorvis.sqlite` | SQLite database file |
| `ANORVIS_OS_API_TOKEN_PATH`   | `~/.anorvis/os/api-token`        | API token file       |

Auth: loopback requests work without a token. Binding to a non-loopback host
requires a configured token; the first `POST /v1/auth/handshake` writes one to
the token file.

Data lives under `~/.anorvis/` — `data/anorvis.sqlite` for structured records
and `llm-wiki/` for the wiki. Database migrations run automatically on start.

## Responsibilities

- Serve `GET /health` for extension startup checks.
- Serve LLM Wiki endpoints:
  - `POST /v1/llm-wiki/init`
  - `POST /v1/llm-wiki/wiki`
  - `GET /v1/llm-wiki/lint`
- Serve the platform toolkit manifest at `GET /v1/os/toolkit`.
- Own toolkit metadata for tasks, calendar events, task sessions, Life
  snapshot reads, and Finance (dashboard, accounts, CSV imports).
- Own the local LLM Wiki scaffold, write loop, lint loop, and migration task.
- Own canonical Life, Health, and Finance records in SQLite.

## Checks

```bash
bun run check
bun run lint:wiki
```

## Toolkit

`GET /v1/os/toolkit` returns the curated manifest consumed by the extension. The manifest is not route reflection; each capability owns explicit agent-facing metadata beside its route/schema code.

Current toolkit resources:

- `task`
- `calendar_event`
- `task_session`
- `life_snapshot`
- `finance_dashboard`
- `finance_account`
- `finance_import`
- `health_dashboard`
- `meal`
- `macro_profile`
- `workout`
- `body_measurement`
- `recipe`
- `recipe_import`
- `recipe_search`
- `food_search`
- `hevy_settings`
- `hevy_sync`
- `hevy_routine`
- `hevy_exercise_template`

The extension keeps the toolkit manifest out of model context by default. Its always-active `anorvis_tool` router reads this manifest, performs reads directly where possible, and activates precise action tools only when a mutation is needed.

## License

AGPL-3.0-only. See `LICENSE`.
