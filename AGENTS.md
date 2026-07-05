# Anorvis OS agent notes

This package is deliberately small.

## Current scope

- Serve `/health` for Pi startup checks.
- Serve `anorvis_wiki` through `/v1/llm-wiki/wiki`.
- Own the local LLM Wiki scaffold, write loop, lint loop, and migration task.

## Do not re-add yet

- database stack
- scheduler/jobs
- broad integrations
- workflow engine
- memory-vault v1 shelves
- toolkits beyond `anorvis_wiki`

Add those later only when the LLM Wiki loop needs them.

## Checks

Run:

```bash
bun run typecheck
bun run lint
bun run test
```
