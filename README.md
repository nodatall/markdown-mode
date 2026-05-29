# Markdown Mode
A local-first markdown editor and viewer for working with AI.

{==Open one markdown file on your machine. Review it, comment on it, and suggest edits.==}{>>What does this mean?<<}{id="c1" by="user" at="2026-04-30T20:18:51.163Z"}

Paste this into your coding agent:

```text
Install Markdown Mode for me using `npm i -g markdownmode`, then read https://roughdraft.md/setup.md and set yourself up to use it.
```

Or install and open a file yourself:

```bash
npm i -g markdownmode
markdownmode open /absolute/path/to/file.md
```
## What is this?
Markdown Mode is a local-first markdown editor and viewer that runs on your computer.

Its job is to make markdown files easy to open, read, edit, review, and discuss with your AI agent without moving them into a proprietary format or a hosted app.

Markdown Mode opens a single markdown file directly for CriticMarkup comments and suggested changes.
## How it works
- **Local-first markdown editor** — Open normal `.md` files from your machine and edit them directly
  
- **Works with your AI agent** — Tell your local agent to open a file in Markdown Mode on your computer, then keep collaborating from there
  
- **Comments & suggested changes** — Use CriticMarkup for inline feedback, revisions, and review conversations
  
- **Markdown files on disk** — Everything stays as regular markdown files you can also edit in VS Code, Vim, Cursor, or anywhere else
  
- **No cloud, no account, no telemetry** — Runs entirely on your machine
  
## Quick start
Install Markdown Mode and start the local server:

```bash
npm i -g markdownmode
markdownmode start
```

`markdownmode start` runs Markdown Mode in the background, reuses or chooses a free localhost port, writes server state to `~/.markdownmode/server.json`, prints the active URL, and exits while the server keeps running.

Open a specific markdown file:

```bash
markdownmode open ./path/to/my-essay/draft.md
```

For scripts and agents that need a URL without launching a browser:

```bash
markdownmode open ./path/to/my-essay/draft.md --print-url
markdownmode status --json
```

Check or stop the background server:

```bash
markdownmode status
markdownmode stop
```

`markdownmode open` will reuse the running server and auto-start it if needed. You can also use `markdownmode ./path/to/file.md` as a shortcut when the input clearly looks like a path.

Markdown Mode does not edit `~/CLAUDE.md`, `~/AGENTS.md`, or other user-level agent files. The setup prompt asks your agent to update its own guidance.

If the local server is already running, you can also open a file directly by URL:

```text
http://localhost:7373/?path=/absolute/path/to/my-essay/draft.md
```

That makes an agent-friendly workflow possible:

1. Your AI writes or updates markdown files on disk.
  
2. You tell it to open a markdown file in Markdown Mode.
  
3. Markdown Mode opens locally on your machine.
  
4. You read, edit, leave comments, and suggest changes.
  
5. When you submit a comment, Markdown Mode saves that comment and sends that specific request to the configured agent workflow. If no agent adapter is available, use the copy-prompt button to paste the feedback into an agent yourself.
  

The normal open command returns after opening the file:

```bash
markdownmode open ./path/to/my-essay/draft.md --json
```

`markdownmode open` starts or reuses the local server, opens the document, and returns control to the caller. If `CODEX_THREAD_ID` is present, Markdown Mode passes it as transient session context so submitted comments can be associated with that origin thread. Use `--detached` to ignore that environment value, or `--origin-thread-id <id>` to pass one explicitly.

The old blocking review-event flow remains available for compatibility:

```bash
markdownmode open ./path/to/my-essay/draft.md --watch --json
markdownmode watch ./path/to/my-essay/draft.md --json
```

`--watch` waits for a legacy `review.completed` event. New agent-comment task endpoints are the primary product path.

Experimental MCP clients can start the stdio server with:

```bash
markdownmode mcp
```

The MCP server exposes tools to read the review index, list pending feedback, watch review events, use legacy reply helpers, and mark items resolved. CriticMarkup in the Markdown file remains the durable source of truth.
## Local development
```bash
./scripts/setup.sh
./scripts/run.sh
```

`./scripts/setup.sh` installs workspace dependencies and builds the app and server. `./scripts/run.sh` serves the built app at `http://localhost:7373`.

The two scripts coordinate through a lock file, so it's safe to start `./scripts/run.sh` while `./scripts/setup.sh` is still in progress. `run` will wait for setup to finish, or trigger setup itself if nothing has been built yet.

If you prefer package scripts, the same commands are available as `pnpm setup` and `pnpm start`.

Running `pnpm setup` also installs a per-worktree dev CLI wrapper into `~/.local/bin` by default, using the current worktree directory name. For example, this checkout might install `markdownmode-dev-lyon-v2`, which points at this worktree's local code while leaving the published global `markdownmode` command untouched.

Each dev wrapper keeps its own server state under `~/.markdownmode/dev/<wrapper-name>` by default, so opening a file from one worktree will not accidentally reuse a backend started from another worktree. `markdownmode-dev-<worktree> open ...` can start its own background server as needed; you do not need to run `pnpm dev` first just to open files in Markdown Mode.

You can refresh that wrapper manually with:

```bash
pnpm dev:install-cli
pnpm dev:install-cli --name api-redesign
```

Quality checks:

```bash
pnpm lint
pnpm test
pnpm check
```

`pnpm check` is the same command the pull request workflow runs before merge.
## Publishing
Markdown Mode publishes from `main` when the root `package.json` version is newer than the current npm `latest` version.

Release flow:

1. Bump the root `package.json` version in a pull request.
  
2. Merge the pull request to `main`.
  
3. The `Publish to npm` GitHub Actions workflow runs `pnpm check`, publishes the package if that exact version is not already on npm and is newer than `latest`, then creates a `v<version>` git tag.
  

The workflow uses npm trusted publishing, so npm must be configured with this trusted publisher:

```text
Owner: Lex-Inc
Repository: roughdraft
Workflow filename: publish.yml
```

No `NPM_TOKEN` secret is required.
## Files on disk
```
my-essay/
  draft-1.md            # A normal markdown file on disk
  draft-2.md            # Another file you can open separately
```

Markdown Mode reads and writes the markdown file directly.
## Agent setup
If you want your local agent to remember the Markdown Mode workflow, ask it to read the live setup prompt:

```text
Install Markdown Mode for me using `npm i -g markdownmode`, then read https://roughdraft.md/setup.md and set yourself up to use it.
```

Use `markdownmode help`, `markdownmode help agent`, or `markdownmode help criticmarkup` if you need a local refresher.
## CLI reference
```text
markdownmode [flags] <command> [args]
markdownmode <path>
```

Commands:

```text
open <path>        Open one Markdown file
start              Start or reuse the background server
status             Show server status
stop               Stop the managed background server
watch <path>       Wait for a Done Reviewing event
mcp                Start the experimental stdio MCP server
doctor [path]      Diagnose setup or validate Markdown
help agent         Print the agent setup prompt
help criticmarkup  Show CriticMarkup examples
agent-setup        Print the agent setup prompt
criticmarkup       Show CriticMarkup examples
```

Global flags:

```text
-h, --help         Show help
--version          Print version
--json             Print JSON for supported commands
--no-color         Disable color
```

Useful command flags:

```text
markdownmode open <path> --no-open
markdownmode open <path> --print-url
markdownmode open <path> --json
markdownmode open <path> --watch
markdownmode open <path> --detached
markdownmode open <path> --origin-thread-id <id>
markdownmode start --port <port>
markdownmode status --json
markdownmode stop --all
markdownmode watch ./draft.md --json
markdownmode doctor --json
markdownmode doctor ./draft.md
markdownmode doctor ./draft.md --json
```

Usage errors return exit code `2`. Runtime failures return exit code `1`. `markdownmode status --json` returns exit code `0` even when the JSON says `"running": false`.

Supported environment variables:

```text
ROUGHDRAFT_PORT
  Preferred server port.

PORT
  Legacy preferred server port. Used only when ROUGHDRAFT_PORT is unset.

ROUGHDRAFT_NO_OPEN=1
  Disable browser/app opening.

ROUGHDRAFT_STATE_FILE
  Exact path to the server state JSON file.

ROUGHDRAFT_STATE_DIR
  Directory containing server.json.
```

Development-only environment variables:

```text
ROUGHDRAFT_DEV_FRONTEND_STATE_FILE
ROUGHDRAFT_DEV_BIN_DIR
ROUGHDRAFT_DEV_STATE_BASE_DIR
ROUGHDRAFT_DEV_WRAPPER_NAME
ROUGHDRAFT_DEV_WRAPPER_PATH
ROUGHDRAFT_DEV_WRAPPER_REPO_ROOT
```
## Roughdraft-flavored CriticMarkup
Markdown Mode uses [CriticMarkup](https://criticmarkup.com) as the readable review layer inside normal Markdown files. It supports the standard markers for comments, highlights, insertions, deletions, and substitutions:

The canonical Roughdraft Flavored Markdown spec is published at [roughdraft.md/spec/roughdraft-flavored-markdown.md](https://roughdraft.md/spec/roughdraft-flavored-markdown.md). The review-index JSON Schema is published at [roughdraft.md/spec/roughdraft-flavored-markdown.schema.json](https://roughdraft.md/spec/roughdraft-flavored-markdown.schema.json).

```markdown
This is {--deleted--} text.
This is {++inserted++} text.
This is {~~old~>new~~} substituted text.
This is {>>a comment<<} in the margin.
This is {==highlighted==} text.
```

Markdown Mode extends those markers with compact attribute blocks so review state can round-trip through the file. Attribute blocks are written immediately after the comment or suggestion:

```markdown
Please revisit {==this sentence==}{>>Needs a source<<}{id="c1" by="user" at="2026-04-28T12:00:00.000Z"}.
```

Supported attributes:

- `id` gives the comment or suggested change a stable document-local id.
  
- `by` records the reviewer or agent that created it.
  
- `at` records an ISO timestamp.
  
Suggested changes can also carry ids:

```markdown
Add {++one concrete example++}{id="s1" by="AI" at="2026-04-28T12:10:00.000Z"}.
Remove {--vague phrasing--}{id="s2" by="user" at="2026-04-28T12:13:00.000Z"}.
Use {~~rough~>specific~~}{id="s3" by="AI" at="2026-04-28T12:14:00.000Z"} wording.
```

CriticMarkup inside inline code and fenced code blocks is treated as literal example text, not live review feedback:

````markdown
Inline code stays literal: `{==not a comment==}`.

```text
{++not a suggestion++}
```
````

This matters because the main workflow is often:

- The AI writes a doc
  
- The user opens it in Markdown Mode
  
- The user leaves comments and suggested changes
  
- The AI reads those comments and responds in the same markdown file
  
## Try the demo
Don't want to install anything? Try the [live demo](https://roughdraft.md) — it runs entirely in your browser using local storage.
## License
MIT

* * *

Built by [Nathan Baschez](https://twitter.com/nbashaw)
