# Anorvis OS

Local-first Anorvis backend and LLM Wiki engine.

## Responsibilities

- Serve `GET /health` for extension startup checks.
- Serve `POST /v1/llm-wiki/init`.
- Serve `POST /v1/llm-wiki/wiki`.
- Serve `GET /v1/llm-wiki/lint`.
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

## License

AGPL-3.0-only. See `LICENSE`.
