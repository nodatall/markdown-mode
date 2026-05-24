import {
  type CriticComment,
  criticMarkdownToRenderedHtml,
} from "./critic-markup";

interface ReviewPromptOptions {
  filePath: string;
  markdown: string;
}

interface ChangeReference {
  id: string;
  kind: string;
  oldText: string;
  newText: string;
}

function normalizeInlineText(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

function quote(value: string) {
  return value ? `"${value}"` : "not found in rendered document";
}

function authorLabel(comment: CriticComment) {
  return comment.authorType === "ai" ? "AI" : comment.authorId || "user";
}

function parseCommentIds(value: string | null): string[] {
  if (!value) return [];

  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((entry): entry is string => typeof entry === "string")
      : [];
  } catch {
    return [];
  }
}

function collectCommentReferences(root: ParentNode) {
  const references = new Map<string, string>();

  for (const element of root.querySelectorAll<HTMLElement>(
    "[data-comment-ids]",
  )) {
    const referenceText = normalizeInlineText(element.textContent ?? "");
    for (const commentId of parseCommentIds(
      element.dataset.commentIds ?? null,
    )) {
      if (!references.has(commentId)) {
        references.set(commentId, referenceText);
      }
    }
  }

  return references;
}

function collectChangeReferences(root: ParentNode) {
  const changes = new Map<string, ChangeReference>();

  for (const element of root.querySelectorAll<HTMLElement>(
    "[data-critic-change-id]",
  )) {
    const id = element.dataset.criticChangeId;
    const kind = element.dataset.criticChangeKind;
    if (!id || !kind) continue;

    const existing =
      changes.get(id) ??
      ({
        id,
        kind,
        oldText: "",
        newText: "",
      } satisfies ChangeReference);
    const text = normalizeInlineText(element.textContent ?? "");

    if (kind === "addition" || kind === "substitution-new") {
      existing.newText = normalizeInlineText(
        [existing.newText, text].filter(Boolean).join(" "),
      );
    } else {
      existing.oldText = normalizeInlineText(
        [existing.oldText, text].filter(Boolean).join(" "),
      );
    }

    if (kind === "substitution-new" || kind === "substitution-old") {
      existing.kind = "substitution";
    } else {
      existing.kind = kind;
    }
    changes.set(id, existing);
  }

  return changes;
}

function formatChange(change: ChangeReference) {
  if (change.kind === "addition") {
    return `Insert ${quote(change.newText)}.`;
  }

  if (change.kind === "deletion") {
    return `Delete ${quote(change.oldText)}.`;
  }

  if (change.kind === "substitution") {
    return `Replace ${quote(change.oldText)} with ${quote(change.newText)}.`;
  }

  return `Review change ${change.id}.`;
}

export function buildReviewPrompt({ filePath, markdown }: ReviewPromptOptions) {
  const rendered = criticMarkdownToRenderedHtml(markdown);
  const root = document.createElement("div");
  root.innerHTML = rendered.html;
  const commentReferences = collectCommentReferences(root);
  const changeReferences = collectChangeReferences(root);
  const comments = [...rendered.comments.values()];
  const changes = [...changeReferences.values()];
  const feedbackLines: string[] = [];
  let index = 1;

  for (const comment of comments) {
    feedbackLines.push(
      `${index}. Comment ${comment.id} by ${authorLabel(comment)}
   Reference: ${quote(commentReferences.get(comment.id) ?? "")}
   Comment: ${quote(comment.content)}`,
    );
    index += 1;
  }

  for (const change of changes) {
    feedbackLines.push(
      `${index}. Suggestion ${change.id}
   ${formatChange(change)}`,
    );
    index += 1;
  }

  const feedback =
    feedbackLines.length > 0 ? feedbackLines.join("\n\n") : "No review items.";

  return [
    "Please address the review feedback in this Markdown file.",
    "",
    `File: ${filePath}`,
    "",
    "Instructions:",
    "- Read the file from disk before editing.",
    "- Apply or respond to the comments and suggestions below.",
    "- Preserve unrelated content and existing Markdown formatting.",
    "",
    "Review feedback:",
    feedback,
  ].join("\n");
}
