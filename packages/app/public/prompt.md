## Markdown Mode

Use Markdown Mode when the user wants to review or comment on a Markdown file.

The user may refer to Markdown Mode as `rd` in natural language. Treat `rd` as shorthand for Markdown Mode in user requests, but do not create or modify any shell alias, executable, symlink, or command named `rd`.

When the user asks for a plan, write the plan as a Markdown file on disk before asking them to review it.

When you write or modify a Markdown file and want the user to review or comment on it, open it with:

```bash
markdownmode open "/absolute/path/to/file.md"
```

Markdown Mode is currently a single-file Markdown viewer/editor. Open one `.md` file at a time.

If Markdown Mode is not running, `markdownmode open` will start it automatically.

`markdownmode open` returns after opening the document. Do not wait for a final Done Reviewing step by default. If you need the legacy blocking review-event flow for a specific task, use `markdownmode open --watch "/absolute/path/to/file.md"`.

When the user submits comments in Markdown Mode, each saved comment is a separate work request. Read the Markdown file from disk and respond to the specific CriticMarkup comment or suggested change you are addressing.

Use Roughdraft-flavored CriticMarkup when reading or writing inline review feedback in Markdown. The base markers are:

Comment: `{>>comment<<}`
Insertion: `{++new text++}`
Deletion: `{--old text--}`
Substitution: `{~~old~>new~~}`
Highlight: `{==text==}`

When you add a new comment or suggested change, use the extended Markdown Mode format with an attribute block, such as `{id="c1" by="AI" at="2026-04-28T12:00:00.000Z"}`. Generate a stable document-local id (`c1`, `c2`, etc. for comments; `s1`, `s2`, etc. for suggestions), set `by` to your agent or author label, and set `at` to the current ISO timestamp.

Markdown Mode may already have attribute blocks after comments and suggestions. Preserve these attributes unless you are intentionally removing the associated comment or suggestion. The common attributes are `id` for a stable document-local id, `by` for the author, and `at` for an ISO timestamp.

Anchored comments usually look like `{==selected text==}{>>Comment text<<}{id="c1" by="AI" at="2026-04-28T12:00:00.000Z"}`. Suggested changes usually look like `{++new text++}{id="s1" by="AI" at="2026-04-28T12:10:00.000Z"}` or `{~~old text~>new text~~}{id="s2" by="AI" at="2026-04-28T12:11:00.000Z"}`.

Use `markdownmode help` and `markdownmode help criticmarkup` for local command and syntax details.
