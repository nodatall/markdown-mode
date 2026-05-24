import type { Editor } from "@tiptap/react";
import { useEditorState } from "@tiptap/react";
import { ExternalLink, Trash2 } from "lucide-react";
import type { ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  getAddCommentShortcutLabel,
  matchesAddCommentShortcut,
} from "./comment-shortcuts";
import { toHtml } from "./markdown";
import type { StorageBackend } from "./storage";

interface EditorContextMenuProps {
  editor: Editor | null;
  backend: StorageBackend;
  resolveLinkUrl?: (path: string) => string | null;
  onAddComment?: () => void;
  onSuggestDeletion?: () => void;
  onSuggestReplacement?: () => void;
  onSuggestInsertion?: () => void;
  children: ReactNode;
}

interface MenuPosition {
  x: number;
  y: number;
}

interface LinkPopoverState {
  href: string;
  rawHref: string;
  left: number;
  top: number;
  existingLink: boolean;
  focusInput: boolean;
}

function getNavigatorPlatform() {
  const navigatorWithUserAgentData = navigator as Navigator & {
    userAgentData?: {
      platform?: string;
    };
  };

  return (
    navigatorWithUserAgentData.userAgentData?.platform ?? navigator.platform
  );
}

function isResolvedLinkTarget(value: string) {
  return /^(?:[a-z]+:)?\/\//i.test(value) || value.startsWith("data:");
}

function isLinkTarget(value: string) {
  return isResolvedLinkTarget(value) || value.startsWith("#");
}

function resolveEditableLinkTarget(
  value: string,
  backend: StorageBackend,
  resolveLinkUrl?: (path: string) => string | null,
  fallback = value,
) {
  if (!value) return fallback;
  if (isLinkTarget(value)) return value;
  const linkUrl = resolveLinkUrl?.(value);
  if (linkUrl) return linkUrl;
  return backend.resolveFileUrl(value) ?? fallback;
}

function getElementFromDomNode(node: Node | null) {
  if (!node) return null;
  return node instanceof Element ? node : node.parentElement;
}

function findActiveLinkAnchor(
  editor: Editor,
  container: HTMLElement,
): HTMLAnchorElement | null {
  const candidates: Array<Element | null> = [];
  const selection = window.getSelection();

  if (selection && selection.rangeCount > 0) {
    const range = selection.getRangeAt(0);
    candidates.push(
      getElementFromDomNode(range.startContainer),
      getElementFromDomNode(range.endContainer),
      getElementFromDomNode(range.commonAncestorContainer),
    );
  }

  const { from, to } = editor.state.selection;
  const startDom = editor.view.domAtPos(from);
  const endDom = editor.view.domAtPos(to);
  candidates.push(
    getElementFromDomNode(startDom.node),
    getElementFromDomNode(endDom.node),
  );

  for (const candidate of candidates) {
    const anchor = candidate?.closest("a[href]");

    if (anchor instanceof HTMLAnchorElement && container.contains(anchor)) {
      return anchor;
    }
  }

  return null;
}

function selectionContainsCommentRef(editor: Editor) {
  const { from, to, empty, $from } = editor.state.selection;
  const commentRefMark = editor.state.schema.marks.commentRef;

  if (!commentRefMark) return false;

  if (empty) {
    return $from.marks().some((mark) => mark.type === commentRefMark);
  }

  let hasCommentRef = false;
  editor.state.doc.nodesBetween(from, to, (node) => {
    if (hasCommentRef) return false;
    if (!node.isText) return;

    hasCommentRef = node.marks.some((mark) => mark.type === commentRefMark);
  });

  return hasCommentRef;
}

export function EditorContextMenu({
  editor,
  backend,
  resolveLinkUrl,
  onAddComment,
  onSuggestDeletion,
  onSuggestReplacement,
  onSuggestInsertion,
  children,
}: EditorContextMenuProps) {
  const [position, setPosition] = useState<MenuPosition | null>(null);
  const [linkPopoverState, setLinkPopoverState] =
    useState<LinkPopoverState | null>(null);
  const [linkDraft, setLinkDraft] = useState("");
  const menuRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const linkPopoverRef = useRef<HTMLDivElement>(null);
  const linkInputRef = useRef<HTMLInputElement>(null);
  const autoCommentSelectionRef = useRef<string | null>(null);
  const pointerSelectingRef = useRef(false);
  const shortcutLabel = getAddCommentShortcutLabel(getNavigatorPlatform());
  const selectionMenuState = useEditorState({
    editor,
    selector: ({ editor: currentEditor }) => ({
      activeCriticChangeId:
        (currentEditor?.getAttributes("criticChange").changeId as
          | string
          | null) ?? null,
    }),
  }) ?? {
    activeCriticChangeId: null,
  };

  const close = useCallback(() => {
    setPosition(null);
  }, []);

  const closeLinkPopover = useCallback(() => {
    setLinkPopoverState(null);
  }, []);

  const maybeAddCommentForSelection = useCallback(() => {
    if (!editor || !onAddComment || !editor.isFocused) {
      autoCommentSelectionRef.current = null;
      return;
    }

    if (pointerSelectingRef.current) {
      return;
    }

    const { selection } = editor.state;

    if (selection.empty) {
      autoCommentSelectionRef.current = null;
      return;
    }

    if (selectionContainsCommentRef(editor)) {
      return;
    }

    const selectionKey = `${selection.from}:${selection.to}:${editor.state.doc.content.size}`;
    if (autoCommentSelectionRef.current === selectionKey) {
      return;
    }

    autoCommentSelectionRef.current = selectionKey;
    onAddComment();
  }, [editor, onAddComment]);

  const updateLinkPopover = useCallback(() => {
    setLinkPopoverState((current) => {
      if (!current?.existingLink) return current;
      if (!editor || !containerRef.current || !editor.isActive("link")) {
        return null;
      }

      const anchor = findActiveLinkAnchor(editor, containerRef.current);

      if (!anchor) {
        return null;
      }

      const rect = anchor.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) {
        return null;
      }

      const rawHref =
        (editor.getAttributes("link").dataMarkdownSrc as string | null) ||
        anchor.getAttribute("data-markdown-src") ||
        anchor.getAttribute("href") ||
        "";
      const href = resolveEditableLinkTarget(
        rawHref,
        backend,
        resolveLinkUrl,
        (editor.getAttributes("link").href as string | null) || anchor.href,
      );
      const next = {
        ...current,
        href,
        rawHref,
        left: rect.left + rect.width / 2,
        top: rect.top - 12,
      };

      return next.href === current.href &&
        next.rawHref === current.rawHref &&
        next.left === current.left &&
        next.top === current.top
        ? current
        : next;
    });
  }, [backend, editor, resolveLinkUrl]);

  const openExistingLinkPopover = useCallback(
    (anchor: HTMLAnchorElement) => {
      if (!editor) return;

      const firstChild = anchor.firstChild;
      if (firstChild) {
        try {
          const position = editor.view.posAtDOM(firstChild, 0);
          editor.commands.setTextSelection(
            anchor.textContent ? position + 1 : position,
          );
        } catch {
          // Fall back to the current editor selection if the DOM mapping changed.
        }
      }

      const rect = anchor.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) return;

      const linkAttrs = editor.isActive("link")
        ? editor.getAttributes("link")
        : {};
      const rawHref =
        (linkAttrs.dataMarkdownSrc as string | null) ||
        anchor.getAttribute("data-markdown-src") ||
        anchor.getAttribute("href") ||
        "";
      const href = resolveEditableLinkTarget(
        rawHref,
        backend,
        resolveLinkUrl,
        (linkAttrs.href as string | null) || anchor.href,
      );

      setLinkPopoverState({
        href,
        rawHref,
        left: rect.left + rect.width / 2,
        top: rect.top - 12,
        existingLink: true,
        focusInput: false,
      });
    },
    [backend, editor, resolveLinkUrl],
  );

  const applyLink = useCallback(
    (nextValue: string) => {
      if (!editor) return;

      const nextHref = nextValue.trim();

      if (!nextHref) {
        editor.chain().focus().unsetLink().run();
        setLinkPopoverState(null);
        return;
      }

      editor
        .chain()
        .focus()
        .extendMarkRange("link")
        .setMark("link", {
          href: resolveEditableLinkTarget(
            nextHref,
            backend,
            resolveLinkUrl,
            nextHref,
          ),
          dataMarkdownSrc: nextHref,
        })
        .run();
    },
    [backend, editor, resolveLinkUrl],
  );

  useEffect(() => {
    if (!position && !linkPopoverState) return;

    const handleMouseDown = (event: MouseEvent) => {
      const target = event.target as Node;

      if (menuRef.current && !menuRef.current.contains(target)) {
        close();
      }

      if (
        linkPopoverRef.current &&
        !linkPopoverRef.current.contains(target) &&
        containerRef.current &&
        !containerRef.current.contains(target)
      ) {
        applyLink(linkDraft);
        closeLinkPopover();
      }
    };

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
      if (event.key === "Escape") closeLinkPopover();
    };

    document.addEventListener("mousedown", handleMouseDown, true);
    document.addEventListener("keydown", handleEscape);

    return () => {
      document.removeEventListener("mousedown", handleMouseDown, true);
      document.removeEventListener("keydown", handleEscape);
    };
  }, [
    applyLink,
    close,
    closeLinkPopover,
    linkDraft,
    linkPopoverState,
    position,
  ]);

  useEffect(() => {
    if (!editor) return;

    const schedulePositionUpdate = () => {
      requestAnimationFrame(() => {
        updateLinkPopover();
        maybeAddCommentForSelection();
      });
    };

    const clearSelectionAction = () => {
      autoCommentSelectionRef.current = null;
      pointerSelectingRef.current = false;
    };

    const handlePointerDown = (event: PointerEvent) => {
      if (!editor.view.dom.contains(event.target as Node | null)) return;
      if (event.pointerType === "mouse" && event.button !== 0) return;

      pointerSelectingRef.current = true;
      autoCommentSelectionRef.current = null;
    };

    const handlePointerDone = () => {
      if (!pointerSelectingRef.current) return;

      pointerSelectingRef.current = false;
      requestAnimationFrame(() => {
        updateLinkPopover();
        maybeAddCommentForSelection();
      });
    };

    const handleDoubleClick = () => {
      pointerSelectingRef.current = false;
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          updateLinkPopover();
          maybeAddCommentForSelection();
        });
      });
    };

    const handleSelectionChange = () => {
      schedulePositionUpdate();
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (
        !onAddComment ||
        !editor.isFocused ||
        editor.state.selection.empty ||
        !matchesAddCommentShortcut(event, getNavigatorPlatform())
      ) {
        return;
      }

      event.preventDefault();
      event.stopImmediatePropagation();
      onAddComment();
      clearSelectionAction();
    };

    editor.on("selectionUpdate", schedulePositionUpdate);
    editor.on("update", schedulePositionUpdate);
    editor.on("focus", schedulePositionUpdate);
    editor.on("blur", clearSelectionAction);
    document.addEventListener("pointerdown", handlePointerDown, true);
    document.addEventListener("pointerup", handlePointerDone, true);
    document.addEventListener("pointercancel", handlePointerDone, true);
    editor.view.dom.addEventListener("dblclick", handleDoubleClick);
    document.addEventListener("selectionchange", handleSelectionChange);
    document.addEventListener("keydown", handleKeyDown, true);
    window.addEventListener("resize", schedulePositionUpdate);
    window.addEventListener("scroll", schedulePositionUpdate, true);

    schedulePositionUpdate();

    return () => {
      editor.off("selectionUpdate", schedulePositionUpdate);
      editor.off("update", schedulePositionUpdate);
      editor.off("focus", schedulePositionUpdate);
      editor.off("blur", clearSelectionAction);
      document.removeEventListener("pointerdown", handlePointerDown, true);
      document.removeEventListener("pointerup", handlePointerDone, true);
      document.removeEventListener("pointercancel", handlePointerDone, true);
      editor.view.dom.removeEventListener("dblclick", handleDoubleClick);
      document.removeEventListener("selectionchange", handleSelectionChange);
      document.removeEventListener("keydown", handleKeyDown, true);
      window.removeEventListener("resize", schedulePositionUpdate);
      window.removeEventListener("scroll", schedulePositionUpdate, true);
    };
  }, [editor, maybeAddCommentForSelection, onAddComment, updateLinkPopover]);

  useEffect(() => {
    if (!linkPopoverState) return;
    setLinkDraft(linkPopoverState.rawHref);
  }, [linkPopoverState]);

  useEffect(() => {
    if (!linkPopoverState?.focusInput || !linkInputRef.current) {
      return;
    }

    requestAnimationFrame(() => {
      linkInputRef.current?.focus();
      linkInputRef.current?.select();
    });
  }, [linkPopoverState]);

  const handlePasteText = useCallback(async () => {
    if (!editor) return;

    try {
      const text = await navigator.clipboard.readText();
      if (text) {
        editor.chain().focus().insertContent(text).run();
      }
    } finally {
      close();
    }
  }, [close, editor]);

  const handlePasteMarkdown = useCallback(async () => {
    if (!editor) return;

    try {
      const text = await navigator.clipboard.readText();
      if (text) {
        editor
          .chain()
          .focus()
          .insertContent(
            toHtml(text, {
              resolveFileUrl: (path) => backend.resolveFileUrl(path),
              resolveLinkUrl,
            }),
          )
          .run();
      }
    } finally {
      close();
    }
  }, [backend, close, editor, resolveLinkUrl]);

  return (
    <div
      ref={containerRef}
      className="relative"
      onMouseDownCapture={(event) => {
        if (!editor || !containerRef.current) return;

        const target = event.target as Node;
        const candidate = getElementFromDomNode(target);
        const anchor = candidate?.closest("a[href]");

        if (
          !(anchor instanceof HTMLAnchorElement) ||
          !containerRef.current.contains(anchor)
        ) {
          return;
        }

        event.preventDefault();
        openExistingLinkPopover(anchor);
      }}
      onContextMenu={(event) => {
        event.preventDefault();
        event.stopPropagation();
        setPosition({ x: event.clientX, y: event.clientY });
      }}
    >
      {children}
      {linkPopoverState ? (
        <div
          ref={linkPopoverRef}
          data-testid="link-popover"
          className="fixed z-[220] flex -translate-x-1/2 -translate-y-full items-center rounded-[18px] border border-slate-200/90 dark:border-slate-700/90 bg-white/95 dark:bg-slate-800/95 px-3 py-2 shadow-[0_18px_48px_rgba(15,23,42,0.16)] dark:shadow-[0_18px_48px_rgba(0,0,0,0.4)] backdrop-blur-xl"
          style={{
            left: linkPopoverState.left,
            top: linkPopoverState.top,
          }}
          onMouseDown={(event) => {
            event.stopPropagation();
          }}
        >
          <input
            ref={linkInputRef}
            value={linkDraft}
            onChange={(event) => setLinkDraft(event.target.value)}
            onBlur={(event) => {
              const nextFocused = event.relatedTarget as Node | null;

              if (
                nextFocused &&
                linkPopoverRef.current?.contains(nextFocused)
              ) {
                return;
              }

              applyLink(linkDraft);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                applyLink(linkDraft);
                editor?.commands.focus();
              }

              if (event.key === "Escape") {
                event.preventDefault();
                closeLinkPopover();
                editor?.commands.focus();
              }
            }}
            className="h-10 w-[22rem] border-0 bg-transparent px-2 text-[17px] text-slate-900 dark:text-slate-100 outline-none placeholder:text-slate-400 dark:placeholder:text-slate-500"
            placeholder="https://example.com"
            aria-label="Link URL"
            data-testid="link-url-input"
          />
          <div
            className="mx-2 h-8 w-px bg-slate-200 dark:bg-slate-700"
            aria-hidden="true"
          />
          <button
            type="button"
            className="inline-flex size-9 items-center justify-center rounded-lg text-slate-500 dark:text-slate-400 transition hover:bg-slate-100 dark:hover:bg-slate-700 hover:text-slate-900 dark:hover:text-slate-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-300 dark:focus-visible:ring-slate-600"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => {
              applyLink(linkDraft);
              const target =
                resolveEditableLinkTarget(
                  linkDraft.trim(),
                  backend,
                  resolveLinkUrl,
                ) || linkPopoverState.href;

              if (target) {
                window.open(target, "_blank", "noopener,noreferrer");
              }
            }}
            aria-label="Open link in new tab"
            data-testid="link-action-open"
            title="Open link in new tab"
          >
            <ExternalLink className="size-5" />
          </button>
          <button
            type="button"
            className="inline-flex size-9 items-center justify-center rounded-lg text-slate-500 dark:text-slate-400 transition hover:bg-rose-50 dark:hover:bg-rose-900/40 hover:text-rose-600 dark:hover:text-rose-400 focus:outline-none focus-visible:ring-2 focus-visible:ring-rose-300 dark:focus-visible:ring-rose-800"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => {
              editor?.chain().focus().unsetLink().run();
              closeLinkPopover();
            }}
            aria-label="Delete link"
            data-testid="link-action-delete"
            title="Delete link"
          >
            <Trash2 className="size-5" />
          </button>
        </div>
      ) : null}
      {position ? (
        <div
          ref={menuRef}
          data-testid="editor-context-menu"
          className="fixed z-[200] min-w-44 rounded-2xl border border-slate-200/90 dark:border-slate-700/90 bg-white/95 dark:bg-slate-800/95 p-1.5 shadow-[0_18px_48px_rgba(15,23,42,0.16)] dark:shadow-[0_18px_48px_rgba(0,0,0,0.4)] backdrop-blur-xl"
          style={{ left: position.x, top: position.y }}
        >
          <button
            type="button"
            data-testid="editor-context-menu-action-add-comment"
            className="flex w-full items-center justify-between gap-3 rounded-xl px-3 py-2 text-left text-sm text-slate-700 dark:text-slate-300 transition hover:bg-slate-50 dark:hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-50"
            disabled={!editor || editor.state.selection.empty}
            onClick={() => {
              onAddComment?.();
              close();
            }}
          >
            <span>Add comment</span>
            <span className="text-[11px] font-medium text-slate-400 dark:text-slate-500">
              {shortcutLabel}
            </span>
          </button>
          <button
            type="button"
            data-testid="editor-context-menu-action-suggest-insertion"
            className="block w-full rounded-xl px-3 py-2 text-left text-sm text-slate-700 dark:text-slate-300 transition hover:bg-slate-50 dark:hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-50"
            disabled={!editor || !onSuggestInsertion}
            onClick={() => {
              onSuggestInsertion?.();
              close();
            }}
          >
            Suggest insertion
          </button>
          <button
            type="button"
            data-testid="editor-context-menu-action-suggest-deletion"
            className="block w-full rounded-xl px-3 py-2 text-left text-sm text-slate-700 dark:text-slate-300 transition hover:bg-slate-50 dark:hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-50"
            disabled={!editor || editor.state.selection.empty}
            onClick={() => {
              onSuggestDeletion?.();
              close();
            }}
          >
            Suggest deletion
          </button>
          <button
            type="button"
            data-testid="editor-context-menu-action-suggest-replacement"
            className="block w-full rounded-xl px-3 py-2 text-left text-sm text-slate-700 dark:text-slate-300 transition hover:bg-slate-50 dark:hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-50"
            disabled={!editor || editor.state.selection.empty}
            onClick={() => {
              onSuggestReplacement?.();
              close();
            }}
          >
            Suggest replacement
          </button>
          {selectionMenuState.activeCriticChangeId ? (
            <>
              <div
                className="my-1 h-px bg-slate-100 dark:bg-slate-700"
                aria-hidden="true"
              />
              <button
                type="button"
                data-testid="editor-context-menu-action-accept-suggestion"
                className="block w-full rounded-xl px-3 py-2 text-left text-sm text-emerald-700 transition hover:bg-emerald-50"
                onClick={() => {
                  if (selectionMenuState.activeCriticChangeId) {
                    editor
                      ?.chain()
                      .focus()
                      .acceptCriticChange(
                        selectionMenuState.activeCriticChangeId,
                      )
                      .run();
                  }
                  close();
                }}
              >
                Accept suggestion
              </button>
              <button
                type="button"
                data-testid="editor-context-menu-action-reject-suggestion"
                className="block w-full rounded-xl px-3 py-2 text-left text-sm text-rose-700 transition hover:bg-rose-50"
                onClick={() => {
                  if (selectionMenuState.activeCriticChangeId) {
                    editor
                      ?.chain()
                      .focus()
                      .rejectCriticChange(
                        selectionMenuState.activeCriticChangeId,
                      )
                      .run();
                  }
                  close();
                }}
              >
                Reject suggestion
              </button>
            </>
          ) : null}
          <button
            type="button"
            data-testid="editor-context-menu-action-paste"
            className="block w-full rounded-xl px-3 py-2 text-left text-sm text-slate-700 dark:text-slate-300 transition hover:bg-slate-50 dark:hover:bg-slate-700"
            onClick={() => void handlePasteText()}
          >
            Paste
          </button>
          <button
            type="button"
            data-testid="editor-context-menu-action-paste-markdown"
            className="block w-full rounded-xl px-3 py-2 text-left text-sm text-slate-700 dark:text-slate-300 transition hover:bg-slate-50 dark:hover:bg-slate-700"
            onClick={() => void handlePasteMarkdown()}
          >
            Paste Markdown
          </button>
        </div>
      ) : null}
    </div>
  );
}
