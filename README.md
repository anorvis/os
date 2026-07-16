# Anorvis OS

Local Anorvis sidecar for LLM Wiki agent execution and machine-local operations.

## Requirements

- [Bun](https://bun.sh) 1.3+

## Install and run

```bash
bun install --frozen-lockfile
bun run dev
```

`bun run dev` starts the local Convex backend and publishes its actual URLs to
`~/.anorvis/convex/deployment.json` so the web app and extension discover the
running deployment instead of assuming fixed ports. Browser-facing task,
calendar, health, finance, integration, memory, and Wiki records are served by
authenticated Convex functions, and local clients sign in silently with the
machine key at `~/.anorvis/convex-setup-key`.

The optional machine-local LLM Wiki sidecar is isolated behind:

```bash
bun run dev:wiki-gateway
```

It listens on `http://127.0.0.1:8787`.

## Configuration

The optional Wiki sidecar works with defaults; override these variables when needed:

| Variable                      | Default                   | Purpose        |
| ----------------------------- | ------------------------- | -------------- |
| `ANORVIS_OS_HOST`             | `127.0.0.1`               | Bind host      |
| `ANORVIS_OS_PORT` (or `PORT`) | `8787`                    | Bind port      |
| `ANORVIS_OS_API_TOKEN_PATH`   | `~/.anorvis/os/api-token` | API token file |

Auth: loopback requests work without a token. On loopback, the first
same-origin `POST /v1/auth/handshake` can write a token to the token file.
Binding to a non-loopback host requires `ANORVIS_OS_API_TOKEN` or an existing
`ANORVIS_OS_API_TOKEN_PATH` before startup; tokenless LAN handshakes are
rejected.

Machine-local state lives under `~/.anorvis/`, including the local LLM Wiki
workspace and registered vault list.

## Responsibilities

- Serve `GET /health` for sidecar startup checks.
- Serve local authority endpoints:
  - `POST /v1/auth/handshake`
  - `GET /v1/os/status`
- Serve LLM Wiki machine-local endpoints:
  - `POST /v1/llm-wiki/init`
  - `GET /v1/llm-wiki/vaults`
  - `POST /v1/llm-wiki/vaults`
  - `POST /v1/llm-wiki/wiki`
  - `POST /v1/llm-wiki/interaction`
  - `GET /v1/llm-wiki/lint`
- Keep durable capability modules out of the sidecar entirely; authenticated
  Convex functions own browser-facing task, calendar, health, finance,
  integration, and wiki CRUD records, and the extension builds its agent
  toolkit directly from those Convex functions.

## Legacy data migration

Preview the SQLite and filesystem migration before applying it:

```bash
bun src/tools/migrate-legacy.ts --dry-run
```

For a local Convex deployment, apply the reviewed payload as the existing owner:

```bash
bun src/tools/migrate-legacy.ts \
  --identity-subject=<owner-user-id> \
  --allow-unsupported
```

The importer is relationship-aware and idempotent. `--allow-unsupported`
acknowledges transient agent-run, delivery, projection, and monitor records that
are intentionally not canonical Convex state.

## Checks

```bash
bun run check
bun run lint:wiki
```

## Toolkit

There is no sidecar toolkit endpoint. Agent-callable durable actions are
authenticated Convex functions; the extension registers them from its own
Convex-backed manifest. The sidecar only exposes machine-local LLM Wiki
execution and local authority routes.

## License

AGPL-3.0-only. See `LICENSE`.
