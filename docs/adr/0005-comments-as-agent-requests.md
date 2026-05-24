# 0005: Comments As Agent Requests

## Context

Roughdraft originally supported a blocking review loop: an agent opened a Markdown file, waited for the user to click Done Reviewing, then resumed after a `review.completed` event. The desired product flow is different. Users should be able to open a Markdown file, add comments, and have each submitted comment become an agent work request without keeping the originating thread blocked.

## Decision

Roughdraft treats a submitted comment as an agent comment task. The task is scoped to one resolved Markdown file and one CriticMarkup item id.

There are two session modes:

- `detached`: the file was opened normally and has no originating agent thread. If an agent adapter is available, Roughdraft may start a new agent job for the submitted comment. If no adapter is available, Roughdraft exposes a copy-paste prompt fallback.
- `attached`: the file was opened with transient origin metadata, such as a Codex thread id. If an agent adapter is available, Roughdraft may submit the comment task back to that context without making the original thread wait.

The Markdown file stores user feedback as Roughdraft-flavored CriticMarkup. Agent/session metadata such as thread ids, adapter state, task state, queue state, or app-server handles is transient server/app state and must not be serialized into the Markdown file.

## Consequences

The primary UI should submit one saved comment at a time. It should not require a final Done Reviewing click.

The CLI should open a file and return by default. Blocking wait behavior can remain as an explicit compatibility command or flag, but it is not the primary `open` behavior.

The server needs a typed task boundary for comment submission, task status, session mode, and adapter capability. The adapter boundary lets tests use a fake adapter and lets production wire Codex only when the local Codex App Server contract is verified.

When a submitted comment is applied by an agent, Roughdraft should remove or resolve only that handled comment and leave unrelated comments intact.

## What This Explicitly Does Not Mean

This does not make Roughdraft a chat transcript store, project database, multi-file task manager, or durable agent job system.

This does not put Codex thread ids or other agent runtime metadata into CriticMarkup attributes.

This does not require Roughdraft to solve stale anchor re-mapping in the first version. If a background agent edit changes text another pending comment highlighted, the saved Markdown remains the source of truth.
