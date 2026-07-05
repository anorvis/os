function day(now: Date): string {
  return now.toISOString().slice(0, 10);
}

export const OBSIDIAN_APP_JSON = `${JSON.stringify({ promptDelete: false, alwaysUpdateLinks: true }, null, 2)}\n`;

export function initRules(now: Date): string {
  const today = day(now);
  return `# Anorvis LLM Wiki

This directory is Anorvis' agent-maintained LLM Wiki. It follows the LLM Wiki pattern: raw sources are preserved, while durable knowledge is compiled into interlinked Markdown pages.

Created: ${today}

## Layers

- \`raw/\` contains source material. Treat it as provenance. Do not edit raw files to correct claims.
- \`wiki/\` contains compiled synthesis. Update these pages when new sources change what Anorvis should know.
- \`index.md\` is the page catalog. Update it when wiki pages are created, renamed, or materially changed.
- \`log.md\` is the append-only operation log. Add an entry for every ingest, wiki update, migration, or repair.
- \`cache.md\` is a short working cache. It is useful for orientation but is not source of truth.

## Operating rules

1. Orient before wiki work: read \`cache.md\`, \`index.md\`, and recent \`log.md\`.
2. Search existing pages before creating new ones.
3. Prefer updating existing pages over duplicating concepts.
4. Use Obsidian \`[[wikilinks]]\` for relationships.
5. Preserve provenance: link claims back to raw sources or prior wiki pages.
6. Mark uncertainty, contradictions, stale claims, and gaps explicitly.
7. Never store secrets, tokens, cookies, passwords, or raw private transcripts as wiki synthesis.
8. Raw sources may contain private material; compiled wiki pages should contain only useful synthesized knowledge with provenance.

## Page conventions

Every compiled wiki page should use flat YAML frontmatter:

\`\`\`yaml
---
type: source | entity | concept | comparison | query | project | preference | workflow | decision
title: "Page Title"
created: YYYY-MM-DD
updated: YYYY-MM-DD
status: seed | developing | mature | stale
tags: []
related: []
sources: []
---
\`\`\`

Keep pages scannable. Split pages that become too broad.
`;
}

export function initIndex(now: Date): string {
  return `# Anorvis LLM Wiki Index

> Catalog of compiled Anorvis wiki pages. Read this before creating new pages.
> Last updated: ${day(now)}

## Sources

## Entities

## Concepts

## Comparisons

## Queries

## Projects

## Preferences

## Workflows

## Decisions
`;
}

export function initLog(now: Date): string {
  const today = day(now);
  return `# Anorvis LLM Wiki Log

> Append-only record of Anorvis wiki operations.
> Format: \`## [YYYY-MM-DD] action | subject\`

## [${today}] create | LLM Wiki initialized
- Created initial Anorvis LLM Wiki structure.
`;
}

export function initCache(now: Date): string {
  void now;
  return `# Anorvis LLM Wiki Cache

> Short working cache for fast orientation. Not source of truth.

## Current focus
- Initial Anorvis LLM Wiki scaffold.

## Recent decisions
- Anorvis uses an Obsidian-compatible LLM Wiki pattern.
- Raw sources and compiled wiki pages are separate.

## Open questions
- None yet.
`;
}

export function initOverview(now: Date): string {
  void now;
  return `# Anorvis LLM Wiki Overview

Anorvis LLM Wiki is an agent-maintained knowledge base compiled from raw sources, sessions, linked user vaults, integrations, and user-approved context.

Use \`index.md\` to navigate compiled pages, \`log.md\` to inspect history, and \`cache.md\` for recent context.
`;
}
