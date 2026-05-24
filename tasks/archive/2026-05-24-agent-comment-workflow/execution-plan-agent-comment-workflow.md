# Agent Comment Workflow
Goal: Make Roughdraft comments act as agent work requests without requiring a waiting review thread or a final Done Reviewing step.

Please review this in Roughdraft before I start. Tell me what is wrong, missing, or out of order.

Deliver implementation instruction: When asked to implement this doc, load the `$deliver` skill, use this file as the approved execution plan, scan every checkbox, and continue through final review, archive movement, commit, and finalization before the final handoff.

Implementation note: The production Codex App Server adapter remains behind a server-side seam and defaults to an explicit unavailable capability because no reachable, verified local App Server endpoint was available in this checkout. The fake adapter is test/development-only via injection or `ROUGHDRAFT_AGENT_ADAPTER=fake`; the UI surfaces the unavailable state and copy-prompt fallback instead of pretending real agent execution is wired.
## What We Know
- The current product direction has two modes: attached thread mode for files opened from an existing agent context, and detached file mode for normal Markdown files opened on their own.
  
- The user does not want a review-wait flow. Opening a file should not block the originating thread while the user comments.
  
- A submitted comment should be treated as a command. The app should save the comment, send that specific comment to the right agent context, and keep the rest of the document editable.
  
- The repo currently has a watcher-oriented `review.completed` event, a Done Reviewing button, and CLI default behavior that waits after `roughdraft open`.
  
- ADRs preserve three important boundaries: one resolved Markdown file is the unit of work, CriticMarkup stays in the Markdown file as the portable feedback format, and CLI/server state is not a persistent document database.
  
- Submitting a comment task is write-capable because it can lead to agent edits, so it must follow the existing local trust and `ROUGHDRAFT_TOKEN` rules when the server is reachable beyond loopback.
  
- The exact Codex App Server API surface for starting or resuming agent work must be verified locally before hardcoding a production adapter.
  
## Steps
### 1. Record the architecture contract
Goal: Make the new app/server/CLI/agent boundary explicit before changing behavior.

Decision notes:

- [x] 
  
  Session metadata can be transient server/app state. It should not be written into the Markdown file unless it is normal Roughdraft CriticMarkup feedback.
  
- [x] 
  
  Thread identity should be treated as launch/session context, not as part of the document format.
  
- [x] 
  
  Done Reviewing can remain as a legacy command only if it is no longer the main product path.
  
- [x] 
  
  Add `docs/ARCHITECTURE.md` for the current Roughdraft boundaries: app, server, CLI, storage backend, document sessions, review/comment markup, and agent integration.
  
- [x] 
  
  Add or update an ADR for comments-as-agent-requests, including attached versus detached mode and the rule that agent/session metadata is transient.
  
- [x] 
  
  Rename product concepts in the plan and code path away from "review handoff" where they now mean "submit this comment to an agent."
  
### 2. Define the session and task model
Goal: Replace the Done-review event shape with a per-comment task shape.

- [x] 
  
  Add a typed document session model with `detached` and `attached` modes, resolved file path, project path when available, optional origin thread/session id, and adapter capability flags.
  
- [x] 
  
  Add a typed agent-comment task payload with comment id, comment text, selected text/reference data, file path, project path, saved document version or mtime, mode, and optional origin thread/session id.
  
- [x] 
  
  Add server endpoints for reading session capability, submitting one comment task, and reading or streaming task state.
  
- [x] 
  
  Apply the existing token/auth boundary to any endpoint that can submit work or expose attached thread/session metadata.
  
- [x] 
  
  Keep the existing review-event watch path only as compatibility while the new task path is wired through the app and CLI.
  
### 3. Change CLI open behavior
Goal: Opening a Markdown file should show the app and return control unless the caller explicitly asks for legacy waiting.

- [x] 
  
  Change `roughdraft open <file>` so it starts or reuses the server, opens the file, records any provided origin metadata, and does not wait by default.
  
- [x] 
  
  Keep an explicit legacy wait command or flag for workflows that still need blocking behavior, with help text that no longer describes waiting as the primary open behavior.
  
- [x] 
  
  Add attached-mode CLI flags or environment handling after verifying the local Codex thread/session metadata that can actually be passed safely.
  
- [x] 
  
  Update CLI help, examples, and tests so the default mental model is "open this file" rather than "open and wait for Done Reviewing."
  
### 4. Wire the app to comment tasks
Goal: The UI should submit the comment the user just added while leaving other comments and edits alone.

- [x] 
  
  Remove Done Reviewing as the primary visible action in the document toolbar or review rail.
  
- [x] 
  
  Replace watcher status with session status: detached file, connected to originating thread, submitting, working, applied, or needs attention.
  
- [x] 
  
  Submit only the newly saved comment when the user clicks Add on the comment box.
  
- [x] 
  
  Keep unsent draft comments local until the user adds them, and keep already submitted comments visible while work is in progress.
  
- [x] 
  
  Preserve the current no-replies interaction model and do not reintroduce reply-specific controls.
  
- [x] 
  
  Keep the copy-prompt fallback for detached files when no agent adapter is available, but make it secondary to the agent-submit path when the adapter is available.
  
- [x] 
  
  Update `docs/spec/ui-state-screenshot-guide.md` for any new or removed visible states.
  
### 5. Add the agent adapter seam
Goal: Make Codex integration replaceable and testable before relying on the real app server.

- [x] 
  
  Add a small server-side adapter interface for "submit this comment task to an agent."
  
- [x] 
  
  Implement a fake/local adapter for tests and development that records submitted tasks and can simulate accepted, working, applied, and failed states.
  
- [x] 
  
  Verify the available Codex App Server or local connector API before implementing the real adapter.
  
- [x] 
  
  If no verified real adapter API exists, stop with the exact missing capability instead of shipping the fake adapter as the finished integration.
  
- [x] 
  
  Implement attached mode so a task with origin thread/session metadata resumes or notifies that context when the capability exists.
  
- [x] 
  
  Implement detached mode so a task without origin metadata starts a fresh agent job against the file/project when the capability exists.
  
- [x] 
  
  Surface adapter failures in the UI without deleting the saved CriticMarkup comment.
  
### 6. Handle file updates and first-version concurrency
Goal: Keep the first implementation predictable without solving stale anchors yet.

Decision notes:

- [x] 
  
  If an agent changes the text that another pending comment highlighted, ignore re-anchoring in this version and keep the comment's saved Markdown as the source of truth.
  
- [x] 
  
  Per-file serialization is acceptable for the first version if it prevents conflicting agent edits.
  
- [x] 
  
  Save the Markdown file before submitting a comment task.
  
- [x] 
  
  Refresh the document when the file changes after an agent applies edits.
  
- [x] 
  
  Serialize or queue agent comment tasks per file unless the adapter proves it can safely handle parallel writes.
  
- [x] 
  
  When an agent applies a submitted comment, remove or resolve only that handled comment's CriticMarkup and leave unrelated comments intact.
  
- [x] 
  
  Preserve unsent draft comments and newly selected text while background file refreshes happen.
  
- [x] 
  
  Add a visible needs-attention state when a submitted task cannot be applied cleanly.
  
### 7. Validate the workflow
Goal: Prove the behavior at the fastest test level that still protects the real boundary.

- [x] 
  
  Add focused unit tests for task payload creation, session-mode handling, and the rule that thread/session metadata is not written into Markdown.
  
- [x] 
  
  Add server tests for session capability, comment-task submission, fake adapter state transitions, token/auth behavior, and compatibility with the old review-event endpoint while it remains.
  
- [x] 
  
  Add CLI tests proving `open` no longer waits by default and explicit wait behavior still works when requested.
  
- [x] 
  
  Add app interaction tests for detached mode, attached mode, submitting one comment, no Done Reviewing primary action, and copy-prompt fallback.
  
- [x] 
  
  Add round-trip or fixture coverage for CriticMarkup comments created by this workflow.
  
- [x] 
  
  Run `pnpm check`, `pnpm test:smoke`, and the narrow package tests touched by the implementation.
  
- [x] 
  
  Build and reinstall the macOS app only after tests pass, then open a test Markdown file for manual verification.
