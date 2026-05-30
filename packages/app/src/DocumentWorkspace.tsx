import { AlertTriangle, Check, Copy, Loader2, Send } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DocumentEditorViewMode } from "./app-navigation";
import { RemoteSessionBanner } from "./components/RemoteSessionBanner";
import { Button } from "./components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "./components/ui/popover";
import { criticMarkdownHasReviewRail } from "./critic-markup";
import { cn } from "./lib/utils";
import {
  type DocumentInteractionMode,
  type DocumentSaveController,
  type DocumentSaveState,
  PageCard,
} from "./PageCard";
import { buildReviewPrompt } from "./review-prompt";
import type { AgentCommentSession, Page, StorageBackend } from "./storage";

type DiskChangeState = "clean" | "changed" | "conflict" | "paused";
type ReviewPromptCopyState = "idle" | "copying" | "copied" | "error";
type AgentCommentSubmitState =
  | "idle"
  | "submitting"
  | "working"
  | "applied"
  | "needs_attention"
  | "error";

function getSaveStatusViewModel(
  saveState: DocumentSaveState,
  diskChangeState: DiskChangeState,
) {
  if (diskChangeState === "conflict") {
    return {
      label: "Save conflict",
      ariaLabel: "Save conflict",
      tone: "warning" as const,
      Icon: AlertTriangle,
    };
  }

  if (diskChangeState === "changed") {
    return {
      label: "File changed on disk",
      ariaLabel: "File changed on disk",
      tone: "warning" as const,
      Icon: AlertTriangle,
    };
  }

  if (diskChangeState === "paused") {
    return {
      label: "Autosave paused",
      ariaLabel: "Autosave paused",
      tone: "warning" as const,
      Icon: AlertTriangle,
    };
  }

  if (saveState === "saving") {
    return {
      label: "Saving",
      ariaLabel: "Saving",
      tone: "neutral" as const,
      Icon: Loader2,
    };
  }

  if (saveState === "error") {
    return {
      label: "Save failed",
      ariaLabel: "Save failed",
      tone: "danger" as const,
      Icon: AlertTriangle,
    };
  }

  if (saveState === "unsaved") {
    return {
      label: "Unsaved changes",
      ariaLabel: "Unsaved changes",
      tone: "warning" as const,
      Icon: AlertTriangle,
    };
  }

  return {
    label: "Saved",
    ariaLabel: "Saved",
    tone: "success" as const,
    Icon: Check,
  };
}

export function DocumentSaveStatusIndicator({
  saveState,
  diskChangeState,
}: {
  saveState: DocumentSaveState;
  diskChangeState: DiskChangeState;
}) {
  const saveStatus = getSaveStatusViewModel(saveState, diskChangeState);
  const SaveStatusIcon = saveStatus.Icon;

  return (
    <span
      data-testid="document-save-status"
      role="status"
      aria-label={saveStatus.ariaLabel}
      className={cn(
        "inline-flex h-7 max-w-full shrink-0 items-center gap-1.5 px-1 font-mono text-[0.68rem] leading-none text-stone-400 dark:text-stone-500",
      )}
    >
      <SaveStatusIcon
        className={cn(
          "size-3.5 shrink-0",
          saveStatus.label === "Saving" && "animate-spin",
        )}
        aria-hidden="true"
      />
      <span className="min-w-0 truncate">{saveStatus.label}</span>
    </span>
  );
}

export function isAgentCommentSubmitBlocked({
  saveState,
  documentDiskChangeState,
}: {
  saveState: DocumentSaveState;
  documentDiskChangeState: DiskChangeState;
}) {
  return (
    saveState === "saving" ||
    saveState === "unsaved" ||
    saveState === "error" ||
    documentDiskChangeState !== "clean"
  );
}

function isAbsolutePath(path: string) {
  return path.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(path);
}

function reviewPromptFilePath(
  activeDocumentPath: string,
  backend: StorageBackend | null,
) {
  if (isAbsolutePath(activeDocumentPath)) return activeDocumentPath;

  const projectPath = backend?.info.projectPath;
  if (!projectPath) return activeDocumentPath;

  const separator = projectPath.includes("\\") ? "\\" : "/";
  return `${projectPath.replace(/[\\/]+$/, "")}${separator}${activeDocumentPath.replace(/^[\\/]+/, "")}`;
}

interface DocumentWorkspaceProps {
  documentPage: Page | null;
  activeDocumentPath: string | null;
  documentFilenameLabel: string;
  documentEditorViewMode: DocumentEditorViewMode;
  onSaveDocument: (id: string, content: string) => Promise<void>;
  onDocumentSaveStateChange: (state: DocumentSaveState) => void;
  onDocumentDirtyStateChange: (isDirty: boolean) => void;
  onDocumentLocalContentChange: (markdown: string) => void;
  documentDiskChangeState: DiskChangeState;
  documentForceResetKey: string | null;
  backend: StorageBackend | null;
}

export function DocumentWorkspace({
  documentPage,
  activeDocumentPath,
  documentFilenameLabel,
  documentEditorViewMode,
  onSaveDocument,
  onDocumentSaveStateChange,
  onDocumentDirtyStateChange,
  onDocumentLocalContentChange,
  documentDiskChangeState,
  documentForceResetKey,
  backend,
}: DocumentWorkspaceProps) {
  const [documentInteractionMode] =
    useState<DocumentInteractionMode>("editing");
  const [saveState, setSaveState] = useState<DocumentSaveState>("saved");
  const [agentCommentState, setAgentCommentState] =
    useState<AgentCommentSubmitState>("idle");
  const [agentCommentStatusText, setAgentCommentStatusText] = useState("");
  const [agentSession, setAgentSession] = useState<AgentCommentSession | null>(
    null,
  );
  const [reviewPromptCopyState, setReviewPromptCopyState] =
    useState<ReviewPromptCopyState>("idle");
  const [currentMarkdown, setCurrentMarkdown] = useState(
    documentPage?.content ?? "",
  );
  const saveControllerRef = useRef<DocumentSaveController | null>(null);

  const handleSaveStateChange = useCallback(
    (state: DocumentSaveState) => {
      setSaveState(state);
      onDocumentSaveStateChange(state);
    },
    [onDocumentSaveStateChange],
  );

  useEffect(() => {
    const documentIdentity = `${activeDocumentPath ?? ""}:${documentPage?.id ?? ""}`;
    if (!documentIdentity) return;
    setAgentCommentState("idle");
    setAgentCommentStatusText("");
    setAgentSession(null);
    setReviewPromptCopyState("idle");
  }, [activeDocumentPath, documentPage?.id]);

  useEffect(() => {
    setCurrentMarkdown(documentPage?.content ?? "");
  }, [documentPage?.content]);

  useEffect(() => {
    if (!backend?.getAgentCommentSession || !activeDocumentPath) {
      setAgentSession(null);
      return;
    }

    let cancelled = false;
    const refreshAgentSession = async () => {
      try {
        const session =
          await backend.getAgentCommentSession?.(activeDocumentPath);
        if (!cancelled) {
          setAgentSession(session ?? null);
        }
      } catch {
        if (!cancelled) {
          setAgentSession(null);
        }
      }
    };

    void refreshAgentSession();
    return () => {
      cancelled = true;
    };
  }, [activeDocumentPath, backend]);

  useEffect(() => {
    if (!documentPage) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      const isSaveShortcut =
        event.key.toLowerCase() === "s" &&
        (event.metaKey || event.ctrlKey) &&
        !event.altKey;

      if (!isSaveShortcut) return;

      event.preventDefault();
      event.stopPropagation();

      if (documentDiskChangeState !== "clean") return;

      void saveControllerRef.current?.flushSave();
    };

    window.addEventListener("keydown", handleKeyDown, { capture: true });
    return () => {
      window.removeEventListener("keydown", handleKeyDown, { capture: true });
    };
  }, [documentDiskChangeState, documentPage]);

  const handleCommentSubmit = useCallback(
    async (commentId: string) => {
      if (!activeDocumentPath || agentCommentState === "submitting") {
        return false;
      }

      setAgentCommentState("submitting");
      setAgentCommentStatusText("Submitting comment");
      try {
        const saveResult = await saveControllerRef.current?.flushSave();
        if (saveResult && saveResult.status !== "saved") {
          setAgentCommentState(
            saveResult.status === "blocked" ? "idle" : "error",
          );
          setAgentCommentStatusText(
            saveResult.status === "blocked"
              ? ""
              : "Could not save before submitting the comment.",
          );
          return false;
        }

        if (
          !backend?.submitAgentCommentTask ||
          !agentSession?.adapter.available
        ) {
          setAgentCommentState("needs_attention");
          setAgentCommentStatusText(
            agentSession?.adapter.reason ??
              "No agent adapter is available. Use the copy prompt fallback.",
          );
          return false;
        }

        const result = await backend.submitAgentCommentTask(
          activeDocumentPath,
          {
            commentId,
          },
        );
        const task = result.task;
        if (task.status === "accepted" || task.status === "working") {
          setAgentCommentState("working");
          setAgentCommentStatusText("Agent task submitted");
          return true;
        }
        if (task.status === "applied") {
          setAgentCommentState("applied");
          setAgentCommentStatusText("Agent applied the comment");
          return false;
        }
        setAgentCommentState(
          task.status === "failed" ? "error" : "needs_attention",
        );
        setAgentCommentStatusText(
          task.error ?? "The agent task needs attention.",
        );
        return false;
      } catch (error) {
        console.error("Failed to submit agent comment task:", error);
        setAgentCommentState("error");
        setAgentCommentStatusText(
          "Markdown Mode could not submit this comment to an agent.",
        );
        return false;
      }
    },
    [activeDocumentPath, agentCommentState, agentSession, backend],
  );

  const handleLocalContentChange = useCallback(
    (markdown: string) => {
      setCurrentMarkdown(markdown);
      setReviewPromptCopyState((current) =>
        current === "copied" || current === "error" ? "idle" : current,
      );
      onDocumentLocalContentChange(markdown);
    },
    [onDocumentLocalContentChange],
  );

  const hasReviewFeedback = useMemo(
    () => criticMarkdownHasReviewRail(currentMarkdown),
    [currentMarkdown],
  );

  const canCopyReviewPrompt =
    !!activeDocumentPath &&
    hasReviewFeedback &&
    agentCommentState !== "submitting" &&
    agentCommentState !== "working" &&
    agentSession?.adapter.available !== true;

  const handleCopyReviewPrompt = useCallback(async () => {
    if (!activeDocumentPath || !canCopyReviewPrompt) return;

    setReviewPromptCopyState("copying");
    try {
      if (saveState === "unsaved") {
        const saveResult = await saveControllerRef.current?.flushSave();
        if (saveResult && saveResult.status !== "saved") {
          setReviewPromptCopyState("error");
          return;
        }
      }

      await navigator.clipboard.writeText(
        buildReviewPrompt({
          filePath: reviewPromptFilePath(activeDocumentPath, backend),
          markdown: currentMarkdown,
        }),
      );
      setReviewPromptCopyState("copied");
      window.setTimeout(() => setReviewPromptCopyState("idle"), 1800);
    } catch (error) {
      console.error("Failed to copy review prompt:", error);
      setReviewPromptCopyState("error");
    }
  }, [
    activeDocumentPath,
    backend,
    canCopyReviewPrompt,
    currentMarkdown,
    saveState,
  ]);

  const showAgentCommentStatus =
    !!activeDocumentPath && agentCommentState !== "idle";
  const showCopyReviewPromptButton = canCopyReviewPrompt;
  const copyReviewPromptLabel =
    reviewPromptCopyState === "copied"
      ? "Copied review prompt"
      : reviewPromptCopyState === "error"
        ? "Copy failed"
        : "Copy review prompt";
  const agentStatusTitle =
    agentCommentState === "submitting"
      ? "Submitting comment"
      : agentCommentState === "working"
        ? "Agent is working"
        : agentCommentState === "applied"
          ? "Agent applied comment"
          : agentCommentState === "needs_attention"
            ? "Agent unavailable"
            : "Could not submit comment";
  const AgentStatusIcon =
    agentCommentState === "submitting"
      ? Loader2
      : agentCommentState === "working"
        ? Send
        : agentCommentState === "applied"
          ? Check
          : AlertTriangle;
  const inlineAgentLabel =
    agentCommentState === "submitting"
      ? "Submitting"
      : agentCommentState === "working"
        ? "Agent working"
        : agentSession?.mode === "attached"
          ? "Connected to thread"
          : agentSession?.adapter.available
            ? "Detached agent ready"
            : "Detached";

  return (
    <div
      className={cn("min-h-0 flex-1 overflow-y-auto px-8 pt-10 pb-8 sm:px-12")}
    >
      <RemoteSessionBanner backend={backend} />
      <div
        className="fixed top-3 right-3 z-[60] flex max-w-[min(16rem,calc(100vw-1rem))] flex-col items-end gap-1.5"
        data-testid="document-status-stack"
        data-document-status-stack="true"
      >
        {showAgentCommentStatus ? (
          <Popover>
            <PopoverTrigger
              render={
                <Button
                  type="button"
                  data-testid="agent-comment-task-button"
                  size="lg"
                  aria-label={agentStatusTitle}
                  title={agentStatusTitle}
                  className="size-9 rounded-full bg-black p-0 text-white shadow-[0_10px_28px_rgba(0,0,0,0.18)] hover:bg-black/85 focus-visible:ring-black/25 dark:bg-black dark:text-white dark:hover:bg-black/85 dark:focus-visible:ring-white/30"
                >
                  <AgentStatusIcon
                    className={cn(
                      "size-4",
                      agentCommentState === "submitting" && "animate-spin",
                    )}
                  />
                </Button>
              }
            />
            <PopoverContent
              aria-label="Agent comment task status"
              data-testid="agent-comment-task-status"
            >
              <div className="flex items-start gap-3">
                <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full bg-black text-white dark:bg-white dark:text-black">
                  {agentCommentState === "submitting" ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : agentCommentState === "error" ||
                    agentCommentState === "needs_attention" ? (
                    <AlertTriangle className="size-4" />
                  ) : (
                    <AgentStatusIcon className="size-4" />
                  )}
                </span>
                <div>
                  <div className="text-sm font-semibold text-stone-950 dark:text-slate-50">
                    {agentStatusTitle}
                  </div>
                  <p className="mt-1 text-sm leading-6 text-stone-600 dark:text-slate-300">
                    {agentCommentStatusText ||
                      "Markdown Mode submitted the saved comment as an agent task."}
                  </p>
                </div>
              </div>
            </PopoverContent>
          </Popover>
        ) : null}
        {showCopyReviewPromptButton ? (
          <Button
            type="button"
            data-testid="review-copy-prompt-button"
            size="lg"
            aria-label={copyReviewPromptLabel}
            title={copyReviewPromptLabel}
            className="size-9 rounded-full bg-black p-0 text-white shadow-[0_10px_28px_rgba(0,0,0,0.18)] hover:bg-black/85 focus-visible:ring-black/25 dark:bg-black dark:text-white dark:hover:bg-black/85 dark:focus-visible:ring-white/30"
            disabled={
              reviewPromptCopyState === "copying" ||
              saveState === "saving" ||
              saveState === "error" ||
              documentDiskChangeState !== "clean"
            }
            onClick={() => void handleCopyReviewPrompt()}
          >
            {reviewPromptCopyState === "copied" ? (
              <Check className="size-4" />
            ) : reviewPromptCopyState === "copying" ? (
              <Loader2 className="size-4 animate-spin" />
            ) : reviewPromptCopyState === "error" ? (
              <AlertTriangle className="size-4" />
            ) : (
              <Copy className="size-4" />
            )}
          </Button>
        ) : null}
        {documentPage ? (
          <DocumentSaveStatusIndicator
            saveState={saveState}
            diskChangeState={documentDiskChangeState}
          />
        ) : null}
      </div>
      <div className="mx-auto min-h-full max-w-[1080px]">
        {documentPage ? (
          <div
            data-testid="document-page-header"
            className="document-page-shell document-page-shell-no-comments mb-2 flex justify-center text-[0.62rem] font-medium tracking-[0.01em] text-stone-400"
          >
            <div className="document-page-main w-full max-w-[46.5rem] min-w-0">
              <div className="flex w-full items-center px-1">
                <div
                  className="min-w-0 truncate font-mono text-[0.7rem] tracking-[0.01em] text-stone-400 dark:text-stone-500"
                  title={documentFilenameLabel}
                >
                  {documentFilenameLabel}
                </div>
                {activeDocumentPath ? (
                  <div className="ml-auto flex shrink-0 items-center gap-1.5">
                    {agentSession || agentCommentState !== "idle" ? (
                      <span
                        data-testid="agent-comment-inline-status"
                        role="status"
                        aria-label="Agent comment session"
                        className="inline-flex shrink-0 items-center gap-1 font-mono text-[0.6rem] tracking-[0.01em] text-stone-400 dark:text-stone-500"
                      >
                        {agentCommentState === "submitting" ? (
                          <Loader2 className="size-[0.6rem] animate-spin" />
                        ) : agentCommentState === "error" ||
                          agentCommentState === "needs_attention" ? (
                          <AlertTriangle className="size-[0.6rem]" />
                        ) : agentCommentState === "working" ? (
                          <Send className="size-[0.6rem]" />
                        ) : agentSession?.mode === "attached" ? (
                          <Send className="size-[0.6rem]" />
                        ) : agentSession?.adapter.available ? (
                          <Send className="size-[0.6rem]" />
                        ) : (
                          <Copy className="size-[0.6rem]" />
                        )}
                        {inlineAgentLabel}
                      </span>
                    ) : null}
                  </div>
                ) : null}
              </div>
            </div>
          </div>
        ) : null}
        {documentPage ? (
          backend ? (
            <PageCard
              key={`${documentPage.id}:${activeDocumentPath ?? ""}`}
              page={documentPage}
              activeDocumentPath={activeDocumentPath}
              selected
              onSave={onSaveDocument}
              onSaveStateChange={handleSaveStateChange}
              editorViewMode={documentEditorViewMode}
              interactionMode={documentInteractionMode}
              backend={backend}
              onDirtyStateChange={onDocumentDirtyStateChange}
              onLocalContentChange={handleLocalContentChange}
              onSaveControllerChange={(controller) => {
                saveControllerRef.current = controller;
              }}
              onCommentSubmit={handleCommentSubmit}
              saveBlocked={documentDiskChangeState !== "clean"}
              forceResetKey={documentForceResetKey}
            />
          ) : null
        ) : (
          <div className="flex min-h-[50vh] items-center justify-center text-sm text-slate-500 dark:text-slate-400">
            Open a markdown file to begin.
          </div>
        )}
      </div>
    </div>
  );
}
