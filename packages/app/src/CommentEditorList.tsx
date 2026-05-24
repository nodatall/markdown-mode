import { Check, Trash2, X } from "lucide-react";
import {
  type Dispatch,
  type MouseEvent,
  type MutableRefObject,
  type ReactNode,
  type SetStateAction,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Button } from "./components/ui/button";
import { Textarea } from "./components/ui/textarea";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "./components/ui/tooltip";
import type { CriticComment } from "./critic-markup";
import { cn } from "./lib/utils";

interface CommentEditorListProps {
  comments: CriticComment[];
  variant?: "banner" | "rail";
  selectedCommentId?: string | null;
  hoveredCommentId?: string | null;
  className?: string;
  testId?: string;
  interactive?: boolean;
  onDeleteComment: (commentId: string) => void;
  onUpdateComment: (commentId: string, nextContent: string) => void;
  onSelectComment?: (commentId: string) => void;
  onHoverComment?: (commentId: string | null) => void;
  pendingFocusCommentId?: string | null;
  onAutoFocusComment?: (commentId: string) => void;
  drafts?: Record<string, string>;
  onDraftsChange?: Dispatch<SetStateAction<Record<string, string>>>;
  editingCommentIds?: string[];
  onEditingCommentIdsChange?: Dispatch<SetStateAction<string[]>>;
  workingCommentIds?: ReadonlySet<string>;
  isCommentEditable?: (comment: CriticComment) => boolean;
  renderCommentContent?: (context: CommentContentRenderContext) => ReactNode;
  getCommentActions?: (
    context: CommentActionsRenderContext,
  ) => CommentActionDefinition[];
}

export interface CommentActionDefinition {
  key: string;
  label: string;
  tone?: "neutral" | "danger";
  icon: ReactNode;
  compact?: boolean;
  onClick: (event: MouseEvent) => void;
}

export interface CommentContentRenderContext {
  comment: CriticComment;
  depth: number;
  isEditing: boolean;
  defaultContent: ReactNode;
}

export interface CommentActionsRenderContext {
  comment: CriticComment;
  depth: number;
  isEditing: boolean;
  defaultActions: CommentActionDefinition[];
}

export function CommentEditorList({
  comments,
  variant = "banner",
  selectedCommentId = null,
  hoveredCommentId = null,
  className,
  testId,
  interactive = true,
  onDeleteComment,
  onUpdateComment,
  onSelectComment,
  onHoverComment,
  pendingFocusCommentId = null,
  onAutoFocusComment,
  drafts: controlledDrafts,
  onDraftsChange,
  editingCommentIds: controlledEditingCommentIds,
  onEditingCommentIdsChange,
  workingCommentIds = new Set(),
  isCommentEditable = () => true,
  renderCommentContent,
  getCommentActions,
}: CommentEditorListProps) {
  const textareaRefs = useRef(new Map<string, HTMLTextAreaElement>());
  const focusedSelectedCommentIdRef = useRef<string | null>(null);
  const [internalDrafts, setInternalDrafts] = useState<Record<string, string>>(
    {},
  );
  const [internalEditingCommentIds, setInternalEditingCommentIds] = useState<
    string[]
  >([]);
  const drafts = controlledDrafts ?? internalDrafts;
  const editingCommentIds =
    controlledEditingCommentIds ?? internalEditingCommentIds;
  const setDrafts = onDraftsChange ?? setInternalDrafts;
  const setEditingCommentIds =
    onEditingCommentIdsChange ?? setInternalEditingCommentIds;
  const commentMap = useMemo(
    () => new Map(comments.map((comment) => [comment.id, comment])),
    [comments],
  );
  const hasActiveSelection =
    !!selectedCommentId &&
    comments.some((comment) => comment.id === selectedCommentId);

  useEffect(() => {
    const validCommentIds = new Set(comments.map((comment) => comment.id));

    setDrafts((current) => {
      const next = Object.fromEntries(
        Object.entries(current).filter(([commentId]) =>
          validCommentIds.has(commentId),
        ),
      );

      return Object.keys(next).length === Object.keys(current).length
        ? current
        : next;
    });
    setEditingCommentIds((current) =>
      current.every((commentId) => validCommentIds.has(commentId))
        ? current
        : current.filter((commentId) => validCommentIds.has(commentId)),
    );
  }, [comments, setDrafts, setEditingCommentIds]);

  useEffect(() => {
    if (!interactive) return;
    if (!pendingFocusCommentId) return;

    const pendingComment = commentMap.get(pendingFocusCommentId);
    if (!pendingComment) return;

    setDrafts((current) => {
      if (Object.hasOwn(current, pendingFocusCommentId)) {
        return current;
      }

      return {
        ...current,
        [pendingFocusCommentId]: pendingComment.content,
      };
    });
    setEditingCommentIds((current) =>
      current.includes(pendingFocusCommentId)
        ? current
        : [...current, pendingFocusCommentId],
    );
  }, [
    commentMap,
    interactive,
    pendingFocusCommentId,
    setDrafts,
    setEditingCommentIds,
  ]);

  useEffect(() => {
    if (!interactive) return;
    if (!pendingFocusCommentId) return;
    if (!editingCommentIds.includes(pendingFocusCommentId)) return;

    const target = textareaRefs.current.get(pendingFocusCommentId);
    if (!target?.isConnected) return;

    requestAnimationFrame(() => {
      target.focus();
      const cursorPosition = target.value.length;
      target.setSelectionRange(cursorPosition, cursorPosition);
      onAutoFocusComment?.(pendingFocusCommentId);
      focusedSelectedCommentIdRef.current = pendingFocusCommentId;
    });
  }, [
    editingCommentIds,
    interactive,
    onAutoFocusComment,
    pendingFocusCommentId,
  ]);

  useEffect(() => {
    if (!interactive) return;
    if (!selectedCommentId) {
      focusedSelectedCommentIdRef.current = null;
      return;
    }
    if (pendingFocusCommentId) return;
    if (focusedSelectedCommentIdRef.current === selectedCommentId) return;

    const selectedComment = commentMap.get(selectedCommentId);
    if (!selectedComment || !isCommentEditable(selectedComment)) return;

    const target = textareaRefs.current.get(selectedCommentId);
    if (!target?.isConnected) return;

    requestAnimationFrame(() => {
      target.focus();
      const cursorPosition = target.value.length;
      target.setSelectionRange(cursorPosition, cursorPosition);
      focusedSelectedCommentIdRef.current = selectedCommentId;
    });
  }, [
    commentMap,
    interactive,
    isCommentEditable,
    pendingFocusCommentId,
    selectedCommentId,
  ]);

  if (comments.length === 0) return null;

  const stopEditingComment = (commentId: string) => {
    setEditingCommentIds((current) =>
      current.filter((currentCommentId) => currentCommentId !== commentId),
    );
  };

  const submitEditingComment = (commentId: string) => {
    const comment = commentMap.get(commentId);
    if (!comment) return;

    const nextContent = (drafts[commentId] ?? comment.content).trim();

    if (nextContent.length === 0) {
      onDeleteComment(commentId);
      return;
    }

    if (nextContent !== comment.content) {
      onUpdateComment(commentId, nextContent);
    }

    setDrafts((current) => {
      const nextDrafts = { ...current };
      delete nextDrafts[commentId];
      return nextDrafts;
    });
    stopEditingComment(commentId);
  };

  const cancelEditingComment = (commentId: string) => {
    const comment = commentMap.get(commentId);
    if (!comment) return;

    setDrafts((current) => {
      const nextDrafts = { ...current };
      delete nextDrafts[commentId];
      return nextDrafts;
    });

    if (comment.content.trim().length === 0) {
      onDeleteComment(commentId);
      return;
    }

    stopEditingComment(commentId);
  };

  return (
    <div
      data-testid={testId}
      data-comment-thread-container="true"
      className={cn(
        variant === "banner"
          ? cn(
              "space-y-2 rounded-xl border border-transparent bg-transparent p-3 shadow-none transition-[background-color,border-color,box-shadow] duration-200 ease-out",
              hasActiveSelection
                ? "border-[#DFDFDC] dark:border-slate-600 bg-white dark:bg-card shadow-[0_20px_48px_rgba(57,47,38,0.14)] dark:shadow-[0_20px_48px_rgba(0,0,0,0.4)]"
                : "",
            )
          : "space-y-1.5 px-4 py-3",
        className,
      )}
    >
      {comments.map((comment, index) => (
        <CommentItem
          key={comment.id}
          comment={comment}
          index={index}
          variant={variant}
          interactive={interactive}
          drafts={drafts}
          selectedCommentId={selectedCommentId}
          hoveredCommentId={hoveredCommentId}
          textareaRefs={textareaRefs}
          onDeleteComment={onDeleteComment}
          onSelectComment={onSelectComment}
          onHoverComment={onHoverComment}
          onSubmitEditingComment={submitEditingComment}
          onCancelEditingComment={cancelEditingComment}
          workingCommentIds={workingCommentIds}
          isCommentEditable={isCommentEditable}
          renderCommentContent={renderCommentContent}
          getCommentActions={getCommentActions}
          onChangeDraft={(commentId, nextContent) => {
            setDrafts((current) => ({
              ...current,
              [commentId]: nextContent,
            }));
          }}
        />
      ))}
    </div>
  );
}

interface CommentItemProps {
  comment: CriticComment;
  index: number;
  variant: "banner" | "rail";
  interactive: boolean;
  drafts: Record<string, string>;
  selectedCommentId: string | null;
  hoveredCommentId: string | null;
  textareaRefs: MutableRefObject<Map<string, HTMLTextAreaElement>>;
  onDeleteComment: (commentId: string) => void;
  onSelectComment?: (commentId: string) => void;
  onHoverComment?: (commentId: string | null) => void;
  onSubmitEditingComment: (commentId: string) => void;
  onCancelEditingComment: (commentId: string) => void;
  workingCommentIds: ReadonlySet<string>;
  isCommentEditable: (comment: CriticComment) => boolean;
  renderCommentContent?: (context: CommentContentRenderContext) => ReactNode;
  getCommentActions?: (
    context: CommentActionsRenderContext,
  ) => CommentActionDefinition[];
  onChangeDraft: (commentId: string, nextContent: string) => void;
}

function CommentActionButton({
  label,
  testId,
  tone = "neutral",
  icon,
  compact = false,
  className,
  onClick,
}: {
  label: string;
  testId?: string;
  tone?: "neutral" | "danger";
  icon: ReactNode;
  compact?: boolean;
  className?: string;
  onClick: (event: MouseEvent) => void;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            data-testid={testId}
            variant="ghost"
            size={compact ? "icon-xs" : "sm"}
            className={cn(
              compact
                ? "rounded-full border border-transparent transition-colors duration-150"
                : "h-7 rounded-full border border-transparent px-2.5 text-[11px] font-medium tracking-[0.08em] uppercase transition-colors duration-150",
              tone === "danger"
                ? "text-stone-400 hover:bg-rose-100 hover:text-rose-700 dark:text-stone-500 dark:hover:bg-rose-900/40 dark:hover:text-rose-400"
                : "text-stone-400 hover:bg-[#DED8CE]/45 hover:text-stone-600 dark:text-stone-500 dark:hover:bg-slate-700 dark:hover:text-stone-300",
              className,
            )}
          >
            {icon}
            {compact ? null : <span>{label}</span>}
          </Button>
        }
        aria-label={label}
        onPointerDown={(event) => event.stopPropagation()}
        onClick={onClick}
      />
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

function CommentItem({
  comment,
  index,
  variant,
  interactive,
  drafts,
  selectedCommentId,
  hoveredCommentId,
  textareaRefs,
  onDeleteComment,
  onSelectComment,
  onHoverComment,
  onSubmitEditingComment,
  onCancelEditingComment,
  workingCommentIds,
  isCommentEditable,
  renderCommentContent,
  getCommentActions,
  onChangeDraft,
}: CommentItemProps) {
  const isSelected = comment.id === selectedCommentId;
  const isHovered = comment.id === hoveredCommentId;
  const isEditable = interactive && isCommentEditable(comment);
  const isEditing = isEditable;
  const isDraftComment = comment.content.trim().length === 0;
  const isWorking = workingCommentIds.has(comment.id);
  const draftContent = drafts[comment.id] ?? comment.content;
  const bodyTone =
    variant === "banner"
      ? isSelected
        ? "bg-white"
        : isHovered
          ? "bg-white"
          : "bg-transparent"
      : "bg-transparent";
  const defaultContent =
    comment.content.trim().length > 0 ? comment.content : "Empty comment";
  const renderedContent =
    renderCommentContent?.({
      comment,
      depth: 0,
      isEditing,
      defaultContent,
    }) ?? defaultContent;
  const defaultActions: CommentActionDefinition[] = isEditing
    ? [
        {
          key: "save",
          label: "Save",
          icon: <Check className="size-3.5" />,
          onClick: (event) => {
            event.stopPropagation();
            onSubmitEditingComment(comment.id);
          },
        },
        {
          key: "cancel",
          label: "Cancel",
          icon: <X className="size-3.5" />,
          onClick: (event) => {
            event.stopPropagation();
            onCancelEditingComment(comment.id);
          },
        },
      ]
    : [];
  const actions =
    getCommentActions?.({
      comment,
      depth: 0,
      isEditing,
      defaultActions,
    }) ?? defaultActions;
  const canSubmitDraft = draftContent.trim().length > 0;
  const submitLabel = isDraftComment ? "Add" : "Save";

  return (
    <div
      data-testid={`comment-${variant}-${comment.id}`}
      data-comment-thread-root-id={comment.id}
      tabIndex={interactive ? 0 : undefined}
      className={cn(
        "relative transition-all duration-200 ease-out focus:outline-none focus-visible:ring-2 focus-visible:ring-stone-300 dark:focus-visible:ring-slate-600",
        variant === "rail" &&
          (index > 0
            ? "border-t border-slate-200/80 dark:border-slate-700/80 pt-3"
            : "pt-0"),
      )}
      onClick={() => {
        if (!interactive) return;
        onSelectComment?.(comment.id);
      }}
      onMouseEnter={() => {
        if (!interactive) return;
        onHoverComment?.(comment.id);
      }}
      onMouseLeave={() => {
        if (!interactive) return;
        onHoverComment?.(null);
      }}
      onPointerDown={() => {
        if (!interactive) return;
        onSelectComment?.(comment.id);
      }}
    >
      <div className="relative flex min-w-0 items-stretch">
        <div className="min-w-0 flex-1">
          <div className="relative grid grid-cols-1">
            {interactive && !isDraftComment ? (
              <CommentActionButton
                label="Delete comment"
                testId={`comment-${variant}-${comment.id}-action-delete-thread`}
                tone="danger"
                icon={<Trash2 className="size-3.5" />}
                compact
                className="absolute top-0 right-0 z-20 bg-transparent text-neutral-500 hover:bg-neutral-800 hover:text-neutral-200"
                onClick={(event) => {
                  event.stopPropagation();
                  onDeleteComment(comment.id);
                }}
              />
            ) : null}
            <div
              className={cn(
                "min-w-0 rounded-xl px-0.5",
                interactive && !isDraftComment && "pr-7",
                bodyTone,
              )}
            >
              <div
                className={cn(
                  "text-sm leading-6 whitespace-pre-wrap",
                  variant === "banner"
                    ? "text-slate-800 dark:text-slate-200"
                    : "text-slate-700 dark:text-slate-300",
                )}
              >
                {isEditing ? null : renderedContent}
              </div>
              {!isEditing && isWorking ? (
                <div
                  className="mt-2 inline-flex items-center gap-1.5 rounded-full bg-sky-50 px-2 py-1 text-[11px] font-medium text-sky-700 dark:bg-sky-950/40 dark:text-sky-300"
                  data-testid={`comment-${variant}-${comment.id}-working`}
                >
                  <span
                    className="size-2 animate-pulse rounded-full bg-sky-500 dark:bg-sky-300"
                    aria-hidden="true"
                  />
                  Working
                </div>
              ) : null}
              {isEditing ? (
                <Textarea
                  data-testid={`comment-${variant}-${comment.id}-editor`}
                  ref={(node) => {
                    if (node) {
                      textareaRefs.current.set(comment.id, node);
                    } else {
                      textareaRefs.current.delete(comment.id);
                    }
                  }}
                  value={draftContent}
                  placeholder={
                    isDraftComment ? "What should change?" : "Add your comment"
                  }
                  rows={1}
                  className="mt-1 min-h-12 rounded-lg border-sky-500/90 bg-[#181818] px-3 py-2 text-sm leading-6 text-neutral-100 shadow-none placeholder:text-neutral-500 focus:border-sky-400 focus:ring-2 focus:ring-sky-500/20 md:text-sm md:leading-6"
                  onPointerDown={(event) => {
                    event.stopPropagation();
                    onSelectComment?.(comment.id);
                  }}
                  onClick={(event) => {
                    event.stopPropagation();
                  }}
                  onKeyDown={(event) => {
                    if (
                      (event.metaKey || event.ctrlKey) &&
                      event.key.toLowerCase() === "enter"
                    ) {
                      event.preventDefault();
                      event.stopPropagation();
                      onSubmitEditingComment(comment.id);
                      return;
                    }

                    if (event.key !== "Escape") return;

                    event.preventDefault();
                    event.stopPropagation();
                    onCancelEditingComment(comment.id);
                  }}
                  onFocus={() => {
                    onSelectComment?.(comment.id);
                  }}
                  onBlur={(event) => {
                    if (!isDraftComment || draftContent.trim().length > 0) {
                      return;
                    }

                    const nextFocusedElement = event.relatedTarget;
                    const commentContainer = event.currentTarget.closest(
                      '[data-comment-thread-container="true"]',
                    );
                    if (
                      nextFocusedElement instanceof Element &&
                      commentContainer?.contains(nextFocusedElement)
                    ) {
                      return;
                    }

                    onCancelEditingComment(comment.id);
                  }}
                  onChange={(event) => {
                    onChangeDraft(comment.id, event.target.value);
                  }}
                />
              ) : null}
              {isEditing ? (
                <div className="mt-3 flex items-center justify-end gap-2">
                  <Button
                    type="button"
                    data-testid={`comment-${variant}-${comment.id}-action-cancel`}
                    variant="ghost"
                    size="sm"
                    className="h-8 rounded-full px-3 text-sm font-medium text-neutral-400 hover:bg-neutral-800 hover:text-neutral-100"
                    onPointerDown={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      onCancelEditingComment(comment.id);
                    }}
                    onMouseDown={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      onCancelEditingComment(comment.id);
                    }}
                    onClick={(event) => {
                      event.stopPropagation();
                      onCancelEditingComment(comment.id);
                    }}
                  >
                    Cancel
                  </Button>
                  <Button
                    type="button"
                    data-testid={`comment-${variant}-${comment.id}-action-save`}
                    size="sm"
                    className="h-8 rounded-full bg-sky-600 px-4 text-sm font-medium text-white hover:bg-sky-500 disabled:cursor-not-allowed disabled:opacity-50"
                    disabled={!canSubmitDraft}
                    onPointerDown={(event) => event.stopPropagation()}
                    onClick={(event) => {
                      event.stopPropagation();
                      onSubmitEditingComment(comment.id);
                    }}
                  >
                    {submitLabel}
                  </Button>
                </div>
              ) : (
                <div className="mt-2 flex flex-wrap items-center gap-1">
                  {actions.map((action) => (
                    <CommentActionButton
                      key={action.key}
                      label={action.label}
                      testId={`comment-${variant}-${comment.id}-action-${action.key}`}
                      tone={action.tone}
                      icon={action.icon}
                      compact={action.compact}
                      onClick={action.onClick}
                    />
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
