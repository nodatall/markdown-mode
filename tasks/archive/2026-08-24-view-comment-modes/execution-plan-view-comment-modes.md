# View and Comment Modes

## Goal

Make Markdown Mode feel like the current charcoal reader while giving it two clear interaction states: a clean View mode where links open normally, and a Comment mode for review work. Replace the normal Saved affordance with an icon-only mode control, keep one visible document title, remove the boxed document treatment, and widen the reading column by roughly one third.

## Review request

Please review the behavior decisions and the linked mockup before implementation. The plan now makes View the default and defines Comment as the current suggestion/comment behavior in rich text while preserving direct raw-Markdown editing in source view.

## Implementation instruction

Implement this plan using the repository's existing shadcn-style primitives and current neutral color tokens. Do not introduce a new visual theme. Preserve the Markdown/CriticMarkup round-trip contracts in ADRs 0001–0003 and the existing CLI/server state model in ADR 0004. Keep the change local to the current workspace, editor interaction, link handling, tests, and screenshot documentation.

## Context and settled behavior

- The control has exactly two icon-only choices in the top-right workspace chrome: an eye for View and a comment bubble for Comment. Tooltips, `aria-label`, `aria-pressed`, focus treatment, and a grouped accessible name provide the text that is intentionally absent visually.
- View maps to the existing internal `viewing` behavior and resets as the default whenever `activeDocumentPath` changes. It is read-only, hides every mutation surface and the review rail, and opens links directly through the existing external/local link resolver. Existing comment and suggestion marks remain rendered as document content, but their hover decoration, click activation, selected-thread state, and rail-presence reporting are all disabled in View.
- Comment maps to the existing internal `suggesting` behavior in rich text: selection can create comments, ordinary rich-text replacements become CriticMarkup suggestions, review items can be activated, and suggestion markup remains available. A mode change by itself must not alter the Markdown, create CriticMarkup, mark the document dirty, or trigger a save.
- Source view remains the explicit raw-Markdown escape hatch: it is read-only in View and directly editable in Comment, matching the current non-viewing source behavior. Source edits are raw Markdown changes rather than automatic CriticMarkup suggestions; this does not add a third interaction mode.
- In Comment mode, link clicks keep the current link popover so a reviewer can inspect or deliberately open the target without losing review context.
- A successful autosave is silent: the settled `saved + clean` state renders no status node, spacer, or live-region announcement. Unsaved, saving, and error states retain an accessible live status; stale-file conflicts remain in their existing actionable banner.
- The existing native/window title is the only visible filename and is reduced to the document basename. Do not add a second filename on the left. The eye/comment pair occupies the actual top-right location currently used by Saved and composes with the fixed status stack so actionable states cannot overlap it.
- Keep the existing rich/source and file-copy routes in a low-emphasis secondary utility cluster directly below the titlebar at the left edge of the reader. Remove their competing title/eye language: rich/source uses an action icon such as code/document rather than a second eye, and file actions use an icon-only overflow trigger rather than the filename. The native top-right contains exactly the two approved mode icons; neither secondary utility appears inside that pair.
- Keep the existing charcoal background, typography, and link accent. The document body sits directly on the workspace background with no new blue surface, border, card, or shadow.
- Increase the effective prose measure by 30–40%, not merely the outer card width. The current desktop prose is approximately `39.5rem` inside a `46.5rem` card; target approximately `53–55rem` of prose (about 34–39% wider) inside an approximately `62rem` transparent main column with comfortable side gutters. Record the computed before/after prose widths during visual verification. Expand the outer shell enough to hold that column plus the existing review rail in Comment mode, while retaining responsive single-column behavior on narrower windows.
- The rich/source editor view remains a separate existing concern; this change must not turn it into a third interaction mode or remove its current editing route.

## Visual mockup

[Open the interactive View/Comment mockup](./ui-mockup-view-comment-modes.html)

The mockup is a behavior and layout reference, not a new theme. It starts in View mode; the eye and comment icons switch the illustrative state.

## Implementation plan

- [x] Add the two-state workspace control and make mode state explicit.
  - Replace the three-option text selector in `packages/app/src/DocumentWorkspace.tsx` with two shadcn-style icon buttons using the existing tooltip primitive and stable test selectors.
  - Reset to View whenever `activeDocumentPath` changes, map the two visible states to `viewing` and `suggesting`, and preserve direct source editing only while Comment is active. Add a document-switching test so mode state cannot leak from one file to the next.
  - In View, gate comment/suggestion anchor listeners, highlight state, selected-thread state, review-rail rendering, and `onCommentRailPresenceChange`; switching to View clears any active review selection without altering the source.
  - Pass explicit View state into `packages/app/src/EditorContextMenu.tsx`; suppress formatting/link mutation controls, selection toolbars, right-click edit/paste menus, paste actions, and editing shortcuts while still allowing the direct link activation contract below.
  - Make the native/window basename the only title. Replace the in-document filename trigger with an icon-only overflow action and change the rich/source control so it does not display a second eye.
  - Make only the settled saved state render nothing while retaining unsaved, saving, error, conflict, and review-handoff status paths without layout overlap.
  - First add focused component tests for the default state, icon labels/pressed state, exact internal mapping, silent successful saves, actionable pending/failure states, no save/dirty/Markdown mutation on a mode-only change, and read-only versus raw-editable source behavior.
  - Add a rich-text test proving ordinary replacement in Comment becomes CriticMarkup, plus an existing-comment-and-suggestion fixture proving View has no hover/click activation or rail and Comment restores them. Add selection, right-click, paste, and editing-shortcut checks proving View exposes no mutation UI and does not change Markdown.

- [x] Make link behavior follow the selected interaction mode.
  - Pass the interaction mode to `packages/app/src/EditorContextMenu.tsx` rather than unconditionally intercepting every rendered link on `mousedown`.
  - Intercept only an unmodified primary click or keyboard activation. In View, `#anchor` targets move within the current document, while external, file, and resolved local-Markdown targets use the existing protected open path with `noopener,noreferrer`. Preserve native modifier-click and middle-click behavior.
  - In Comment, the same unmodified primary/keyboard activation preserves the current link popover and explicit Open Link action; modifier and middle clicks are not converted into a comment/popover action.
  - Add the smallest behavioral tests in `packages/app/test/page-card.test.tsx` for external, local Markdown, and `#anchor` View targets; one keyboard activation; modifier/middle-click preservation; and the Comment-mode popover.

- [x] Widen and simplify the reader without changing its visual language.
  - Update the repeated workspace and page width constraints in `packages/app/src/DocumentWorkspace.tsx` and `packages/app/src/PageCard.tsx` to one shared layout contract: an approximately `62rem` transparent main column with approximately `53–55rem` of measured prose, plus a larger outer maximum that still accommodates the review rail.
  - Remove the normal document card border/background/shadow while retaining transparent inner gutters, any intentionally bounded embedded-demo surface, and the existing comment-card treatment.
  - Verify long paragraphs, headings, lists, code blocks, tables, and URLs do not create horizontal overflow; preserve the existing mobile collapse and Comment-mode rail behavior.
  - Update `docs/spec/ui-state-screenshot-guide.md` for the two icon modes, direct-link View state, silent saved state, wider unboxed reader, and the removed three-mode selector.

- [x] Validate the feature at the component, browser, and repository boundaries.
  - Run the narrow workspace/page-card tests first, then the full app test suite with `pnpm --filter @roughdraft/app test`.
  - Run `pnpm check` and `pnpm test:smoke`.
  - Exercise a real file through the worktree-specific app/CLI in a browser: activate an external link and a local Markdown link in View, switch to Comment, create or activate a comment, switch back, and confirm the source file is unchanged unless an actual review edit was made.
  - Capture the updated View and Comment desktop states plus the responsive state under `.context/ui-state-screenshots/`; compare them against the approved mockup for unchanged palette, one basename title, the two top-right mode icons, no document box, and width. Measure and record the effective desktop prose width before and after so the increase stays within 30–40%.
  - Use a fresh Slog run around mode selection and link interception if the real-browser flow disagrees with the component tests, then remove any temporary instrumentation before final validation.

## Test strategy

The core tests stay at the component level because mode selection, disabled review actions, save-status visibility, and link interception are deterministic DOM behaviors. One realistic browser/file flow covers the boundary that component mocks cannot prove: local Markdown target resolution, actual navigation/open behavior, and source-file preservation. This keeps the suite fast and specific while still being predictive at the riskiest integration boundary.

## Risks and safeguards

- Direct link opening can bypass the local-file resolver or open an unsafe target. Reuse the existing target resolution and window-opening protections rather than adding a second URL path.
- Collapsing three internal modes into two visible choices can accidentally remove suggestion behavior. Map Comment to `suggesting` in rich text, preserve the explicitly documented raw source-editor behavior, and protect both with behavior tests before changing production code.
- Silencing Saved can also silence real failures. Test success and failure states separately; only the settled success state disappears.
- A wider main column can squeeze the review rail, overflow smaller windows, or overshoot the requested range when card padding disappears. Measure effective prose rather than outer width, retain transparent gutters, and verify both desktop modes and the responsive collapse.
- Removing the duplicate filename can strand file-copy actions or make the rich/source eye compete with View. Preserve both routes as compact accessible secondary utilities without filename text or another eye icon.

## Non-goals

- Redesigning the application color palette, typography, native window chrome, comment cards, or link accent.
- Changing the Markdown parser, CriticMarkup syntax, save format, CLI lifecycle, or file-watching model.
- Adding a third visible Edit/Suggest mode, a preferences screen, or persisted per-file mode selection.
- Removing source/rich editor switching or unrelated file actions.

## Suggested implementation order

1. Add failing behavior tests for the two modes, save feedback, and links.
2. Implement the icon control and explicit View/Comment mapping.
3. Branch link handling by mode and prove local/external targets.
4. Apply the shared wider, unboxed layout.
5. Update screenshot guidance and run component, repository, smoke, and real-file verification.
