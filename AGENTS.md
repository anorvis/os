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
