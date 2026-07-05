.PHONY: check ci

check:
	@bun run check

ci:
	@bun install --frozen-lockfile && bun run check
