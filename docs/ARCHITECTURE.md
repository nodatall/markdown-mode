# Architecture

## Purpose

This file records the current Roughdraft module boundaries and the rules agents should follow when changing them. Read it before changing server routes, CLI behavior, document session state, Markdown serialization, app storage backends, or agent integration.

## Current System Shape

Roughdraft is a local Markdown review app with three runtime surfaces:

- A browser/Tauri frontend in `packages/app`.
- A local Express server and CLI in `packages/server`.
- Shared Roughdraft-flavored Markdown parsing and mutation helpers in `packages/rfm`.

The product unit is one resolved Markdown file. The server may hold transient process-local state for native open sessions, live sessions, open requests, review events, remote documents, and agent comment task state, but the Markdown file remains the durable document.

## Module Map

### `packages/rfm`

- Path: `packages/rfm/src`
- Responsibility: Parse, validate, index, and minimally mutate Roughdraft-flavored Markdown.
- Public API or entrypoint: Package exports from `packages/rfm/src/index.ts`.
- May depend on: TypeScript standard library only.
- Must not depend on: React, Express, Tauri, filesystem state, CLI state, Codex APIs, browser APIs, or app/server implementation modules.

### `packages/app`

- Path: `packages/app/src`
- Responsibility: Render and edit one Markdown document, save through a `StorageBackend`, display CriticMarkup comments and suggestions, and submit comment tasks through backend capabilities.
- Public API or entrypoint: `App.tsx`, `PageCard.tsx`, `DocumentWorkspace.tsx`, and the `StorageBackend` interface in `storage.ts`.
- May depend on: `@roughdraft/rfm`, React, Tiptap, CodeMirror, shadcn-style local UI primitives, browser APIs, Tauri bridge wrappers, and backend interfaces.
- Must not depend on: Node-only APIs, Express internals, server route implementation details beyond documented HTTP contracts, or Codex app-server protocols directly.

### `packages/server`

- Path: `packages/server/src`
- Responsibility: Serve the built app, resolve and edit local Markdown files, host transient document sessions, expose HTTP APIs, manage review-event compatibility, submit agent comment tasks through adapters, and provide the CLI entrypoint.
- Public API or entrypoint: `createApp()` in `index.ts` and `runCli()` / bin wrapper in `cli.ts`.
- May depend on: Node APIs, Express, `@roughdraft/rfm`, local adapter modules, and Codex CLI/app-server protocols at the integration edge.
- Must not depend on: React component internals, Tauri runtime APIs, browser globals, or frontend state.

### `src-tauri`

- Path: `src-tauri`
- Responsibility: Package the native macOS app shell, bridge local file open/save commands to the frontend, and consume short-lived CLI native-open metadata.
- Public API or entrypoint: Tauri command handlers in `src-tauri/src`.
- May depend on: Rust/Tauri APIs and local OS file dialogs/events.
- Must not depend on: Express route internals or Markdown parser implementation details.

### `docs/spec`

- Path: `docs/spec`
- Responsibility: Document Roughdraft-flavored Markdown and UI states that should be captured for visual review.
- Public API or entrypoint: Markdown spec docs, JSON schema, screenshot guide.
- May depend on: Product decisions, ADRs, and observable UI behavior.
- Must not depend on: Private implementation details that are not product contracts.

## Dependency Rules

- Dependency direction should flow from runtime shells into stable contracts: CLI/server/app may call `packages/rfm`; `packages/rfm` must not call back into them.
- The frontend talks to storage and agent behavior through `StorageBackend`, not by importing server modules.
- The server owns route validation, filesystem boundaries, transient session/task state, and adapter wiring.
- Native `markdownmode open` starts or reuses the local server, writes short-lived handoff metadata under `~/.markdownmode`, and opens `Markdown Mode.app`; the visible product path is not a browser URL.
- Agent integration belongs at the server edge behind an adapter interface. Core Markdown parsing and frontend editing must not know whether Codex app-server, a fake adapter, or no adapter is active.
- Thread/session metadata is transient launch or server state. Do not write it into Markdown or CriticMarkup attributes.

## Composition Roots And Runtime Entrypoints

- `packages/server/src/index.ts` composes Express routes, local file resolution, transient document sessions, review-event compatibility, and agent comment task services.
- `packages/server/src/cli.ts` composes CLI commands, server startup/reuse, native app opening, and launch metadata.
- `packages/app/src/detect-backend.ts` chooses the frontend backend at runtime.
- `packages/app/src/App.tsx` composes the selected backend with document loading and workspace state.
- `src-tauri/src/lib.rs` composes native file-open behavior, transient session consumption, and frontend events.

## Shared Code Rules

- Put Markdown format policy in `packages/rfm`.
- Put browser UI state in `packages/app`.
- Put route, filesystem, and adapter code in `packages/server`.
- Add shared types only when at least two real boundaries consume them or when they are the public contract for a package/module.
- Avoid generic utility modules unless the behavior has a clear owner and a specific test surface.

## Testing Boundaries

- `packages/rfm`: fixture and round-trip tests for parser/mutation behavior.
- `packages/server`: route, CLI, queue, adapter, auth, and filesystem-boundary tests.
- `packages/app`: component and interaction tests for editor, rail, storage backend, and visible state transitions.
- Playwright smoke tests cover full browser flows when routing, server/app integration, or visual interaction is the risk.
- Tauri/native changes need a macOS build and, when practical, manual launch verification.

## Architecture Checks

- `pnpm lint` checks formatting and lint rules.
- `pnpm test:selectors` checks UI test selector discipline.
- `pnpm test` covers package test suites.
- `pnpm test:smoke` covers browser smoke flows.
- Boundary-affecting changes should update this file and any affected ADR in the same work item.

## Accepted Deviations

- `packages/server/src/index.ts` currently owns several route families and transient maps in one file. This is accepted until route growth makes extraction lower risk than locality.
- The old `review-events` wait path remains for compatibility while the agent-comment task path becomes the primary product flow. It should not be expanded with new product behavior.
