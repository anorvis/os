# Anorvis OS

Local-first Anorvis backend and LLM Wiki engine.

## Responsibilities

- Serve `GET /health` for extension startup checks.
- Serve LLM Wiki endpoints:
  - `POST /v1/llm-wiki/init`
  - `POST /v1/llm-wiki/wiki`
  - `GET /v1/llm-wiki/lint`
- Serve the platform toolkit manifest at `GET /v1/os/toolkit`.
- Own toolkit metadata for tasks, calendar events, task sessions, and Life snapshot reads.
- Own the local LLM Wiki scaffold, write loop, lint loop, and migration task.

## Run

```bash
bun install --frozen-lockfile
bun run dev
```

Default URL:

```text
http://127.0.0.1:8787
```

Data root:

```text
~/.anorvis/llm-wiki
```

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

The extension keeps the toolkit manifest out of model context by default. Its always-active `anorvis_tool` router reads this manifest, performs reads directly where possible, and activates precise action tools only when a mutation is needed.

## License

AGPL-3.0-only. See `LICENSE`.
