import { AlertTriangle, Check, CheckCheck, Copy, Loader2 } from "lucide-react";
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
import type { Page, StorageBackend } from "./storage";

type DiskChangeState = "clean" | "changed" | "conflict" | "paused";
type ReviewHandoffState =
  | "idle"
  | "notifying"
  | "notified"
  | "undelivered"
  | "error";
type ReviewPromptCopyState = "idle" | "copying" | "copied" | "error";

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

export function isReviewHandoffDisabled({
  saveState,
  documentDiskChangeState,
  reviewHandoffState,
}: {
  saveState: DocumentSaveState;
  documentDiskChangeState: DiskChangeState;
  reviewHandoffState: ReviewHandoffState;
}) {
  return (
    saveState === "saving" ||
    saveState === "unsaved" ||
    saveState === "error" ||
    reviewHandoffState !== "idle" ||
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
  onCompleteReview: () => Promise<{ delivered: boolean }>;
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
  onCompleteReview,
  backend,
}: DocumentWorkspaceProps) {
  const [documentInteractionMode] =
    useState<DocumentInteractionMode>("editing");
  const [saveState, setSaveState] = useState<DocumentSaveState>("saved");
  const [reviewHandoffState, setReviewHandoffState] =
    useState<ReviewHandoffState>("idle");
  const [reviewPromptCopyState, setReviewPromptCopyState] =
    useState<ReviewPromptCopyState>("idle");
  const [currentMarkdown, setCurrentMarkdown] = useState(
    documentPage?.content ?? "",
  );
  const [reviewWatcherCount, setReviewWatcherCount] = useState(0);
  const sawNoWatcherAfterNotifiedRef = useRef(false);
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
    setReviewHandoffState("idle");
    setReviewPromptCopyState("idle");
    setCurrentMarkdown(documentPage?.content ?? "");
  }, [activeDocumentPath, documentPage?.content, documentPage?.id]);

  useEffect(() => {
    if (!backend?.getReviewWatchStatus || !activeDocumentPath) {
      setReviewWatcherCount(0);
      return;
    }

    let cancelled = false;
    const refreshWatchStatus = async () => {
      try {
        const status = await backend.getReviewWatchStatus?.(activeDocumentPath);
        if (!cancelled) {
          setReviewWatcherCount(status?.watcherCount ?? 0);
        }
      } catch {
        if (!cancelled) {
          setReviewWatcherCount(0);
        }
      }
    };

    void refreshWatchStatus();
    const interval = window.setInterval(refreshWatchStatus, 1500);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [activeDocumentPath, backend]);

  useEffect(() => {
    if (reviewHandoffState === "undelivered" && reviewWatcherCount > 0) {
      setReviewHandoffState("idle");
      return;
    }

    if (reviewHandoffState !== "notified") {
      sawNoWatcherAfterNotifiedRef.current = false;
      return;
    }

    if (reviewWatcherCount === 0) {
      sawNoWatcherAfterNotifiedRef.current = true;
      return;
    }

    if (sawNoWatcherAfterNotifiedRef.current) {
      sawNoWatcherAfterNotifiedRef.current = false;
      setReviewHandoffState("idle");
    }
  }, [reviewHandoffState, reviewWatcherCount]);

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

  const sendReviewHandoff = useCallback(
    async ({
      flushSaveFirst = false,
      onlyIfWatcher = false,
    }: {
      flushSaveFirst?: boolean;
      onlyIfWatcher?: boolean;
    } = {}) => {
      if (!activeDocumentPath || reviewHandoffState === "notifying") return;
      if (onlyIfWatcher && reviewWatcherCount <= 0) return;

      setReviewHandoffState("notifying");
      try {
        if (flushSaveFirst) {
          const saveResult = await saveControllerRef.current?.flushSave();
          if (saveResult && saveResult.status !== "saved") {
            setReviewHandoffState(
              saveResult.status === "blocked" ? "idle" : "error",
            );
            return;
          }
        }

        const result = await onCompleteReview();
        if (result.delivered) {
          setReviewWatcherCount(0);
          setReviewHandoffState("notified");
        } else {
          setReviewWatcherCount(0);
          setReviewHandoffState("undelivered");
        }
      } catch (error) {
        console.error("Failed to complete review:", error);
        setReviewHandoffState("error");
      }
    },
    [
      activeDocumentPath,
      onCompleteReview,
      reviewHandoffState,
      reviewWatcherCount,
    ],
  );

  const handleCompleteReview = useCallback(async () => {
    await sendReviewHandoff();
  }, [sendReviewHandoff]);

  const handleCommentSubmit = useCallback(async () => {
    await sendReviewHandoff({ flushSaveFirst: true, onlyIfWatcher: true });
  }, [sendReviewHandoff]);

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
    reviewWatcherCount === 0 &&
    hasReviewFeedback &&
    reviewHandoffState !== "notifying";

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

  const showReviewHandoffButton =
    !!activeDocumentPath &&
    (reviewWatcherCount > 0 || reviewHandoffState !== "idle");
  const showCopyReviewPromptButton =
    canCopyReviewPrompt && !showReviewHandoffButton;
  const copyReviewPromptLabel =
    reviewPromptCopyState === "copied"
      ? "Copied review prompt"
      : reviewPromptCopyState === "error"
        ? "Copy failed"
        : "Copy review prompt";
  const reviewHandoffButtonLabel =
    reviewHandoffState === "notifying"
      ? "Sending"
      : reviewHandoffState === "notified"
        ? "Sent"
        : reviewHandoffState === "error" || reviewHandoffState === "undelivered"
          ? "Not sent"
          : "Done Reviewing";
  const ReviewHandoffButtonIcon =
    reviewHandoffState === "notifying"
      ? Loader2
      : reviewHandoffState === "error" || reviewHandoffState === "undelivered"
        ? AlertTriangle
        : CheckCheck;
  const reviewHandoffStatusTitle =
    reviewHandoffState === "undelivered"
      ? "No agent is watching now"
      : reviewHandoffState === "error"
        ? "Could not notify agent"
        : "Your agent is now working";
  const reviewHandoffStatusBody =
    reviewHandoffState === "undelivered"
      ? "The handoff was not delivered because the watcher is no longer connected."
      : reviewHandoffState === "error"
        ? "Roughdraft could not send the handoff. Check that the local server is still running."
        : "It will take the appropriate next action, including addressing comments, questions, and suggestions, and/or directly editing the doc.";

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
        {showReviewHandoffButton ? (
          <Popover>
            <PopoverTrigger
              render={
                <Button
                  type="button"
                  data-testid="review-handoff-button"
                  size="lg"
                  aria-label={reviewHandoffButtonLabel}
                  title={reviewHandoffButtonLabel}
                  className="size-9 rounded-full bg-black p-0 text-white shadow-[0_10px_28px_rgba(0,0,0,0.18)] hover:bg-black/85 focus-visible:ring-black/25 dark:bg-black dark:text-white dark:hover:bg-black/85 dark:focus-visible:ring-white/30"
                  disabled={isReviewHandoffDisabled({
                    saveState,
                    documentDiskChangeState,
                    reviewHandoffState,
                  })}
                  onClick={() => void handleCompleteReview()}
                >
                  <ReviewHandoffButtonIcon
                    className={cn(
                      "size-4",
                      reviewHandoffState === "notifying" && "animate-spin",
                    )}
                  />
                </Button>
              }
            />
            <PopoverContent
              aria-label="Review handoff status"
              data-testid="review-handoff-status"
            >
              <div className="flex items-start gap-3">
                <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full bg-black text-white dark:bg-white dark:text-black">
                  {reviewHandoffState === "notifying" ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : reviewHandoffState === "error" ||
                    reviewHandoffState === "undelivered" ? (
                    <AlertTriangle className="size-4" />
                  ) : (
                    <CheckCheck className="size-4" />
                  )}
                </span>
                <div>
                  <div className="text-sm font-semibold text-stone-950 dark:text-slate-50">
                    {reviewHandoffStatusTitle}
                  </div>
                  <p className="mt-1 text-sm leading-6 text-stone-600 dark:text-slate-300">
                    {reviewHandoffStatusBody}
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
                    {reviewHandoffState !== "notified" &&
                    (reviewHandoffState !== "idle" ||
                      reviewWatcherCount > 0) ? (
                      <span
                        data-testid="review-handoff-inline-status"
                        role="status"
                        aria-label="Review handoff"
                        className="inline-flex shrink-0 items-center gap-1 font-mono text-[0.6rem] tracking-[0.01em] text-stone-400 dark:text-stone-500"
                      >
                        {reviewHandoffState === "notifying" ? (
                          <Loader2 className="size-[0.6rem] animate-spin" />
                        ) : reviewHandoffState === "error" ||
                          reviewHandoffState === "undelivered" ? (
                          <AlertTriangle className="size-[0.6rem]" />
                        ) : reviewWatcherCount > 0 ? (
                          <CheckCheck className="size-[0.6rem]" />
                        ) : (
                          <CheckCheck className="size-[0.6rem]" />
                        )}
                        {reviewHandoffState === "notifying"
                          ? "Notifying"
                          : reviewHandoffState === "error" ||
                              reviewHandoffState === "undelivered"
                            ? "Review not sent"
                            : "Agent watching"}
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
              onCommentSubmit={() => {
                void handleCommentSubmit();
              }}
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
