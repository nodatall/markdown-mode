import type { JSONContent } from "@tiptap/core";
import type { Mark as ProseMirrorMark } from "@tiptap/pm/model";
import { TextSelection } from "@tiptap/pm/state";
import type { Editor } from "@tiptap/react";
import { EditorContent, useEditor, useEditorState } from "@tiptap/react";
import { Plus } from "lucide-react";
import {
  type Dispatch,
  memo,
  type SetStateAction,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { buildLocationForLinkedMarkdownDocument } from "./app-navigation";
import { CommentEditorList } from "./CommentEditorList";
import {
  type CriticChangeAttrs,
  type CriticComment,
  createCriticChange,
  createCriticComment,
  criticMarkdownHasReviewRail,
  criticMarkdownToEditorState,
  editorStateToCriticMarkdown,
} from "./critic-markup";
import {
  type CriticChangeRailItem,
  DocumentReviewRail,
} from "./DocumentReviewRail";
import {
  type CommentGroupAnchor,
  expandCommentIdsForLegacyReferences,
  getPreferredCommentId,
  parseCommentIds,
} from "./document-comments";
import { EditorContextMenu } from "./EditorContextMenu";
import {
  commentHighlightPluginKey,
  createEditorExtensions,
  criticChangeHighlightPluginKey,
  SUGGESTED_PARAGRAPH_SENTINEL,
} from "./editor-extensions";
import { cn } from "./lib/utils";
import { MarkdownCodeEditor } from "./MarkdownCodeEditor";
import { toHtml } from "./markdown";
import type { Page, StorageBackend } from "./storage";
import { useCommentAnchorLayout } from "./useCommentAnchorLayout";

export type DocumentSaveState = "saved" | "unsaved" | "saving" | "error";

export type ManualSaveResult =
  | { status: "saved" }
  | { status: "blocked" }
  | { status: "error"; error: unknown };

export interface DocumentSaveController {
  flushSave: () => Promise<ManualSaveResult>;
}

type EditorViewMode = "rich-text" | "code";
export type DocumentInteractionMode = "viewing" | "suggesting" | "editing";

interface PageCardProps {
  page: Page;
  activeDocumentPath?: string | null;
  selected?: boolean;
  layout?: "default" | "embedded-demo";
  focusRequestKey?: string | null;
  onSave: (id: string, content: string) => Promise<void>;
  onSaveStateChange?: (state: DocumentSaveState) => void;
  editorViewMode?: EditorViewMode;
  interactionMode?: DocumentInteractionMode;
  backend: StorageBackend;
  onEditorReady?: (editor: Editor | null) => void;
  onCommentRailPresenceChange?: (hasCommentRailSpace: boolean) => void;
  onDirtyStateChange?: (isDirty: boolean) => void;
  onLocalContentChange?: (markdown: string) => void;
  onSaveControllerChange?: (controller: DocumentSaveController | null) => void;
  onCommentSubmit?: (commentId: string) => void | Promise<void>;
  saveBlocked?: boolean;
  forceResetKey?: string | null;
}

interface PageCardEditorSurfaceProps {
  page: Page;
  activeDocumentPath: string | null;
  selected: boolean;
  layout: "default" | "embedded-demo";
  focusRequestKey: string | null;
  onSave: (id: string, content: string) => Promise<void>;
  onSaveStateChange: (state: DocumentSaveState) => void;
  editorViewMode: EditorViewMode;
  interactionMode: DocumentInteractionMode;
  backend: StorageBackend;
  onEditorReady?: (editor: Editor | null) => void;
  onCommentRailPresenceChange?: (hasCommentRailSpace: boolean) => void;
  onDirtyStateChange?: (isDirty: boolean) => void;
  onLocalContentChange?: (markdown: string) => void;
  onSaveControllerChange?: (controller: DocumentSaveController | null) => void;
  onCommentSubmit?: (commentId: string) => void | Promise<void>;
  saveBlocked?: boolean;
  forceResetKey?: string | null;
}

interface RichTextEditorSurfaceProps {
  page: Page;
  activeDocumentPath: string | null;
  selected: boolean;
  layout: "default" | "embedded-demo";
  focusRequestKey: string | null;
  sourceMarkdown: string;
  onMarkdownChange: (markdown: string) => void;
  interactionMode: DocumentInteractionMode;
  backend: StorageBackend;
  onEditorReady?: (editor: Editor | null) => void;
  onCommentRailPresenceChange?: (hasCommentRailSpace: boolean) => void;
  onCommentSubmit?: (commentId: string) => void | Promise<void>;
  commentDrafts?: Record<string, string>;
  onCommentDraftsChange?: Dispatch<SetStateAction<Record<string, string>>>;
  editingCommentIds?: string[];
  onEditingCommentIdsChange?: Dispatch<SetStateAction<string[]>>;
  workingCommentIds?: ReadonlySet<string>;
}

interface CodeEditorSurfaceProps {
  markdown: string;
  hasCommentRailSpace: boolean;
  interactionMode: DocumentInteractionMode;
  layout: "default" | "embedded-demo";
  onMarkdownChange: (markdown: string) => void;
}

export interface DraftSuggestionState {
  type: "insertion" | "replacement";
  from: number;
  to: number;
  sourceText: string;
  text: string;
}

function DocumentCommentMarkers({
  commentGroups,
  comments,
  workingCommentIds,
  selectedCommentId,
  hoveredCommentId,
  onFocusComment,
  onHoverComment,
}: {
  commentGroups: CommentGroupAnchor[];
  comments: Map<string, CriticComment>;
  workingCommentIds?: ReadonlySet<string>;
  selectedCommentId: string | null;
  hoveredCommentId: string | null;
  onFocusComment: (commentId: string) => void;
  onHoverComment: (commentId: string | null) => void;
}) {
  const visibleGroups = commentGroups.filter((group) =>
    group.commentIds.some((commentId) => comments.has(commentId)),
  );

  if (visibleGroups.length === 0) return null;

  return (
    <div
      data-testid="document-comment-markers"
      role="group"
      className="pointer-events-none absolute inset-0 z-20"
      aria-label="Document comments"
    >
      {visibleGroups.map((group) => {
        const primaryCommentId =
          (selectedCommentId && group.commentIds.includes(selectedCommentId)
            ? selectedCommentId
            : group.commentIds.find((commentId) => comments.has(commentId))) ??
          null;
        if (!primaryCommentId) return null;

        const primaryComment = comments.get(primaryCommentId);
        const isDraftComment = primaryComment?.content.trim().length === 0;
        const savedGroupIndex = visibleGroups
          .filter((candidate) =>
            candidate.commentIds.some(
              (commentId) =>
                comments.get(commentId)?.content.trim().length !== 0,
            ),
          )
          .findIndex((candidate) => candidate.key === group.key);
        const isActive = group.commentIds.some(
          (commentId) =>
            commentId === selectedCommentId || commentId === hoveredCommentId,
        );
        const isWorking = group.commentIds.some((commentId) =>
          workingCommentIds?.has(commentId),
        );

        return (
          <button
            key={group.key}
            type="button"
            data-testid={`document-comment-marker-${primaryCommentId}`}
            className={cn(
              "pointer-events-auto absolute flex size-6 -translate-y-1/2 items-center justify-center rounded-full border text-[11px] font-semibold leading-none shadow-[0_4px_14px_rgba(41,37,36,0.14)] transition",
              isDraftComment
                ? "border-sky-500 bg-sky-500 text-white hover:border-sky-600 hover:bg-sky-600"
                : isActive
                  ? "border-stone-900 bg-stone-900 text-white dark:border-slate-100 dark:bg-slate-100 dark:text-slate-950"
                  : "border-[#D7D2C9] bg-[#FFFDFC] text-stone-600 hover:border-stone-500 hover:text-stone-950 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300 dark:hover:border-slate-400 dark:hover:text-white",
            )}
            style={{
              left: Math.max(0, group.anchorRight ?? 0) + 8,
              top: Math.max(12, (group.anchorTop + group.anchorBottom) / 2),
            }}
            aria-label={
              isDraftComment
                ? "New comment"
                : `Open comment ${savedGroupIndex + 1}`
            }
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              onFocusComment(primaryCommentId);
            }}
            onMouseEnter={() => onHoverComment(primaryCommentId)}
            onMouseLeave={() => onHoverComment(null)}
          >
            {isDraftComment ? (
              <Plus className="size-3.5" strokeWidth={2.5} />
            ) : (
              savedGroupIndex + 1
            )}
            {isWorking ? (
              <span
                className="-right-0.5 -top-0.5 absolute size-2.5 animate-pulse rounded-full border border-white bg-sky-500 dark:border-slate-950 dark:bg-sky-300"
                data-testid={`document-comment-marker-${primaryCommentId}-working`}
                aria-hidden="true"
              />
            ) : null}
          </button>
        );
      })}
    </div>
  );
}

function areCommentIdListsEqual(
  current: string[] | null | undefined,
  next: string[] | null | undefined,
) {
  if (!current || !next) return current === next;
  if (current.length !== next.length) return false;
  return current.every((commentId, index) => commentId === next[index]);
}

function getCommentThreadPanelIds(
  commentId: string,
  comments: ReadonlyMap<string, CriticComment>,
) {
  return comments.has(commentId) ? [commentId] : [];
}

function getSelectionCommentIds(editor: Editor | null): string[] {
  if (!editor) return [];

  const directAttributes = editor.getAttributes("commentRef").commentIds;

  if (Array.isArray(directAttributes) && directAttributes.length > 0) {
    return directAttributes;
  }

  const { from, to, empty, $from } = editor.state.selection;
  const commentIds = new Set<string>();

  if (empty) {
    for (const mark of $from.marks()) {
      if (mark.type.name !== "commentRef") continue;

      for (const commentId of mark.attrs.commentIds ?? []) {
        commentIds.add(commentId);
      }
    }
  } else {
    editor.state.doc.nodesBetween(from, to, (node) => {
      if (!node.isText) return;

      for (const mark of node.marks) {
        if (mark.type.name !== "commentRef") continue;

        for (const commentId of mark.attrs.commentIds ?? []) {
          commentIds.add(commentId);
        }
      }
    });
  }

  return [...commentIds];
}

function getSelectionCriticChangeIds(editor: Editor | null): string[] {
  if (!editor) return [];

  const directChangeId = editor.getAttributes("criticChange").changeId;

  if (typeof directChangeId === "string" && directChangeId.length > 0) {
    return [directChangeId];
  }

  const { from, to, empty, $from } = editor.state.selection;
  const changeIds = new Set<string>();

  if (empty) {
    for (const mark of $from.marks()) {
      if (mark.type.name !== "criticChange") continue;
      if (typeof mark.attrs.changeId === "string") {
        changeIds.add(mark.attrs.changeId);
      }
    }
  } else {
    editor.state.doc.nodesBetween(from, to, (node) => {
      if (!node.isText) return;

      for (const mark of node.marks) {
        if (mark.type.name !== "criticChange") continue;
        if (typeof mark.attrs.changeId === "string") {
          changeIds.add(mark.attrs.changeId);
        }
      }
    });
  }

  return [...changeIds];
}

function getPreferredCriticChangeId(
  changeIds: string[],
  currentChangeId: string | null,
): string | null {
  if (currentChangeId && changeIds.includes(currentChangeId)) {
    return currentChangeId;
  }

  return changeIds[0] ?? null;
}

function findCommentRange(editor: Editor | null, commentId: string) {
  if (!editor) return null;

  const commentMarkType = editor.state.schema.marks.commentRef;
  if (!commentMarkType) return null;

  let from: number | null = null;
  let to: number | null = null;
  let closed = false;

  editor.state.doc.descendants((node, pos) => {
    if (closed || !node.isText) return false;

    const hasCommentId = node.marks.some(
      (mark) =>
        mark.type === commentMarkType &&
        Array.isArray(mark.attrs.commentIds) &&
        mark.attrs.commentIds.includes(commentId),
    );

    if (!hasCommentId) {
      if (from != null && to != null && pos >= to) {
        closed = true;
      }
      return;
    }

    if (from == null || to == null) {
      from = pos;
      to = pos + node.nodeSize;
      return;
    }

    if (pos <= to) {
      to = pos + node.nodeSize;
      return;
    }

    closed = true;
  });

  if (from == null || to == null) return null;

  return { from, to };
}

function findCommentAnchorElement(editor: Editor | null, commentId: string) {
  if (!editor) return null;

  const anchors = editor.view.dom.querySelectorAll<HTMLElement>(
    ".comment-anchor[data-comment-ids]",
  );

  return (
    [...anchors].find((anchor) =>
      parseCommentIds(anchor.dataset.commentIds).includes(commentId),
    ) ?? null
  );
}

function getDocumentCriticChanges(
  editor: Editor,
): Array<Pick<CriticChangeAttrs, "changeId">> {
  const changes = new Map<string, Pick<CriticChangeAttrs, "changeId">>();

  editor.state.doc.descendants((node) => {
    if (!node.isText) return;

    for (const mark of node.marks) {
      if (mark.type.name !== "criticChange") continue;
      if (typeof mark.attrs.changeId !== "string") continue;

      changes.set(mark.attrs.changeId, { changeId: mark.attrs.changeId });
    }
  });

  return [...changes.values()];
}

function getReusableSuggestionInputMark(
  editor: Editor,
  position: number,
): ProseMirrorMark | null {
  const markType = editor.state.schema.marks.criticChange;
  if (!markType) return null;

  const isReusableSuggestionMark = (mark: ProseMirrorMark) =>
    mark.type === markType &&
    (mark.attrs.kind === "addition" || mark.attrs.kind === "substitution-new");
  const $position = editor.state.doc.resolve(position);
  const previousMark = $position.nodeBefore?.marks.find(
    isReusableSuggestionMark,
  );

  if (previousMark) return previousMark;

  return $position.nodeAfter?.marks.find(isReusableSuggestionMark) ?? null;
}

function getReusableSuggestionDeletionMark(
  editor: Editor,
  from: number,
  to: number,
): ProseMirrorMark | null {
  const markType = editor.state.schema.marks.criticChange;
  if (!markType) return null;

  const isReusableDeletionMark = (mark: ProseMirrorMark) =>
    mark.type === markType && mark.attrs.kind === "deletion";
  const beforeRange = editor.state.doc
    .resolve(from)
    .nodeBefore?.marks.find(isReusableDeletionMark);

  if (beforeRange) return beforeRange;

  return (
    editor.state.doc
      .resolve(to)
      .nodeAfter?.marks.find(isReusableDeletionMark) ?? null
  );
}

function getDocumentCriticChangeRailItems(
  editor: Editor | null,
  comments: ReadonlyMap<string, CriticComment>,
): CriticChangeRailItem[] {
  if (!editor) return [];

  const changes = new Map<string, CriticChangeRailItem>();
  const anchors = new Map<
    string,
    {
      anchorTop: number;
      anchorBottom: number;
    }
  >();
  let editorElement: HTMLElement;

  try {
    editorElement = editor.view.dom as HTMLElement;
  } catch {
    return [];
  }

  const changeElements = editorElement.querySelectorAll<HTMLElement>(
    ".critic-change[data-critic-change-id]",
  );
  const editorRect = editorElement.getBoundingClientRect();

  for (const element of changeElements) {
    const changeId = element.dataset.criticChangeId;
    if (!changeId) continue;

    const rect = element.getBoundingClientRect();
    const existing = anchors.get(changeId);
    const anchorTop = rect.top - editorRect.top;
    const anchorBottom = rect.bottom - editorRect.top;

    if (existing) {
      existing.anchorTop = Math.min(existing.anchorTop, anchorTop);
      existing.anchorBottom = Math.max(existing.anchorBottom, anchorBottom);
    } else {
      anchors.set(changeId, {
        anchorTop,
        anchorBottom,
      });
    }
  }

  editor.state.doc.descendants((node) => {
    if (!node.isText || !node.text) return;

    const changeMark = node.marks.find(
      (mark) =>
        mark.type.name === "criticChange" &&
        typeof mark.attrs.changeId === "string",
    );
    if (!changeMark) return;

    const change = changeMark.attrs as CriticChangeAttrs;
    const changeId = change.changeId;
    const kind =
      change.kind === "substitution-new" ? "substitution-old" : change.kind;
    const existing =
      changes.get(changeId) ??
      ({
        changeId,
        change,
        kind,
        oldText: "",
        newText: "",
        commentIds: [],
        anchorTop: anchors.get(changeId)?.anchorTop ?? 0,
        anchorBottom: anchors.get(changeId)?.anchorBottom ?? 24,
      } satisfies CriticChangeRailItem);

    existing.change = {
      ...change,
      kind,
    };
    existing.kind = kind;

    if (change.kind === "addition" || change.kind === "substitution-new") {
      existing.newText += node.text;
    } else {
      existing.oldText += node.text;
    }

    for (const mark of node.marks) {
      if (mark.type.name !== "commentRef") continue;
      if (!Array.isArray(mark.attrs.commentIds)) continue;

      existing.commentIds = [
        ...new Set([...existing.commentIds, ...mark.attrs.commentIds]),
      ];
    }

    changes.set(changeId, existing);
  });

  for (const change of changes.values()) {
    const directCommentIds = [...comments.values()]
      .filter((comment) => comment.parentCommentId === change.changeId)
      .map((comment) => comment.id);

    change.commentIds = [
      ...new Set([...change.commentIds, ...directCommentIds]),
    ];
  }

  return [...changes.values()].sort(
    (left, right) => left.anchorTop - right.anchorTop,
  );
}

function getCriticChangeRange(editor: Editor | null, changeId: string) {
  if (!editor) return null;

  let from: number | null = null;
  let to: number | null = null;

  editor.state.doc.descendants((node, pos) => {
    if (!node.isText) return;

    const hasChange = node.marks.some(
      (mark) =>
        mark.type.name === "criticChange" && mark.attrs.changeId === changeId,
    );
    if (!hasChange) return;

    from = from == null ? pos : Math.min(from, pos);
    to = to == null ? pos + node.nodeSize : Math.max(to, pos + node.nodeSize);
  });

  if (from == null || to == null) return null;

  return { from, to };
}

export function shouldDismissCommentThread(target: EventTarget | null) {
  if (!(target instanceof Element)) return true;

  return !target.closest(
    '[data-comment-thread-container="true"], [data-suggestion-thread-container="true"], .comment-anchor[data-comment-ids], .critic-change[data-critic-change-id]',
  );
}

const RichTextEditorSurface = memo(function RichTextEditorSurface({
  page,
  activeDocumentPath,
  selected,
  layout,
  focusRequestKey,
  sourceMarkdown,
  onMarkdownChange,
  interactionMode,
  backend,
  onEditorReady,
  onCommentRailPresenceChange,
  onCommentSubmit,
  commentDrafts,
  onCommentDraftsChange,
  editingCommentIds,
  onEditingCommentIdsChange,
  workingCommentIds,
}: RichTextEditorSurfaceProps) {
  const editorRef = useRef<Editor | null>(null);
  const criticChangeFrameRef = useRef<number | null>(null);
  const interactionModeRef = useRef<DocumentInteractionMode>(interactionMode);
  const commentsRef = useRef<Map<string, CriticComment>>(new Map());
  const suppressNextMarkdownUpdateRef = useRef(false);
  const lastFocusRequestKeyRef = useRef<string | null>(null);
  const selectedCommentIdRef = useRef<string | null>(null);
  const selectedChangeIdRef = useRef<string | null>(null);
  const [selectedCommentId, setSelectedCommentId] = useState<string | null>(
    null,
  );
  const [hoveredCommentId, setHoveredCommentId] = useState<string | null>(null);
  const [selectedChangeId, setSelectedChangeId] = useState<string | null>(null);
  const [hoveredChangeId, setHoveredChangeId] = useState<string | null>(null);
  const [criticChanges, setCriticChanges] = useState<CriticChangeRailItem[]>(
    [],
  );
  const [draftSuggestion, setDraftSuggestion] =
    useState<DraftSuggestionState | null>(null);
  const [pendingFocusCommentId, setPendingFocusCommentId] = useState<
    string | null
  >(null);

  const resolveFileUrl = useCallback(
    (path: string) => backend.resolveFileUrl(path),
    [backend],
  );
  const resolveLinkUrl = useCallback(
    (path: string) =>
      buildLocationForLinkedMarkdownDocument({
        projectPath: backend.info.projectPath,
        currentDocumentPath: activeDocumentPath,
        href: path,
      }),
    [activeDocumentPath, backend],
  );

  const parsedContent = useMemo(
    () =>
      criticMarkdownToEditorState(sourceMarkdown, {
        resolveFileUrl,
        resolveLinkUrl,
      }),
    [resolveFileUrl, resolveLinkUrl, sourceMarkdown],
  );
  const [comments, setComments] = useState<Map<string, CriticComment>>(
    () => parsedContent.comments,
  );
  const frontmatterRef = useRef<string | null>(parsedContent.frontmatter);
  commentsRef.current = comments;

  useEffect(() => {
    interactionModeRef.current = interactionMode;
  }, [interactionMode]);

  useEffect(() => {
    onCommentRailPresenceChange?.(
      comments.size > 0 || criticChanges.length > 0,
    );
  }, [comments.size, criticChanges.length, onCommentRailPresenceChange]);

  const emitMarkdownChange = useCallback(
    (doc?: JSONContent, nextComments?: Map<string, CriticComment>) => {
      const currentEditor = editorRef.current;
      const currentDoc = doc ?? currentEditor?.getJSON();
      if (!currentDoc) return;

      onMarkdownChange(
        editorStateToCriticMarkdown(
          currentDoc,
          nextComments ?? commentsRef.current,
          { frontmatter: frontmatterRef.current },
        ),
      );
    },
    [onMarkdownChange],
  );

  const insertFiles = useCallback(
    async (files: File[]) => {
      const currentEditor = editorRef.current;
      if (!currentEditor || files.length === 0) return;

      const assets = await Promise.all(
        files.map((file) => backend.saveAsset(file)),
      );
      const markdown = assets
        .map((asset, index) => {
          const file = files[index];
          if (asset.mimeType.startsWith("image/")) {
            return `![${file?.name || "Image"}](${asset.markdownPath})`;
          }
          return `[${file?.name || "Attachment"}](${asset.markdownPath})`;
        })
        .join("\n\n");

      currentEditor
        .chain()
        .focus()
        .insertContent(
          toHtml(markdown, {
            resolveFileUrl,
            resolveLinkUrl,
          }),
        )
        .run();
    },
    [backend, resolveFileUrl, resolveLinkUrl],
  );

  const refreshCriticChanges = useCallback(() => {
    if (criticChangeFrameRef.current != null) {
      cancelAnimationFrame(criticChangeFrameRef.current);
    }

    criticChangeFrameRef.current = requestAnimationFrame(() => {
      criticChangeFrameRef.current = null;
      setCriticChanges(
        getDocumentCriticChangeRailItems(
          editorRef.current,
          commentsRef.current,
        ),
      );
    });
  }, []);

  useEffect(() => {
    return () => {
      if (criticChangeFrameRef.current != null) {
        cancelAnimationFrame(criticChangeFrameRef.current);
      }
    };
  }, []);

  const editor = useEditor(
    {
      extensions: createEditorExtensions("Start writing..."),
      content: parsedContent.doc,
      immediatelyRender: false,
      shouldRerenderOnTransaction: false,
      editorProps: {
        attributes: {
          class: "tiptap min-h-[70vh]",
        },
        handleDrop: (_view, event) => {
          const files = Array.from(event.dataTransfer?.files ?? []);
          if (files.length === 0) return false;
          event.preventDefault();
          void insertFiles(files);
          return true;
        },
        handlePaste: (view, event) => {
          const files = Array.from(event.clipboardData?.files ?? []);
          if (files.length > 0) {
            event.preventDefault();
            void insertFiles(files);
            return true;
          }

          if (interactionModeRef.current !== "suggesting") return false;

          const text = event.clipboardData?.getData("text/plain");
          if (!text) return false;

          const currentEditor = editorRef.current;
          if (!currentEditor) return false;

          event.preventDefault();

          const { selection } = view.state;
          const from = selection.from;
          const to = selection.to;
          const tr = view.state.tr;

          if (from !== to) {
            const criticMarkType = view.state.schema.marks.criticChange;
            const isAdditionKind = (m: ProseMirrorMark) =>
              m.type === criticMarkType &&
              (m.attrs.kind === "addition" ||
                m.attrs.kind === "substitution-new");

            type Segment = {
              from: number;
              to: number;
              isAddition: boolean;
            };
            const segments: Segment[] = [];
            view.state.doc.nodesBetween(from, to, (node, pos) => {
              if (!node.isText) return;
              const segFrom = Math.max(pos, from);
              const segTo = Math.min(pos + node.nodeSize, to);
              if (segFrom >= segTo) return;
              const isAdd = node.marks.some(isAdditionKind);
              const prev = segments[segments.length - 1];
              if (prev && prev.isAddition === isAdd && prev.to === segFrom) {
                prev.to = segTo;
              } else {
                segments.push({
                  from: segFrom,
                  to: segTo,
                  isAddition: isAdd,
                });
              }
            });

            const hasOriginalText = segments.some((s) => !s.isAddition);

            if (hasOriginalText) {
              const oldChange = createCriticChange(
                "substitution-old",
                undefined,
                {
                  existingChanges: getDocumentCriticChanges(currentEditor),
                },
              );
              const newMark = view.state.schema.marks.criticChange.create({
                ...oldChange,
                kind: "substitution-new",
              });

              for (const seg of [...segments].reverse()) {
                if (seg.isAddition) {
                  tr.delete(seg.from, seg.to);
                } else {
                  tr.addMark(
                    seg.from,
                    seg.to,
                    view.state.schema.marks.criticChange.create(oldChange),
                  );
                }
              }

              const insertPos = tr.mapping.map(to, -1);
              tr.insert(insertPos, view.state.schema.text(text, [newMark]));
              tr.setSelection(
                TextSelection.create(tr.doc, insertPos + text.length),
              );
            } else {
              for (const seg of [...segments].reverse()) {
                tr.delete(seg.from, seg.to);
              }
              const insertPos = tr.mapping.map(from, -1);
              const existingMark = getReusableSuggestionInputMark(
                currentEditor,
                insertPos,
              );
              const mark =
                existingMark ??
                view.state.schema.marks.criticChange.create(
                  createCriticChange("addition", undefined, {
                    existingChanges: getDocumentCriticChanges(currentEditor),
                  }),
                );
              tr.insert(insertPos, view.state.schema.text(text, [mark]));
              tr.setSelection(
                TextSelection.create(tr.doc, insertPos + text.length),
              );
            }
          } else {
            const existingMark = getReusableSuggestionInputMark(
              currentEditor,
              from,
            );
            const mark =
              existingMark ??
              view.state.schema.marks.criticChange.create(
                createCriticChange("addition", undefined, {
                  existingChanges: getDocumentCriticChanges(currentEditor),
                }),
              );
            tr.insert(from, view.state.schema.text(text, [mark]));
            tr.setSelection(TextSelection.create(tr.doc, from + text.length));
          }

          view.dispatch(tr.scrollIntoView());
          return true;
        },
        handleTextInput: (view, from, to, text) => {
          if (interactionModeRef.current !== "suggesting") return false;
          if (!text) return false;

          const currentEditor = editorRef.current;
          if (!currentEditor) return false;

          const tr = view.state.tr;

          if (from !== to) {
            const criticMarkType = view.state.schema.marks.criticChange;
            const isAdditionKind = (m: ProseMirrorMark) =>
              m.type === criticMarkType &&
              (m.attrs.kind === "addition" ||
                m.attrs.kind === "substitution-new");

            type Segment = {
              from: number;
              to: number;
              isAddition: boolean;
            };
            const segments: Segment[] = [];
            view.state.doc.nodesBetween(from, to, (node, pos) => {
              if (!node.isText) return;
              const segFrom = Math.max(pos, from);
              const segTo = Math.min(pos + node.nodeSize, to);
              if (segFrom >= segTo) return;
              const isAdd = node.marks.some(isAdditionKind);
              const prev = segments[segments.length - 1];
              if (prev && prev.isAddition === isAdd && prev.to === segFrom) {
                prev.to = segTo;
              } else {
                segments.push({
                  from: segFrom,
                  to: segTo,
                  isAddition: isAdd,
                });
              }
            });

            const hasOriginalText = segments.some((s) => !s.isAddition);

            if (hasOriginalText) {
              const oldChange = createCriticChange(
                "substitution-old",
                undefined,
                {
                  existingChanges: getDocumentCriticChanges(currentEditor),
                },
              );
              const newMark = view.state.schema.marks.criticChange.create({
                ...oldChange,
                kind: "substitution-new",
              });

              for (const seg of [...segments].reverse()) {
                if (seg.isAddition) {
                  tr.delete(seg.from, seg.to);
                } else {
                  tr.addMark(
                    seg.from,
                    seg.to,
                    view.state.schema.marks.criticChange.create(oldChange),
                  );
                }
              }

              const insertPos = tr.mapping.map(to, -1);
              tr.insert(insertPos, view.state.schema.text(text, [newMark]));
              tr.setSelection(
                TextSelection.create(tr.doc, insertPos + text.length),
              );
            } else {
              for (const seg of [...segments].reverse()) {
                tr.delete(seg.from, seg.to);
              }
              const insertPos = tr.mapping.map(from, -1);
              const existingMark = getReusableSuggestionInputMark(
                currentEditor,
                insertPos,
              );
              const mark =
                existingMark ??
                view.state.schema.marks.criticChange.create(
                  createCriticChange("addition", undefined, {
                    existingChanges: getDocumentCriticChanges(currentEditor),
                  }),
                );
              tr.insert(insertPos, view.state.schema.text(text, [mark]));
              tr.setSelection(
                TextSelection.create(tr.doc, insertPos + text.length),
              );
            }
          } else {
            const existingMark = getReusableSuggestionInputMark(
              currentEditor,
              from,
            );
            const mark =
              existingMark ??
              view.state.schema.marks.criticChange.create(
                createCriticChange("addition", undefined, {
                  existingChanges: getDocumentCriticChanges(currentEditor),
                }),
              );
            tr.insert(from, view.state.schema.text(text, [mark]));
            tr.setSelection(TextSelection.create(tr.doc, from + text.length));
          }

          view.dispatch(tr.scrollIntoView());
          return true;
        },
        handleKeyDown: (view, event) => {
          if (interactionModeRef.current !== "suggesting") return false;

          if (event.key === "Enter") {
            event.preventDefault();

            const currentEditor = editorRef.current;
            if (!currentEditor) return true;

            const { selection } = view.state;
            if (!selection.empty) return true;

            const $from = selection.$from;
            if (!$from.parent.isTextblock) return true;
            if ($from.parentOffset !== $from.parent.content.size) return true;

            const change = createCriticChange("addition", undefined, {
              existingChanges: getDocumentCriticChanges(currentEditor),
            });
            const mark = view.state.schema.marks.criticChange.create(change);
            const tr = view.state.tr.split(selection.from);
            const insertPos = tr.selection.from;

            tr.insert(
              insertPos,
              view.state.schema.text(SUGGESTED_PARAGRAPH_SENTINEL, [mark]),
            );
            tr.setSelection(
              TextSelection.create(
                tr.doc,
                insertPos + SUGGESTED_PARAGRAPH_SENTINEL.length,
              ),
            );
            tr.scrollIntoView();
            view.dispatch(tr);
            return true;
          }

          // Handle Cut (Ctrl+X / Cmd+X)
          if (
            (event.metaKey || event.ctrlKey) &&
            event.key.toLowerCase() === "x"
          ) {
            const { selection } = view.state;
            if (selection.empty) return false;

            const currentEditor = editorRef.current;
            if (!currentEditor) return false;

            event.preventDefault();
            const from = selection.from;
            const to = selection.to;
            const selectedText = view.state.doc.textBetween(from, to);
            void navigator.clipboard.writeText(selectedText);

            const criticMarkType = view.state.schema.marks.criticChange;
            const isAdditionKind = (m: ProseMirrorMark) =>
              m.type === criticMarkType &&
              (m.attrs.kind === "addition" ||
                m.attrs.kind === "substitution-new");

            type Segment = {
              from: number;
              to: number;
              isAddition: boolean;
            };
            const segments: Segment[] = [];
            view.state.doc.nodesBetween(from, to, (node, pos) => {
              if (!node.isText) return;
              const segFrom = Math.max(pos, from);
              const segTo = Math.min(pos + node.nodeSize, to);
              if (segFrom >= segTo) return;
              const isAdd = node.marks.some(isAdditionKind);
              const prev = segments[segments.length - 1];
              if (prev && prev.isAddition === isAdd && prev.to === segFrom) {
                prev.to = segTo;
              } else {
                segments.push({
                  from: segFrom,
                  to: segTo,
                  isAddition: isAdd,
                });
              }
            });

            const tr = view.state.tr;
            for (const seg of [...segments].reverse()) {
              if (seg.isAddition) {
                tr.delete(seg.from, seg.to);
              } else {
                const deletionMark =
                  getReusableSuggestionDeletionMark(
                    currentEditor,
                    seg.from,
                    seg.to,
                  ) ??
                  view.state.schema.marks.criticChange.create(
                    createCriticChange("deletion", undefined, {
                      existingChanges: getDocumentCriticChanges(currentEditor),
                    }),
                  );
                tr.addMark(seg.from, seg.to, deletionMark);
              }
            }
            view.dispatch(tr.scrollIntoView());
            return true;
          }

          if (event.key !== "Backspace" && event.key !== "Delete") return false;

          const currentEditor = editorRef.current;
          if (!currentEditor) return false;

          const { selection } = view.state;
          let from = selection.from;
          let to = selection.to;

          if (selection.empty) {
            const $pos = view.state.doc.resolve(selection.from);
            const blockStart = $pos.start($pos.depth);
            const blockEnd = $pos.end($pos.depth);

            if (event.key === "Backspace") {
              if (event.ctrlKey || event.altKey) {
                const textBefore = view.state.doc.textBetween(
                  blockStart,
                  selection.from,
                );
                const match = textBefore.match(/\S+\s*$/);
                from = match
                  ? selection.from - match[0].length
                  : Math.max(blockStart, selection.from - 1);
              } else {
                from = Math.max(blockStart, selection.from - 1);
              }
            } else {
              if (event.ctrlKey || event.altKey) {
                const textAfter = view.state.doc.textBetween(
                  selection.to,
                  blockEnd,
                );
                const match = textAfter.match(/^\s*\S+/);
                to = match
                  ? selection.to + match[0].length
                  : Math.min(blockEnd, selection.to + 1);
              } else {
                to = Math.min(blockEnd, selection.to + 1);
              }
            }
          }

          if (from === to) {
            event.preventDefault();
            return true;
          }

          event.preventDefault();

          const criticMarkType = view.state.schema.marks.criticChange;
          const isAdditionKind = (m: ProseMirrorMark) =>
            m.type === criticMarkType &&
            (m.attrs.kind === "addition" ||
              m.attrs.kind === "substitution-new");

          // Collect segments, distinguishing suggested-insertion text
          // from original text so we can delete the former and mark the
          // latter.
          type Segment = {
            from: number;
            to: number;
            isAddition: boolean;
          };
          const segments: Segment[] = [];
          view.state.doc.nodesBetween(from, to, (node, pos) => {
            if (!node.isText) return;
            const segFrom = Math.max(pos, from);
            const segTo = Math.min(pos + node.nodeSize, to);
            if (segFrom >= segTo) return;
            const isAdd = node.marks.some(isAdditionKind);
            const prev = segments[segments.length - 1];
            if (prev && prev.isAddition === isAdd && prev.to === segFrom) {
              prev.to = segTo;
            } else {
              segments.push({ from: segFrom, to: segTo, isAddition: isAdd });
            }
          });

          const tr = view.state.tr;

          // Process right-to-left so earlier positions stay valid.
          for (const seg of [...segments].reverse()) {
            if (seg.isAddition) {
              tr.delete(seg.from, seg.to);
            } else {
              const deletionMark =
                getReusableSuggestionDeletionMark(
                  currentEditor,
                  seg.from,
                  seg.to,
                ) ??
                view.state.schema.marks.criticChange.create(
                  createCriticChange("deletion", undefined, {
                    existingChanges: getDocumentCriticChanges(currentEditor),
                  }),
                );
              tr.addMark(seg.from, seg.to, deletionMark);
            }
          }

          const basePos = event.key === "Backspace" ? from : to;
          const mappedPos = tr.mapping.map(basePos, -1);
          tr.setSelection(TextSelection.create(tr.doc, mappedPos));
          tr.scrollIntoView();

          view.dispatch(tr);
          return true;
        },
      },
      onUpdate: ({ editor: currentEditor }) => {
        if (suppressNextMarkdownUpdateRef.current) {
          suppressNextMarkdownUpdateRef.current = false;
          return;
        }

        emitMarkdownChange(currentEditor.getJSON());
        refreshCriticChanges();
      },
    },
    [page.id],
  );

  editorRef.current = editor;
  selectedCommentIdRef.current = selectedCommentId;
  selectedChangeIdRef.current = selectedChangeId;

  useEffect(() => {
    editor?.setEditable(interactionMode !== "viewing", false);
  }, [editor, interactionMode]);

  const activeCommentIds =
    useEditorState({
      editor,
      selector: ({ editor: currentEditor }) =>
        getSelectionCommentIds(currentEditor),
      equalityFn: areCommentIdListsEqual,
    }) ?? [];
  const activeChangeIds =
    useEditorState({
      editor,
      selector: ({ editor: currentEditor }) =>
        getSelectionCriticChangeIds(currentEditor),
      equalityFn: areCommentIdListsEqual,
    }) ?? [];

  const { commentGroups, contentHeight, measureLayout } =
    useCommentAnchorLayout(editor, comments.size > 0);

  const discardEmptyComment = useCallback(
    (commentId: string) => {
      const currentEditor = editorRef.current;
      const comment = commentsRef.current.get(commentId);
      if (!currentEditor || !comment || comment.content.trim().length > 0) {
        return false;
      }

      const nextComments = new Map(commentsRef.current);
      nextComments.delete(commentId);
      commentsRef.current = nextComments;
      setComments(nextComments);
      onCommentDraftsChange?.((current) => {
        const nextDrafts = { ...current };
        delete nextDrafts[commentId];
        return nextDrafts;
      });
      onEditingCommentIdsChange?.((current) =>
        current.filter((currentCommentId) => currentCommentId !== commentId),
      );

      const collapsePosition = currentEditor.state.selection.to;
      currentEditor
        .chain()
        .focus()
        .removeCommentId(commentId)
        .setTextSelection(collapsePosition)
        .run();
      currentEditor.commands.blur();
      setSelectedCommentId((current) =>
        current === commentId ? null : current,
      );
      setHoveredCommentId((current) =>
        current === commentId ? null : current,
      );
      setPendingFocusCommentId((current) =>
        current === commentId ? null : current,
      );
      emitMarkdownChange(currentEditor.getJSON(), nextComments);
      requestAnimationFrame(() => {
        measureLayout();
      });
      return true;
    },
    [
      emitMarkdownChange,
      measureLayout,
      onCommentDraftsChange,
      onEditingCommentIdsChange,
    ],
  );

  useEffect(() => {
    onEditorReady?.(editor);

    return () => {
      onEditorReady?.(null);
    };
  }, [editor, onEditorReady]);

  useEffect(() => {
    setSelectedCommentId((current) =>
      getPreferredCommentId(activeCommentIds, current),
    );
  }, [activeCommentIds]);

  useEffect(() => {
    setSelectedChangeId((current) =>
      getPreferredCriticChangeId(activeChangeIds, current),
    );
  }, [activeChangeIds]);

  useEffect(() => {
    if (!editor) return;

    frontmatterRef.current = parsedContent.frontmatter;
    commentsRef.current = parsedContent.comments;
    setComments(parsedContent.comments);
    setSelectedCommentId(null);
    setHoveredCommentId(null);
    setSelectedChangeId(null);
    setHoveredChangeId(null);
    setDraftSuggestion(null);
    setPendingFocusCommentId(null);

    const nextDoc = parsedContent.doc;
    if (JSON.stringify(editor.getJSON()) !== JSON.stringify(nextDoc)) {
      editor.commands.setContent(nextDoc, { emitUpdate: false });
    }

    refreshCriticChanges();
  }, [editor, parsedContent, refreshCriticChanges]);

  useEffect(() => {
    if (!editor || !selected || !focusRequestKey) return;
    if (lastFocusRequestKeyRef.current === focusRequestKey) return;
    lastFocusRequestKeyRef.current = focusRequestKey;

    requestAnimationFrame(() => {
      editor.chain().focus("end").run();
    });
  }, [editor, focusRequestKey, selected]);

  useEffect(() => {
    if (selectedCommentId && !comments.has(selectedCommentId)) {
      setSelectedCommentId(null);
    }

    if (hoveredCommentId && !comments.has(hoveredCommentId)) {
      setHoveredCommentId(null);
    }
    refreshCriticChanges();
  }, [comments, hoveredCommentId, refreshCriticChanges, selectedCommentId]);

  useEffect(() => {
    if (!editor) return;

    const effectiveHoveredCommentId = selectedCommentId
      ? hoveredCommentId
      : null;

    editor.view.dispatch(
      editor.state.tr.setMeta(commentHighlightPluginKey, {
        selectedCommentId,
        hoveredCommentId: effectiveHoveredCommentId,
      }),
    );
  }, [editor, hoveredCommentId, selectedCommentId]);

  useEffect(() => {
    if (!editor) return;

    const effectiveHoveredChangeId = selectedChangeId ? hoveredChangeId : null;

    editor.view.dispatch(
      editor.state.tr.setMeta(criticChangeHighlightPluginKey, {
        selectedChangeId,
        hoveredChangeId: effectiveHoveredChangeId,
      }),
    );
  }, [editor, hoveredChangeId, selectedChangeId]);

  useEffect(() => {
    if (!editor) return;

    const anchorElements = editor.view.dom.querySelectorAll<HTMLElement>(
      ".comment-anchor[data-comment-ids]",
    );
    const cleanupCallbacks: Array<() => void> = [];

    for (const anchor of anchorElements) {
      const commentIds = parseCommentIds(anchor.dataset.commentIds);
      if (commentIds.length === 0) continue;

      const handleMouseEnter = () => {
        const nextCommentId = getPreferredCommentId(
          commentIds,
          selectedCommentIdRef.current,
        );
        if (nextCommentId) {
          setHoveredCommentId(nextCommentId);
        }
      };

      const handleMouseLeave = () => {
        setHoveredCommentId((current) =>
          current && commentIds.includes(current) ? null : current,
        );
      };

      const handleClick = () => {
        const nextCommentId = getPreferredCommentId(
          commentIds,
          selectedCommentIdRef.current,
        );
        if (nextCommentId) {
          setSelectedCommentId(nextCommentId);
        }
      };

      anchor.addEventListener("mouseenter", handleMouseEnter);
      anchor.addEventListener("mouseleave", handleMouseLeave);
      anchor.addEventListener("click", handleClick);
      cleanupCallbacks.push(() => {
        anchor.removeEventListener("mouseenter", handleMouseEnter);
        anchor.removeEventListener("mouseleave", handleMouseLeave);
        anchor.removeEventListener("click", handleClick);
      });
    }

    return () => {
      for (const cleanup of cleanupCallbacks) {
        cleanup();
      }
    };
  }, [editor]);

  useEffect(() => {
    if (!editor) return;

    const changeElements = editor.view.dom.querySelectorAll<HTMLElement>(
      ".critic-change[data-critic-change-id]",
    );
    const cleanupCallbacks: Array<() => void> = [];

    for (const element of changeElements) {
      const changeId = element.dataset.criticChangeId;
      if (!changeId) continue;

      const handleMouseEnter = () => {
        setHoveredChangeId(changeId);
      };

      const handleMouseLeave = () => {
        setHoveredChangeId((current) =>
          current === changeId ? null : current,
        );
      };

      const handleClick = () => {
        setSelectedChangeId(changeId);
      };

      element.addEventListener("mouseenter", handleMouseEnter);
      element.addEventListener("mouseleave", handleMouseLeave);
      element.addEventListener("click", handleClick);
      cleanupCallbacks.push(() => {
        element.removeEventListener("mouseenter", handleMouseEnter);
        element.removeEventListener("mouseleave", handleMouseLeave);
        element.removeEventListener("click", handleClick);
      });
    }

    return () => {
      for (const cleanup of cleanupCallbacks) {
        cleanup();
      }
    };
  }, [editor]);

  useEffect(() => {
    const handleDocumentPointerDown = (event: PointerEvent) => {
      const selectedCommentId = selectedCommentIdRef.current;
      const emptyDraftCommentId =
        selectedCommentId &&
        commentsRef.current.get(selectedCommentId)?.content.trim() === ""
          ? selectedCommentId
          : ([...commentsRef.current.values()].find(
              (comment) => comment.content.trim() === "",
            )?.id ?? null);
      if (
        !selectedCommentId &&
        !selectedChangeIdRef.current &&
        !emptyDraftCommentId
      ) {
        return;
      }
      if (!shouldDismissCommentThread(event.target)) return;

      if (emptyDraftCommentId) {
        discardEmptyComment(emptyDraftCommentId);
      }
      setSelectedCommentId(null);
      setHoveredCommentId(null);
      setSelectedChangeId(null);
      setHoveredChangeId(null);
      setPendingFocusCommentId(null);
    };

    document.addEventListener("pointerdown", handleDocumentPointerDown, true);

    return () => {
      document.removeEventListener(
        "pointerdown",
        handleDocumentPointerDown,
        true,
      );
    };
  }, [discardEmptyComment]);

  useEffect(() => {
    const handleDocumentKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;

      const selectedCommentId = selectedCommentIdRef.current;
      const emptyDraftCommentId =
        selectedCommentId &&
        commentsRef.current.get(selectedCommentId)?.content.trim() === ""
          ? selectedCommentId
          : ([...commentsRef.current.values()].find(
              (comment) => comment.content.trim() === "",
            )?.id ?? null);

      if (!emptyDraftCommentId) return;

      if (discardEmptyComment(emptyDraftCommentId)) {
        event.preventDefault();
        setSelectedCommentId(null);
        setHoveredCommentId(null);
        setPendingFocusCommentId(null);
      }
    };

    document.addEventListener("keydown", handleDocumentKeyDown, true);

    return () => {
      document.removeEventListener("keydown", handleDocumentKeyDown, true);
    };
  }, [discardEmptyComment]);

  const handleAddComment = useCallback(() => {
    const currentEditor = editorRef.current;
    if (!currentEditor || currentEditor.state.selection.empty) return;

    const existingIds = getSelectionCommentIds(currentEditor);
    const comment = createCriticComment(undefined, {
      existingComments: commentsRef.current.values(),
    });
    const nextComments = new Map(commentsRef.current);
    nextComments.set(comment.id, comment);
    commentsRef.current = nextComments;
    setComments(nextComments);

    suppressNextMarkdownUpdateRef.current = true;
    currentEditor
      .chain()
      .focus()
      .setCommentRef({ commentIds: [...existingIds, comment.id] })
      .run();
    if (suppressNextMarkdownUpdateRef.current) {
      suppressNextMarkdownUpdateRef.current = false;
    }

    setSelectedCommentId(comment.id);
    setPendingFocusCommentId(comment.id);
    requestAnimationFrame(() => {
      measureLayout();
    });
  }, [measureLayout]);

  const handleSuggestDeletion = useCallback(() => {
    const currentEditor = editorRef.current;
    if (!currentEditor || currentEditor.state.selection.empty) return;

    const change = createCriticChange("deletion", undefined, {
      existingChanges: getDocumentCriticChanges(currentEditor),
    });

    currentEditor.chain().focus().setCriticChange(change).run();
    emitMarkdownChange(currentEditor.getJSON());
    refreshCriticChanges();
  }, [emitMarkdownChange, refreshCriticChanges]);

  const handleSuggestReplacement = useCallback(() => {
    const currentEditor = editorRef.current;
    if (!currentEditor || currentEditor.state.selection.empty) return;

    const { from, to } = currentEditor.state.selection;
    setDraftSuggestion({
      type: "replacement",
      from,
      to,
      sourceText: currentEditor.state.doc.textBetween(from, to, "\n"),
      text: "",
    });
  }, []);

  const applyDraftSuggestion = useCallback(() => {
    const currentEditor = editorRef.current;
    if (!currentEditor || !draftSuggestion) return;

    const nextText = draftSuggestion.text;
    if (!nextText) {
      setDraftSuggestion(null);
      return;
    }

    if (draftSuggestion.type === "insertion") {
      const change = createCriticChange("addition", undefined, {
        existingChanges: getDocumentCriticChanges(currentEditor),
      });

      currentEditor
        .chain()
        .focus()
        .insertContentAt(draftSuggestion.from, {
          type: "text",
          text: nextText,
          marks: [
            {
              type: "criticChange",
              attrs: change,
            },
          ],
        })
        .run();
      setSelectedChangeId(change.changeId);
      setDraftSuggestion(null);
      emitMarkdownChange(currentEditor.getJSON());
      refreshCriticChanges();
      return;
    }

    const change = createCriticChange("substitution-old", undefined, {
      existingChanges: getDocumentCriticChanges(currentEditor),
    });
    const replacementChange: CriticChangeAttrs = {
      ...change,
      kind: "substitution-new",
    };

    currentEditor
      .chain()
      .focus()
      .setTextSelection({ from: draftSuggestion.from, to: draftSuggestion.to })
      .setCriticChange(change)
      .insertContentAt(draftSuggestion.to, {
        type: "text",
        text: nextText,
        marks: [
          {
            type: "criticChange",
            attrs: replacementChange,
          },
        ],
      })
      .run();
    setSelectedChangeId(change.changeId);
    setDraftSuggestion(null);
    emitMarkdownChange(currentEditor.getJSON());
    refreshCriticChanges();
  }, [draftSuggestion, emitMarkdownChange, refreshCriticChanges]);

  const handleSuggestInsertion = useCallback(() => {
    const currentEditor = editorRef.current;
    if (!currentEditor) return;

    const { from } = currentEditor.state.selection;
    const before = currentEditor.state.doc.textBetween(
      Math.max(1, from - 24),
      from,
      " ",
    );
    const after = currentEditor.state.doc.textBetween(
      from,
      Math.min(currentEditor.state.doc.content.size, from + 24),
      " ",
    );

    setDraftSuggestion({
      type: "insertion",
      from,
      to: from,
      sourceText: `${before}▮${after}`.trim(),
      text: "",
    });
  }, []);

  const updateComment = useCallback(
    (commentId: string, updater: (comment: CriticComment) => CriticComment) => {
      const existingComment = commentsRef.current.get(commentId);
      if (!existingComment) return;

      const nextComments = new Map(commentsRef.current);
      nextComments.set(commentId, updater(existingComment));
      commentsRef.current = nextComments;
      setComments(nextComments);
      emitMarkdownChange(undefined, nextComments);
    },
    [emitMarkdownChange],
  );

  const removeSuggestionComments = useCallback(
    (changeId: string, currentEditor: Editor) => {
      const commentIdsToDelete = [...commentsRef.current.values()]
        .filter((comment) => comment.parentCommentId === changeId)
        .map((comment) => comment.id);

      if (commentIdsToDelete.length === 0) return commentsRef.current;

      const nextComments = new Map(commentsRef.current);
      for (const id of commentIdsToDelete) {
        nextComments.delete(id);
      }

      const chain = currentEditor.chain().focus();
      for (const id of commentIdsToDelete) {
        chain.removeCommentId(id);
      }
      chain.run();

      commentsRef.current = nextComments;
      setComments(nextComments);
      return nextComments;
    },
    [],
  );

  const acceptSuggestion = useCallback(
    (changeId: string) => {
      const currentEditor = editorRef.current;
      if (!currentEditor) return;

      currentEditor.chain().focus().acceptCriticChange(changeId).run();
      const nextComments = removeSuggestionComments(changeId, currentEditor);
      setSelectedChangeId((current) => (current === changeId ? null : current));
      setHoveredChangeId((current) => (current === changeId ? null : current));
      emitMarkdownChange(currentEditor.getJSON(), nextComments);
      refreshCriticChanges();
    },
    [emitMarkdownChange, refreshCriticChanges, removeSuggestionComments],
  );

  const rejectSuggestion = useCallback(
    (changeId: string) => {
      const currentEditor = editorRef.current;
      if (!currentEditor) return;

      currentEditor.chain().focus().rejectCriticChange(changeId).run();
      const nextComments = removeSuggestionComments(changeId, currentEditor);
      setSelectedChangeId((current) => (current === changeId ? null : current));
      setHoveredChangeId((current) => (current === changeId ? null : current));
      emitMarkdownChange(currentEditor.getJSON(), nextComments);
      refreshCriticChanges();
    },
    [emitMarkdownChange, refreshCriticChanges, removeSuggestionComments],
  );

  const deleteComment = useCallback(
    (commentId: string) => {
      const currentEditor = editorRef.current;
      if (!currentEditor) return;

      const deletedComment = commentsRef.current.get(commentId);
      const shouldCollapseAfterDelete =
        deletedComment?.content.trim().length === 0;
      const collapsePosition = currentEditor.state.selection.to;
      const commentIdsToDelete = [commentId];
      const deletedIds = new Set(commentIdsToDelete);
      const nextComments = new Map(commentsRef.current);
      for (const id of commentIdsToDelete) {
        nextComments.delete(id);
      }
      commentsRef.current = nextComments;
      setComments(nextComments);

      const chain = currentEditor.chain();
      if (!shouldCollapseAfterDelete) {
        chain.focus();
      }
      for (const id of commentIdsToDelete) {
        chain.removeCommentId(id);
      }
      if (shouldCollapseAfterDelete) {
        // Empty draft cancellation should close the composer, not refocus the
        // selected text and trigger a fresh auto-created comment.
        chain.setTextSelection(collapsePosition);
      }
      chain.run();
      if (shouldCollapseAfterDelete) {
        currentEditor.commands.blur();
      }
      setSelectedCommentId((current) =>
        current && deletedIds.has(current) ? null : current,
      );
      setHoveredCommentId((current) =>
        current && deletedIds.has(current) ? null : current,
      );
      setPendingFocusCommentId((current) =>
        current && deletedIds.has(current) ? null : current,
      );
      emitMarkdownChange(currentEditor.getJSON(), nextComments);
      requestAnimationFrame(() => {
        measureLayout();
      });
    },
    [emitMarkdownChange, measureLayout],
  );

  const selectComment = useCallback((commentId: string) => {
    setSelectedCommentId(commentId);
  }, []);

  const selectSuggestion = useCallback((changeId: string) => {
    setSelectedChangeId(changeId);
    setSelectedCommentId(null);
  }, []);

  const focusComment = useCallback((commentId: string) => {
    const currentEditor = editorRef.current;
    if (!currentEditor) return;

    setSelectedCommentId(commentId);
    setPendingFocusCommentId(commentId);

    const range = findCommentRange(currentEditor, commentId);
    if (range) {
      currentEditor.commands.focus(undefined, { scrollIntoView: false });
      currentEditor.view.dispatch(
        currentEditor.state.tr.setSelection(
          TextSelection.create(currentEditor.state.doc, range.from, range.to),
        ),
      );
      return;
    }

    if (!findCommentAnchorElement(currentEditor, commentId)) return;

    currentEditor.commands.focus(undefined, { scrollIntoView: false });
  }, []);

  const focusSuggestion = useCallback((changeId: string) => {
    const currentEditor = editorRef.current;
    if (!currentEditor) return;

    setSelectedChangeId(changeId);
    setSelectedCommentId(null);

    const range = getCriticChangeRange(currentEditor, changeId);
    if (!range) return;

    currentEditor.commands.focus(undefined, { scrollIntoView: false });
    currentEditor.view.dispatch(
      currentEditor.state.tr.setSelection(
        TextSelection.create(currentEditor.state.doc, range.from, range.to),
      ),
    );
  }, []);

  const suggestionCommentIds = new Set(
    criticChanges.flatMap((change) => change.commentIds),
  );
  const visibleCommentGroups = commentGroups
    .map((group) => ({
      ...group,
      commentIds: expandCommentIdsForLegacyReferences(
        group.commentIds,
        comments,
      ).filter((commentId) => !suggestionCommentIds.has(commentId)),
    }))
    .filter((group) =>
      group.commentIds.some((commentId) => comments.has(commentId)),
    );
  const activeCommentGroup = selectedCommentId
    ? visibleCommentGroups.find((group) =>
        group.commentIds.includes(selectedCommentId),
      )
    : null;
  const activeCommentPanelIds =
    activeCommentGroup && activeCommentGroup.commentIds.length > 0
      ? activeCommentGroup.commentIds
      : selectedCommentId
        ? getCommentThreadPanelIds(selectedCommentId, comments)
        : activeCommentIds;
  const activeCommentTop = activeCommentGroup
    ? Math.max(0, activeCommentGroup.anchorBottom + 8)
    : 0;
  const activeCommentLeft = activeCommentGroup
    ? Math.max(0, (activeCommentGroup.anchorRight ?? 0) + 8)
    : 0;
  const hasReviewRail = layout === "embedded-demo" || criticChanges.length > 0;
  const activeComments = activeCommentPanelIds
    .map((commentId) => comments.get(commentId))
    .filter((comment): comment is CriticComment => Boolean(comment));
  const contentCardClass =
    layout === "embedded-demo"
      ? "rounded-[0.75rem] border border-[#E9E9E8] dark:border-slate-700 bg-white dark:bg-card shadow-[0_18px_44px_rgba(57,47,38,0.08)] dark:shadow-[0_18px_44px_rgba(0,0,0,0.35)]"
      : "bg-transparent";
  const documentShellClass = cn(
    "document-page-shell",
    layout === "embedded-demo"
      ? "grid grid-cols-1 gap-3 p-4 min-[900px]:grid-cols-[minmax(0,min(100%,42rem))_minmax(13rem,16rem)] min-[900px]:items-start min-[900px]:justify-start"
      : "flex flex-col items-center gap-6",
    !hasReviewRail && "document-page-shell-no-comments",
    layout !== "embedded-demo" && !hasReviewRail && "justify-center",
  );
  const documentMainClass = cn(
    "document-page-main w-full min-w-0",
    layout === "embedded-demo" ? "max-w-none" : "max-w-[46.5rem]",
  );
  const contentInsetClass = layout === "embedded-demo" ? "pb-0" : "pb-24";
  const fallbackClass = cn(
    "document-comment-fallback",
    layout === "embedded-demo" ? "hidden" : "",
  );
  const reviewRailClass = cn(
    "document-comment-rail",
    layout === "embedded-demo"
      ? "block px-4 pb-4 min-[900px]:p-0"
      : "hidden min-[1100px]:block",
  );

  return (
    <div
      className="cursor-text bg-transparent"
      data-testid="page-card-rich-text"
    >
      <div data-testid="document-page-shell" className={documentShellClass}>
        <div className={documentMainClass}>
          <div className={contentInsetClass}>
            <div
              data-testid="document-content-card"
              className={cn(contentCardClass, "px-10 py-10 sm:px-14 sm:py-14")}
            >
              <EditorContextMenu
                editor={editor}
                backend={backend}
                resolveLinkUrl={resolveLinkUrl}
                onAddComment={
                  interactionMode === "viewing" ? undefined : handleAddComment
                }
                onSuggestDeletion={
                  interactionMode === "viewing"
                    ? undefined
                    : handleSuggestDeletion
                }
                onSuggestReplacement={
                  interactionMode === "viewing"
                    ? undefined
                    : handleSuggestReplacement
                }
                onSuggestInsertion={
                  interactionMode === "viewing"
                    ? undefined
                    : handleSuggestInsertion
                }
              >
                <div className="relative" data-testid="rich-text-editor">
                  <EditorContent editor={editor} />
                  {layout === "embedded-demo" ? null : (
                    <DocumentCommentMarkers
                      commentGroups={visibleCommentGroups}
                      comments={comments}
                      workingCommentIds={workingCommentIds}
                      selectedCommentId={selectedCommentId}
                      hoveredCommentId={hoveredCommentId}
                      onFocusComment={focusComment}
                      onHoverComment={setHoveredCommentId}
                    />
                  )}
                  {layout !== "embedded-demo" && activeComments.length > 0 ? (
                    <div
                      data-testid="document-comment-popover"
                      className={cn(
                        "absolute z-30 w-[min(22rem,calc(100vw-4rem))] rounded-[1rem] shadow-[0_18px_48px_rgba(0,0,0,0.28)]",
                        "border border-neutral-800 bg-[#141414] text-white",
                      )}
                      style={{
                        top: activeCommentTop,
                        left: `min(${activeCommentLeft}px, calc(100% - min(22rem, calc(100vw - 4rem))))`,
                      }}
                    >
                      <CommentEditorList
                        comments={activeComments}
                        className={fallbackClass}
                        variant="rail"
                        testId="document-comment-fallback"
                        selectedCommentId={selectedCommentId}
                        hoveredCommentId={hoveredCommentId}
                        onDeleteComment={deleteComment}
                        onUpdateComment={(commentId, nextContent) => {
                          updateComment(commentId, (current) => ({
                            ...current,
                            content: nextContent,
                          }));
                          onCommentSubmit?.(commentId);
                        }}
                        onSelectComment={selectComment}
                        onHoverComment={setHoveredCommentId}
                        pendingFocusCommentId={pendingFocusCommentId}
                        drafts={commentDrafts}
                        onDraftsChange={onCommentDraftsChange}
                        editingCommentIds={editingCommentIds}
                        onEditingCommentIdsChange={onEditingCommentIdsChange}
                        workingCommentIds={workingCommentIds}
                        onAutoFocusComment={(commentId) => {
                          setPendingFocusCommentId((current) =>
                            current === commentId ? null : current,
                          );
                        }}
                      />
                    </div>
                  ) : null}
                </div>
              </EditorContextMenu>
            </div>
          </div>
        </div>
        {hasReviewRail ? (
          <DocumentReviewRail
            className={reviewRailClass}
            layout={layout === "embedded-demo" ? "flow" : "anchored"}
            testId="document-review-rail"
            commentGroups={layout === "embedded-demo" ? commentGroups : []}
            comments={comments}
            suggestions={criticChanges}
            selectedCommentId={selectedCommentId}
            hoveredCommentId={hoveredCommentId}
            selectedChangeId={selectedChangeId}
            hoveredChangeId={hoveredChangeId}
            contentHeight={contentHeight}
            onDeleteComment={deleteComment}
            onUpdateComment={(commentId, nextContent) => {
              updateComment(commentId, (current) => ({
                ...current,
                content: nextContent,
              }));
              onCommentSubmit?.(commentId);
            }}
            onSelectComment={selectComment}
            onFocusComment={focusComment}
            onHoverComment={setHoveredCommentId}
            drafts={commentDrafts}
            onDraftsChange={onCommentDraftsChange}
            editingCommentIds={editingCommentIds}
            onEditingCommentIdsChange={onEditingCommentIdsChange}
            workingCommentIds={workingCommentIds}
            onAcceptSuggestion={acceptSuggestion}
            onRejectSuggestion={rejectSuggestion}
            onSelectSuggestion={selectSuggestion}
            onFocusSuggestion={focusSuggestion}
            onHoverSuggestion={setHoveredChangeId}
            pendingFocusCommentId={pendingFocusCommentId}
            onAutoFocusComment={(commentId) => {
              setPendingFocusCommentId((current) =>
                current === commentId ? null : current,
              );
            }}
            draftSuggestion={draftSuggestion}
            onDraftSuggestionTextChange={(text) => {
              setDraftSuggestion((current) =>
                current ? { ...current, text } : current,
              );
            }}
            onApplyDraftSuggestion={applyDraftSuggestion}
            onCancelDraftSuggestion={() => setDraftSuggestion(null)}
            editor={editor}
          />
        ) : null}
      </div>
    </div>
  );
});

const CodeEditorSurface = memo(function CodeEditorSurface({
  markdown,
  hasCommentRailSpace,
  interactionMode,
  layout,
  onMarkdownChange,
}: CodeEditorSurfaceProps) {
  const documentShellClass = cn(
    "document-page-shell",
    layout === "embedded-demo"
      ? "grid grid-cols-1 gap-3 p-4 min-[900px]:grid-cols-[minmax(0,min(100%,42rem))_minmax(13rem,16rem)] min-[900px]:items-start min-[900px]:justify-start"
      : "flex flex-col gap-6 min-[1100px]:grid min-[1100px]:grid-cols-[minmax(0,46.5rem)_minmax(24rem,1fr)] min-[1100px]:items-start min-[1100px]:justify-between min-[1100px]:gap-8",
    !hasCommentRailSpace && "document-page-shell-no-comments",
    layout !== "embedded-demo" &&
      !hasCommentRailSpace &&
      "min-[1100px]:grid-cols-[minmax(0,46.5rem)] min-[1100px]:justify-center",
  );
  const documentMainClass = cn(
    "document-page-main w-full min-w-0",
    layout === "embedded-demo" ? "max-w-none" : "max-w-[46.5rem]",
  );
  const contentInsetClass = layout === "embedded-demo" ? "pb-0" : "pb-24";
  const reviewRailClass = cn(
    "document-comment-rail pointer-events-none invisible",
    layout === "embedded-demo"
      ? "block px-4 pb-4 min-[900px]:p-0"
      : "hidden min-[1100px]:block",
  );

  return (
    <div className="cursor-text bg-transparent" data-testid="page-card-code">
      <div data-testid="document-page-shell" className={documentShellClass}>
        <div className={documentMainClass}>
          <div className={contentInsetClass}>
            <div
              className="min-h-[calc(70vh+4rem)] rounded-[0.75rem] border border-[#E9E9E8] dark:border-slate-700 bg-white dark:bg-card py-10 pr-6 pl-5 shadow-[0_18px_44px_rgba(57,47,38,0.08)] dark:shadow-[0_18px_44px_rgba(0,0,0,0.35)] sm:py-14 sm:pr-10 sm:pl-8"
              data-testid="document-content-card"
            >
              <MarkdownCodeEditor
                testId="markdown-code-editor"
                value={markdown}
                onChange={onMarkdownChange}
                readOnly={interactionMode === "viewing"}
                autoFocus
              />
            </div>
          </div>
        </div>
        {hasCommentRailSpace ? (
          <div
            data-testid="document-review-rail"
            className={reviewRailClass}
            aria-hidden="true"
          />
        ) : null}
      </div>
    </div>
  );
});

const PageCardEditorSurface = memo(function PageCardEditorSurface({
  page,
  activeDocumentPath,
  selected,
  layout,
  focusRequestKey,
  onSave,
  onSaveStateChange,
  editorViewMode,
  interactionMode,
  backend,
  onEditorReady,
  onCommentRailPresenceChange,
  onDirtyStateChange,
  onLocalContentChange,
  onSaveControllerChange,
  onCommentSubmit,
  saveBlocked = false,
  forceResetKey = null,
}: PageCardEditorSurfaceProps) {
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const workingCommentTimersRef = useRef(
    new Map<string, ReturnType<typeof window.setTimeout>>(),
  );
  const inFlightSaveRef = useRef<Promise<ManualSaveResult> | null>(null);
  const pendingMarkdownRef = useRef(page.content);
  const recentMarkdownRef = useRef<Set<string>>(new Set());
  const previousEditorViewModeRef = useRef<EditorViewMode>(editorViewMode);
  const lastAcceptedMarkdownRef = useRef(page.content);
  const localDirtyRef = useRef(false);
  const draftActiveRef = useRef(false);
  const forceResetKeyRef = useRef(forceResetKey);
  const [markdown, setMarkdown] = useState(page.content);
  const [richTextSourceMarkdown, setRichTextSourceMarkdown] = useState(
    page.content,
  );
  const [richTextSourceVersion, setRichTextSourceVersion] = useState(0);
  const [commentDrafts, setCommentDrafts] = useState<Record<string, string>>(
    {},
  );
  const [editingCommentIds, setEditingCommentIds] = useState<string[]>([]);
  const [workingCommentIds, setWorkingCommentIds] = useState<Set<string>>(
    () => new Set(),
  );

  const reportDirtyState = useCallback(
    (isDirty: boolean) => {
      if (localDirtyRef.current === isDirty) return;
      localDirtyRef.current = isDirty;
      onDirtyStateChange?.(isDirty || draftActiveRef.current);
    },
    [onDirtyStateChange],
  );

  const reportDraftActiveState = useCallback(
    (isActive: boolean) => {
      if (draftActiveRef.current === isActive) return;
      draftActiveRef.current = isActive;
      onDirtyStateChange?.(localDirtyRef.current || isActive);
    },
    [onDirtyStateChange],
  );

  useEffect(() => {
    reportDraftActiveState(
      editingCommentIds.length > 0 || Object.keys(commentDrafts).length > 0,
    );
  }, [commentDrafts, editingCommentIds.length, reportDraftActiveState]);

  const markCommentWorking = useCallback(
    (commentId: string) => {
      setWorkingCommentIds((current) => {
        const next = new Set(current);
        next.add(commentId);
        return next;
      });

      const existingTimer = workingCommentTimersRef.current.get(commentId);
      if (existingTimer !== undefined) {
        window.clearTimeout(existingTimer);
      }

      const timer = window.setTimeout(() => {
        workingCommentTimersRef.current.delete(commentId);
        setWorkingCommentIds((current) => {
          if (!current.has(commentId)) return current;
          const next = new Set(current);
          next.delete(commentId);
          return next;
        });
      }, 45_000);
      workingCommentTimersRef.current.set(commentId, timer);

      void Promise.resolve(onCommentSubmit?.(commentId)).catch((error) => {
        console.error("Failed to submit comment handoff:", error);
      });
    },
    [onCommentSubmit],
  );

  const acceptMarkdown = useCallback(
    (nextMarkdown: string) => {
      pendingMarkdownRef.current = nextMarkdown;
      lastAcceptedMarkdownRef.current = nextMarkdown;
      setMarkdown(nextMarkdown);
      setRichTextSourceMarkdown(nextMarkdown);
      setRichTextSourceVersion((current) => current + 1);
      onLocalContentChange?.(nextMarkdown);
      reportDirtyState(false);
      onSaveStateChange("saved");
    },
    [onLocalContentChange, onSaveStateChange, reportDirtyState],
  );

  const rememberRecentMarkdown = useCallback((nextMarkdown: string) => {
    recentMarkdownRef.current.add(nextMarkdown);
    if (recentMarkdownRef.current.size > 10) {
      const iterator = recentMarkdownRef.current.values();
      recentMarkdownRef.current.delete(iterator.next().value as string);
    }
  }, []);

  const performSave = useCallback(
    async (nextMarkdown: string): Promise<ManualSaveResult> => {
      if (saveBlocked) {
        onSaveStateChange(
          nextMarkdown === lastAcceptedMarkdownRef.current
            ? "saved"
            : "unsaved",
        );
        return { status: "blocked" };
      }

      rememberRecentMarkdown(nextMarkdown);
      onSaveStateChange("saving");

      try {
        await onSave(page.id, nextMarkdown);
        lastAcceptedMarkdownRef.current = nextMarkdown;
        reportDirtyState(pendingMarkdownRef.current !== nextMarkdown);
        onSaveStateChange(
          pendingMarkdownRef.current === nextMarkdown ? "saved" : "saving",
        );
        return { status: "saved" };
      } catch (error) {
        console.error("Failed to save page:", error);
        onSaveStateChange("error");
        return { status: "error", error };
      }
    },
    [
      onSave,
      onSaveStateChange,
      page.id,
      rememberRecentMarkdown,
      reportDirtyState,
      saveBlocked,
    ],
  );

  const scheduleSave = useCallback(
    (nextMarkdown: string) => {
      if (saveTimer.current) {
        clearTimeout(saveTimer.current);
        saveTimer.current = null;
      }

      if (saveBlocked) {
        onSaveStateChange(
          nextMarkdown === lastAcceptedMarkdownRef.current
            ? "saved"
            : "unsaved",
        );
        return;
      }

      onSaveStateChange("saving");
      saveTimer.current = setTimeout(() => {
        saveTimer.current = null;
        inFlightSaveRef.current = performSave(nextMarkdown).finally(() => {
          inFlightSaveRef.current = null;
        });
        void inFlightSaveRef.current;
      }, 500);
    },
    [onSaveStateChange, performSave, saveBlocked],
  );

  const flushSave = useCallback(async (): Promise<ManualSaveResult> => {
    if (saveTimer.current) {
      clearTimeout(saveTimer.current);
      saveTimer.current = null;
    }

    const currentMarkdown = pendingMarkdownRef.current;

    if (
      currentMarkdown === lastAcceptedMarkdownRef.current &&
      !inFlightSaveRef.current
    ) {
      onSaveStateChange("saved");
      return { status: "saved" };
    }

    if (inFlightSaveRef.current) {
      await inFlightSaveRef.current;
      if (pendingMarkdownRef.current === lastAcceptedMarkdownRef.current) {
        onSaveStateChange("saved");
        return { status: "saved" };
      }
    }

    return await performSave(pendingMarkdownRef.current);
  }, [onSaveStateChange, performSave]);

  useEffect(() => {
    onSaveControllerChange?.({ flushSave });
    return () => onSaveControllerChange?.(null);
  }, [flushSave, onSaveControllerChange]);

  const handleMarkdownChange = useCallback(
    (nextMarkdown: string) => {
      pendingMarkdownRef.current = nextMarkdown;
      setMarkdown(nextMarkdown);
      onLocalContentChange?.(nextMarkdown);
      reportDirtyState(nextMarkdown !== lastAcceptedMarkdownRef.current);
      scheduleSave(nextMarkdown);
    },
    [onLocalContentChange, reportDirtyState, scheduleSave],
  );

  useEffect(() => {
    const forceResetChanged = forceResetKeyRef.current !== forceResetKey;
    forceResetKeyRef.current = forceResetKey;

    if (forceResetChanged) {
      if (
        (localDirtyRef.current || draftActiveRef.current) &&
        markdown !== page.content
      ) {
        return;
      }
      recentMarkdownRef.current.delete(page.content);
      acceptMarkdown(page.content);
      return;
    }

    if (recentMarkdownRef.current.has(page.content)) {
      recentMarkdownRef.current.delete(page.content);
      lastAcceptedMarkdownRef.current = page.content;
      pendingMarkdownRef.current = markdown;
      reportDirtyState(markdown !== page.content);
      return;
    }

    if (localDirtyRef.current && markdown !== page.content) {
      return;
    }

    if (markdown === page.content) {
      lastAcceptedMarkdownRef.current = page.content;
      pendingMarkdownRef.current = page.content;
      reportDirtyState(false);
      return;
    }

    acceptMarkdown(page.content);
  }, [acceptMarkdown, forceResetKey, markdown, page.content, reportDirtyState]);

  useEffect(() => {
    if (!saveBlocked || !saveTimer.current) return;
    clearTimeout(saveTimer.current);
    saveTimer.current = null;
    onSaveStateChange(
      pendingMarkdownRef.current === lastAcceptedMarkdownRef.current
        ? "saved"
        : "unsaved",
    );
  }, [onSaveStateChange, saveBlocked]);

  useEffect(() => {
    const previousEditorViewMode = previousEditorViewModeRef.current;
    previousEditorViewModeRef.current = editorViewMode;

    if (previousEditorViewMode !== "code" || editorViewMode !== "rich-text") {
      return;
    }

    setRichTextSourceMarkdown(markdown);
    setRichTextSourceVersion((current) => current + 1);
  }, [editorViewMode, markdown]);

  useEffect(() => {
    return () => {
      if (saveTimer.current) {
        clearTimeout(saveTimer.current);
      }
      for (const timer of workingCommentTimersRef.current.values()) {
        window.clearTimeout(timer);
      }
      workingCommentTimersRef.current.clear();
    };
  }, []);

  const hasCommentRailSpace = useMemo(
    () => criticMarkdownHasReviewRail(markdown),
    [markdown],
  );

  useEffect(() => {
    if (editorViewMode !== "code") return;
    onCommentRailPresenceChange?.(hasCommentRailSpace);
  }, [editorViewMode, hasCommentRailSpace, onCommentRailPresenceChange]);

  if (editorViewMode === "code") {
    return (
      <CodeEditorSurface
        markdown={markdown}
        hasCommentRailSpace={hasCommentRailSpace}
        interactionMode={interactionMode}
        layout={layout}
        onMarkdownChange={handleMarkdownChange}
      />
    );
  }

  const effectiveRichTextSourceMarkdown =
    !localDirtyRef.current &&
    !draftActiveRef.current &&
    !recentMarkdownRef.current.has(page.content) &&
    markdown !== page.content
      ? page.content
      : richTextSourceMarkdown;

  return (
    <RichTextEditorSurface
      key={`${page.id}:${richTextSourceVersion}:${effectiveRichTextSourceMarkdown}`}
      page={page}
      activeDocumentPath={activeDocumentPath}
      selected={selected}
      layout={layout}
      focusRequestKey={focusRequestKey}
      sourceMarkdown={effectiveRichTextSourceMarkdown}
      onMarkdownChange={handleMarkdownChange}
      interactionMode={interactionMode}
      onCommentRailPresenceChange={onCommentRailPresenceChange}
      backend={backend}
      onEditorReady={onEditorReady}
      onCommentSubmit={markCommentWorking}
      commentDrafts={commentDrafts}
      onCommentDraftsChange={setCommentDrafts}
      editingCommentIds={editingCommentIds}
      onEditingCommentIdsChange={setEditingCommentIds}
      workingCommentIds={workingCommentIds}
    />
  );
});

export function PageCard({
  page,
  activeDocumentPath = null,
  selected = false,
  layout = "default",
  focusRequestKey = null,
  onSave,
  onSaveStateChange,
  editorViewMode = "rich-text",
  interactionMode = "editing",
  backend,
  onEditorReady,
  onCommentRailPresenceChange,
  onDirtyStateChange,
  onLocalContentChange,
  onSaveControllerChange,
  onCommentSubmit,
  saveBlocked,
  forceResetKey,
}: PageCardProps) {
  const [saveState, setSaveState] = useState<DocumentSaveState>("saved");

  useEffect(() => {
    onSaveStateChange?.(saveState);
  }, [onSaveStateChange, saveState]);

  return (
    <div className="w-full">
      <PageCardEditorSurface
        page={page}
        activeDocumentPath={activeDocumentPath}
        selected={selected}
        layout={layout}
        focusRequestKey={focusRequestKey}
        onSave={onSave}
        onSaveStateChange={setSaveState}
        editorViewMode={editorViewMode}
        interactionMode={interactionMode}
        backend={backend}
        onEditorReady={onEditorReady}
        onCommentRailPresenceChange={onCommentRailPresenceChange}
        onDirtyStateChange={onDirtyStateChange}
        onLocalContentChange={onLocalContentChange}
        onSaveControllerChange={onSaveControllerChange}
        onCommentSubmit={onCommentSubmit}
        saveBlocked={saveBlocked}
        forceResetKey={forceResetKey}
      />
    </div>
  );
}
