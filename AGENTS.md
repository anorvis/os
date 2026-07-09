# Anorvis OS Agent Guide

This file records durable engineering preferences. Keep transient project status, change plans, and endpoint inventories out of this file.

## Naming

Use Go-style naming with Google TypeScript guardrails, biased toward Go.

- Prefer short, direct, context-aware names.
- Name length grows with scope and distance from declaration to use.
- Use short locals freely when route/function context is clear: `id`, `db`, `tx`, `env`, `ctx`, `req`, `res`, `url`, `body`, `input`, `err`, `row`, `i`.
- Use fuller names for exported APIs, persisted fields, schemas, broad scopes, and ambiguous values.
- Avoid ambiguous private dialect abbreviations: no `provConn`, `calEvt`, `hlthDash`, `finAcct`.
- Avoid type noise. Prefer `meal`, `tasks`, `provider`, `body`; avoid `mealObject`, `taskArray`, `providerString`, `parsedJsonValue`.
- Avoid redundant context. Inside a clearly scoped capability or route module, prefer the local concept name: `meal`, `task`, `id`, `input`.
- Prefer direct verbs: `get`, `list`, `save`, `sync`, `read`, `write`, `parse`.
- Do not create generic buckets named `utils`, `helpers`, `common`, or `misc` unless there is no more specific capability, product, platform, or domain home.

## TypeScript and Effect

- Keep TypeScript strict and boring.
- Use Effect for schemas, decoding, typed errors, workflows, and service logic where it improves correctness.
- Do not add duplicate validation libraries when existing `effect/Schema` code is the right fit.
- Do not encode information in a variable name that TypeScript already carries in the type.
- Prefer explicit boundary decoding over trusting external JSON.

## Architecture Principles

Separate mechanics, reusable capabilities, and product-specific read models.

- Platform code owns transport, auth, status, process lifecycle, CORS, gateway composition, and event streaming.
- Capability code owns durable data and actions that another product could reuse without inheriting one UI's assumptions.
- Product code owns composed views, dashboards, and UX-shaped read models.
- Dashboard/projection endpoints should not be modeled as shared capabilities just because they read shared data.
- Durable records/actions should not live under product-specific modules just because one product is the first consumer.
- Do not put domain behavior under a gateway module. Gateways compose and expose; they do not own product or capability logic.

## Routing

- Use the repo's router for HTTP route matching, method/path params, middleware, CORS, and Fetch-compatible dispatch.
- Keep schema decoding, typed errors, and service workflows outside route matching details.
- Preserve public API paths unless the task explicitly includes an API contract change.
- Prefer route context and named path params over regex match locals.
- Route handlers should be thin: decode input, call capability/product logic, map expected errors to HTTP responses.

## Toolkit Metadata

Agent-callable OS actions are exposed through `src/platform/toolkit`.

- Put toolkit metadata beside the capability route it exposes, e.g. `src/capability/task/toolkit.ts`.
- Export arrays named `<capability>ToolkitTools`.
- Add those arrays to `src/platform/toolkit/manifest.ts`; do not use runtime filesystem scanning.
- Tool names use `anorvis_<verb>_<noun>`, e.g. `anorvis_create_task`, not product-page names like `anorvis_life_task_create`.
- Avoid storage verbs like `upsert` in tool names. Use user-intent verbs such as `create`, `update`, `complete`, `delete`, `list`, `read`, `start`, or `stop`.
- Keep product/domain labels in metadata (`domain: "life"`), not in the tool name.
- Expose only curated, user-intent actions. Never reflect every HTTP route automatically.
- Derive `parameters` from Effect schemas with the platform toolkit helper where possible; do not hand-copy JSON Schema for route bodies.
- Add small toolkit-specific Effect schemas for combined tool inputs, such as route `id` path params plus body fields.
- Describe schema fields with Effect annotations so generated tool parameters tell the agent what `id`, dates, and timestamps mean.
- Metadata must include a stable `id`, `name`, `label`, `description`, `domain`, `operation`, `resource`, `mutates`, `method`, `path`, and strict `parameters` schema.
- Use `pathParams` for `:id`-style route parameters and `queryParams` for GET filters.
- Keep schemas strict with `additionalProperties: false`.
- Platform toolkit aggregates and serves metadata; capabilities own their own action metadata.

## Toolkit Context Safety

- Keep `anorvis_tool` as the small always-active OS toolkit router.
- Do not leave every Anorvis action tool active by default.
- Register action tools from the toolkit manifest, then keep them inactive until selected by `anorvis_tool`.
- `anorvis_tool` should take structured intent (`operation`, `resource`, optional `query`/time range), not a free-text request that the extension must classify.
- Let the main model classify user intent; the extension should only do deterministic retrieval, candidate matching, read execution, and tool activation.
- Include read actions in toolkit metadata (`list_tasks`, `list_calendar_events`, `read_life_snapshot`) so `anorvis_tool` can answer questions and resolve existing records before mutations.
- `anorvis_tool` may execute read-only actions internally and return compact results.
- For mutations, `anorvis_tool` should activate only the precise action tools needed for the current request.
- Keep transient action tools active through the current agent run so retries and batch operations work; deactivate them at an agent-end or next-user-message boundary.
- Do not inject the full toolkit manifest into chat context or the system prompt.
- Add `promptSnippet` and `promptGuidelines` sparingly; action tools should carry precise schemas, not long prompt text.
