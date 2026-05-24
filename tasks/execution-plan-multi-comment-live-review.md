# Multi-Comment Live Review Plan
## Goal
Make Roughdraft support a fast review loop where each submitted comment is sent to the agent immediately, while the user can keep adding more comments without clicking a final Done button.
## Behavior
1. {==Selecting text should open a comment draft only after pointer release.==}{>>we should also support double clicking text<<}{id="c1" by="user" at="2026-05-24T02:39:19.193Z"}
  
2. A draft comment should stay local until the user saves it.
  
3. Saving a comment should write that comment into the Markdown file.
  
4. {==After the save succeeds, Roughdraft should notify any waiting agent immediately.==}{>>we can add a little loading animation when the comment is being worked on<<}{id="c2" by="user" at="2026-05-24T02:39:53.996Z"}
  
5. The user should be able to continue selecting text and saving more comments while the agent is working.
  
6. If the file reloads from disk while the user is typing a new unsaved comment, the draft UI should not be intentionally cleared.
  
7. For now, ignore the stale-anchor edge case where the selected text for an unsaved draft changes underneath the user.
  
## Current State
The app already does most of this:

- Comment creation waits for pointer release.
  
- Saving a comment writes it to Markdown.
  
- Saving a comment now triggers the same review handoff event as Done Reviewing.
  
- The waiting agent can resume without the user clicking Done Reviewing.
  
## Implementation Plan
1. Audit the live reload path.
  
  - Confirm what happens to active unsaved comment drafts when the file changes on disk.
    
  - Identify whether the editor remounts, whether `CommentEditorList` loses local draft state, and whether active draft comments are deleted or merely hidden.
    
2. Preserve active draft editors across ordinary file reloads.
  
  - Keep submitted comments source-of-truth in Markdown.
    
  - Keep unsaved draft text in UI state keyed by draft comment id.
    
  - Avoid clearing drafts unless the user saves, cancels, deletes, closes the document, or explicitly changes files.
    
3. Keep submitted-comment handoff incremental.
  
  - Each saved comment should flush the latest Markdown to disk.
    
  - Each saved comment should notify the watcher once after the save succeeds.
    
  - A second saved comment should send a second event, not depend on the previous handoff state.
    
4. Adjust handoff status UI.
  
  - Treat Sent as a transient status, not the end of review.
    
  - If a new watcher appears or the user saves another comment, allow another handoff.
    
  - Keep the Done button as a fallback while an agent is watching, but it should no longer be the primary path.
    
5. Add tests.
  
  - Component test: unsaved draft remains visible when the document receives a same-file update.
    
  - Component test: saving comment A triggers handoff and does not clear active draft B.
    
  - E2E test: watcher receives an event after comment A, user can add comment B, watcher receives a second event after comment B.
    
## Out of Scope For Now
- Re-anchoring an unsaved draft if the agent edits the selected text before the user submits it.
  
- Merging simultaneous text edits from the user and agent.
  
- Multi-agent fanout or routing different comments to different watchers.
  
## Definition Of Done
- The installed macOS app supports repeated comment submission without using Done Reviewing.
  
- Unsaved draft comments are not intentionally wiped by normal live reloads.
  
- Submitted comments are persisted in Markdown before the agent is notified.
  
- The relevant unit tests, smoke tests, `pnpm check`, and `pnpm tauri build` pass.
  
- `/Applications/Markdown Mode.app` is rebuilt and reinstalled.
