# Codex Thread Comment Workflow

Goal: Make comments submitted from the native Markdown Mode app start hidden Codex app work that has the originating thread context and updates the Markdown file.

Please review this before I start.
Tell me what is wrong, missing, or out of order.

Deliver implementation instruction:
When asked to implement this doc, load the `$deliver` skill, use this file as the approved execution plan, scan every checkbox, and continue through final review, archive movement, commit, and finalization before the final handoff.

## What We Know

- The product flow is one Markdown file, with comments saved as CriticMarkup in that file.
- The old blocking review wait path is legacy. The main flow is one submitted comment becoming one agent request.
- The old web URL path can pass `originThreadId`, but this plan should move thread handoff into the native app flow instead of preserving the web UI as a product path.
- The native app uses `TauriBackend`, so it cannot currently call the server-side agent comment endpoints.
- The server owns the agent adapter boundary. A Codex-attached native open therefore still needs a local server session, even though the visible window is the macOS app.
- The current production adapter is intentionally unavailable because the Codex app-server task API has not been verified yet.
- Thread ids and task runtime state must stay transient. They must not be written into Markdown or CriticMarkup metadata.

## Steps

### 1. Preserve and finish the native open behavior

- [x] Keep the current CLI change that opens `Markdown Mode.app` for normal local opens.
- [x] For CLI-origin native opens, start or reuse the local Markdown Mode server before opening the app so the server-side adapter remains available.
- [x] Make the native-open path preserve the originating Codex app thread id instead of dropping it when macOS opens the file.
- [x] Remove browser launching from the normal CLI open path and make native app opening the only supported local UI path.
- [x] Rework or remove URL/browser-only flags and help text so the CLI no longer presents browser mode as part of the product flow.
- [x] Add or update CLI tests that prove native opens start or reuse the server, open the native app, carry thread metadata when `CODEX_THREAD_ID` or `--origin-thread-id` is present, and do not launch a browser.

### 2. Add a transient native open session

Goal: Give the Tauri app more than a bare file path without putting session data in the Markdown file.

- [x] Add a local transient open-session handoff from the CLI to the app with file path, project path, server URL, origin thread id, and a short-lived session id.
- [x] Teach `src-tauri` to read that open-session data when the app receives a file-open event.
- [x] Include origin metadata in the `markdown-file-opened` payload and pending-open command result.
- [x] Update the Tauri frontend types so `TauriBackend` can remember the session metadata for the currently opened file.
- [x] Expire or overwrite stale open-session handoff data so opening the same file later does not inherit an old thread id.

### 3. Bridge the native app to comment-task submission

Goal: Let comments submitted in the macOS app use the same task flow as the server-backed agent adapter.

- [x] Add `getAgentCommentSession` and `submitAgentCommentTask` support to `TauriBackend` for CLI-origin sessions that include a server URL.
- [x] Reuse the existing task payload shape: document path, project path, relative path, file version, comment id, selected text, and optional origin thread id.
- [x] Route native task submission through the local server endpoints so frontend code stays behind `StorageBackend` and the server keeps ownership of the adapter boundary.
- [x] For Finder or Dock opens that have no server session, show detached/no-adapter state and the copy-prompt fallback instead of pretending comments can reach Codex context.
- [x] Keep the copy-prompt fallback visible when no real adapter is available.
- [x] Add app tests for attached native sessions, detached native sessions, and unavailable-adapter fallback.

### 4. Verify the Codex app-server adapter contract

Goal: Do not fake the most important part.

- [x] Find the local Codex app-server capability that can start hidden side work from an existing thread id.
- [x] Verify the request shape, required environment, and whether the side task can inherit thread context without posting into the visible chat.
- [x] Verify whether the capability is available from a background Markdown Mode server process, not only from this interactive Codex thread.
- [x] Record the verified contract in a small server-side adapter module instead of spreading Codex-specific calls through the app or Tauri code.
- [x] If the local Codex app-server capability is not reachable or not sufficient, keep the adapter unavailable and stop with the exact missing capability.

### 5. Implement the real task adapter when verified

Goal: A submitted comment should start work using the right context.

- [x] Add a Codex app adapter behind the existing `AgentCommentAdapter` interface.
- [x] In attached mode, submit the comment as hidden side work anchored to the originating thread id.
- [x] In detached mode, start a fresh agent task for the file when the verified capability supports it.
- [x] Include the file path, project path, comment id, selected text, and current Markdown context in the task prompt.
- [x] Return clear task states: accepted, working, applied, failed, or needs attention.
- [x] Keep the fake adapter for tests and development only.

### 6. Show per-comment working state

Goal: Make it obvious which submitted comment is being worked on.

- [x] When a comment task is accepted or working, replace that comment's numbered marker with a small loading spinner.
- [x] Change the submitted comment's highlight color while the task is working.
- [x] Restore the normal marker and highlight if the task fails or needs attention.
- [x] Remove or resolve the marker only when the task applies successfully and that specific comment is handled.
- [x] Add app tests for marker-to-spinner behavior and working highlight color.

### 7. Refresh the file after background work

Goal: The app should show the result of agent work without deleting unrelated feedback.

- [x] Keep saving the comment before task submission.
- [x] Refresh or poll the opened file after a task is accepted or working.
- [x] When a task applies a change, remove or resolve only that submitted comment and leave unrelated comments intact.
- [x] Preserve unsent draft comments while the file updates from disk.
- [x] Ignore stale-anchor remapping for this version.

### 8. Validate the complete path

- [x] Run focused server tests for task creation, adapter capability, attached mode, detached mode, and auth/token behavior.
- [x] Run focused app tests for comment submission state and copy-prompt fallback.
- [x] Run CLI tests for native app open, no-browser behavior, and thread metadata.
- [x] Build the Tauri app and manually open a test Markdown file from this Codex app thread.
- [x] Validate a context-dependent comment: set up prior thread context, submit a comment whose correct edit depends on that context, and verify the Markdown file changes according to the thread context rather than only the comment text.
- [x] Verify that submitting a comment either starts the real Codex side task or shows the exact unavailable-adapter reason with a working copy-prompt fallback.
- [x] Update `docs/ARCHITECTURE.md` and `docs/spec/ui-state-screenshot-guide.md` if the implementation changes the recorded boundary or adds a visible UI state.
- [x] Run `pnpm check` and `pnpm test:smoke` before final review.
