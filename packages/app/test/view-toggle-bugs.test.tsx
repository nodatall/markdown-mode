import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildLocationForDocumentEditorViewMode,
  type DocumentEditorViewMode,
  getDocumentEditorViewModeFromLocation,
} from "../src/app-navigation";
import {
  DocumentSaveStatusIndicator,
  DocumentWorkspace,
  isAgentCommentSubmitBlocked,
} from "../src/DocumentWorkspace";
import type { DocumentSaveState } from "../src/PageCard";
import type { AgentCommentSession, Page, StorageBackend } from "../src/storage";

function createBackend({
  watcherCount,
  projectPath,
  agentSession,
  submitAgentCommentTask,
}: {
  watcherCount?: number;
  projectPath?: string;
  agentSession?: AgentCommentSession;
  submitAgentCommentTask?: StorageBackend["submitAgentCommentTask"];
} = {}): StorageBackend {
  const backend: StorageBackend = {
    info: {
      kind: "local-storage",
      label: "Test backend",
      detail: "In-memory",
      projectPath,
    },
    canManageProjects: false,
    async getMarkdownFile(relativePath) {
      return { id: relativePath, title: relativePath, content: "" };
    },
    async saveMarkdownFile() {
      return undefined;
    },
    async saveAsset(file) {
      return {
        markdownPath: file.name,
        previewUrl: `file://${file.name}`,
        mimeType: file.type || "application/octet-stream",
      };
    },
    resolveFileUrl(path) {
      return `file://${path}`;
    },
    async openProject() {},
  };

  if (watcherCount !== undefined) {
    backend.getReviewWatchStatus = async () => ({
      watching: watcherCount > 0,
      watcherCount,
    });
  }
  if (agentSession) {
    backend.getAgentCommentSession = async () => agentSession;
  }
  if (submitAgentCommentTask) {
    backend.submitAgentCommentTask = submitAgentCommentTask;
  }

  return backend;
}

function createAgentSession(
  overrides: Partial<AgentCommentSession> = {},
): AgentCommentSession {
  return {
    documentPath: "/tmp/project/test.md",
    projectPath: "/tmp/project",
    relativePath: "test.md",
    mode: "detached",
    originThreadId: null,
    adapter: {
      available: false,
      name: "unavailable",
      reason: "No agent adapter is available.",
      supportsAttached: false,
      supportsDetached: false,
    },
    ...overrides,
  };
}

function createPage(content = "Hello world"): Page {
  return {
    id: "test-doc",
    title: "Test Doc",
    content,
  };
}

function setupDomMocks() {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    x: 0,
    y: 0,
    left: 0,
    top: 0,
    width: 640,
    height: 480,
    right: 640,
    bottom: 480,
    toJSON() {
      return this;
    },
  } as DOMRect);

  if (!("ResizeObserver" in globalThis)) {
    Object.defineProperty(globalThis, "ResizeObserver", {
      configurable: true,
      value: class ResizeObserver {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    });
  }

  Object.defineProperty(document, "fonts", {
    configurable: true,
    value: { ready: Promise.resolve() },
  });

  Object.defineProperty(Range.prototype, "getBoundingClientRect", {
    configurable: true,
    value() {
      return {
        x: 0,
        y: 0,
        left: 0,
        top: 0,
        width: 80,
        height: 20,
        right: 80,
        bottom: 20,
        toJSON() {
          return this;
        },
      } as DOMRect;
    },
  });

  Object.defineProperty(Range.prototype, "getClientRects", {
    configurable: true,
    value() {
      return [
        {
          x: 0,
          y: 0,
          left: 0,
          top: 0,
          width: 80,
          height: 20,
          right: 80,
          bottom: 20,
          toJSON() {
            return this;
          },
        } as DOMRect,
      ];
    },
  });

  Object.defineProperty(HTMLElement.prototype, "getClientRects", {
    configurable: true,
    value() {
      return [this.getBoundingClientRect()];
    },
  });

  Object.defineProperty(Text.prototype, "getClientRects", {
    configurable: true,
    value() {
      return [
        {
          x: 0,
          y: 0,
          left: 0,
          top: 0,
          width: 80,
          height: 20,
          right: 80,
          bottom: 20,
          toJSON() {
            return this;
          },
        } as DOMRect,
      ];
    },
  });

  window.scrollBy = vi.fn();
}

async function click(element: Element) {
  await act(async () => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await Promise.resolve();
  });
}

function queryByTestId<T extends Element = HTMLElement>(
  container: ParentNode,
  testId: string,
) {
  return container.querySelector<T>(`[data-testid="${testId}"]`);
}

function getByTestId<T extends Element = HTMLElement>(
  container: ParentNode,
  testId: string,
) {
  const element = queryByTestId<T>(container, testId);
  expect(element).not.toBeNull();
  return element as T;
}

describe("view mode toggle uses client-side state (issue 1 fix)", () => {
  afterEach(() => {
    window.history.replaceState(null, "", "/");
  });

  it("buildLocationForDocumentEditorViewMode produces a URL for history.replaceState", () => {
    window.history.replaceState(
      null,
      "",
      "/?path=/test/doc.md&editor=rich-text",
    );

    const nextLocation = buildLocationForDocumentEditorViewMode("code");

    expect(nextLocation).toContain("editor=code");
    expect(typeof nextLocation).toBe("string");
  });

  it("view mode can be read from the URL query param", () => {
    window.history.replaceState(null, "", "/?editor=rich-text");
    expect(getDocumentEditorViewModeFromLocation("rich-text")).toBe(
      "rich-text",
    );

    window.history.replaceState(null, "", "/?editor=code");
    expect(getDocumentEditorViewModeFromLocation("rich-text")).toBe("code");
  });

  it("buildLocationForDocumentEditorViewMode returns the expected path+search", () => {
    window.history.replaceState(null, "", "/doc.md?editor=rich-text");

    const result = buildLocationForDocumentEditorViewMode("code");

    expect(result).toBe("/doc.md?editor=code");
  });
});

describe("saving/saved status indicator (issue 2 fix)", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    setupDomMocks();
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    vi.restoreAllMocks();
  });

  async function renderSaveStatus({
    saveState = "saved",
    documentDiskChangeState = "clean",
  }: {
    saveState?: DocumentSaveState;
    documentDiskChangeState?: "clean" | "changed" | "conflict" | "paused";
  } = {}) {
    await act(async () => {
      root.render(
        <DocumentSaveStatusIndicator
          saveState={saveState}
          diskChangeState={documentDiskChangeState}
        />,
      );
      await Promise.resolve();
    });
  }

  async function renderWorkspace({
    documentDiskChangeState = "clean",
    watcherCount = 0,
    onSaveDocument = async () => {},
  }: {
    documentDiskChangeState?: "clean" | "changed" | "conflict" | "paused";
    watcherCount?: number;
    onSaveDocument?: (id: string, content: string) => Promise<void>;
  } = {}) {
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;

    await act(async () => {
      root.render(
        <DocumentWorkspace
          documentPage={createPage()}
          activeDocumentPath="test.md"
          documentFilenameLabel="test.md"
          documentEditorViewMode="rich-text"
          onSaveDocument={onSaveDocument}
          onDocumentSaveStateChange={() => {}}
          onDocumentDirtyStateChange={() => {}}
          onDocumentLocalContentChange={() => {}}
          documentDiskChangeState={documentDiskChangeState}
          documentForceResetKey={null}
          backend={createBackend({ watcherCount })}
        />,
      );
      await Promise.resolve();
    });
  }

  it.each([
    ["saved", "Saved"],
    ["saving", "Saving"],
    ["unsaved", "Unsaved changes"],
    ["error", "Save failed"],
  ] satisfies Array<
    [DocumentSaveState, string]
  >)("shows persistent %s save status", async (saveState, label) => {
    await renderSaveStatus({ saveState });

    expect(
      getByTestId(container, "document-save-status").textContent,
    ).toContain(label);
    expect(container.textContent).toContain(label);
  });

  it.each([
    ["changed", "File changed on disk"],
    ["conflict", "Save conflict"],
    ["paused", "Autosave paused"],
  ] as const)("shows disk-blocked %s save status", async (state, label) => {
    await renderSaveStatus({ documentDiskChangeState: state });

    expect(
      getByTestId(container, "document-save-status").textContent,
    ).toContain(label);
    expect(container.textContent).toContain(label);
  });

  it("renders save status below the agent status when a comment task is active", async () => {
    await renderWorkspace({
      watcherCount: 1,
    });

    const stack = queryByTestId(container, "document-status-stack");
    expect(stack).not.toBeNull();
    expect(queryByTestId(container, "review-handoff-button")).toBeNull();
    expect(stack?.textContent).toContain("Saved");
  });

  it("renders standalone save status in the top-right stack without handoff", async () => {
    await renderWorkspace();

    const stack = queryByTestId(container, "document-status-stack");
    expect(stack).not.toBeNull();
    expect(queryByTestId(container, "review-handoff-button")).toBeNull();
    expect(stack?.textContent).toContain("Saved");
  });

  it.each([
    ["Meta+S", { key: "s", metaKey: true }],
    ["Control+S", { key: "s", ctrlKey: true }],
  ])("prevents browser save on %s", async (_label, init) => {
    const onSaveDocument = vi.fn().mockResolvedValue(undefined);
    await renderWorkspace({ onSaveDocument });

    const event = new KeyboardEvent("keydown", {
      ...init,
      bubbles: true,
      cancelable: true,
    });
    const preventDefault = vi.spyOn(event, "preventDefault");

    await act(async () => {
      window.dispatchEvent(event);
      await Promise.resolve();
    });

    expect(preventDefault).toHaveBeenCalled();
  });

  it("prevents browser save even when disk conflict blocks persistence", async () => {
    const onSaveDocument = vi.fn().mockResolvedValue(undefined);
    await renderWorkspace({
      documentDiskChangeState: "conflict",
      onSaveDocument,
    });

    const event = new KeyboardEvent("keydown", {
      key: "s",
      metaKey: true,
      bubbles: true,
      cancelable: true,
    });
    const preventDefault = vi.spyOn(event, "preventDefault");

    await act(async () => {
      window.dispatchEvent(event);
      await Promise.resolve();
    });

    expect(preventDefault).toHaveBeenCalled();
    expect(onSaveDocument).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Save conflict");
  });

  it("shows disk conflict in save status without rendering a conflict banner", async () => {
    await renderWorkspace({ documentDiskChangeState: "conflict" });

    expect(container.textContent).toContain("Save conflict");
    expect(queryByTestId(container, "file-conflict-notice")).toBeNull();
    expect(
      getByTestId(container, "document-save-status").textContent,
    ).toContain("Save conflict");
  });

  it.each([
    ["saving", "clean"],
    ["unsaved", "clean"],
    ["error", "clean"],
    ["saved", "conflict"],
  ] satisfies Array<
    [DocumentSaveState, "clean" | "changed" | "conflict" | "paused"]
  >)("blocks agent comment submit for save state %s and disk state %s", (saveState, documentDiskChangeState) => {
    expect(
      isAgentCommentSubmitBlocked({
        saveState,
        documentDiskChangeState,
      }),
    ).toBe(true);
  });

  it("allows agent comment submit when saved and conflict-free", () => {
    expect(
      isAgentCommentSubmitBlocked({
        saveState: "saved",
        documentDiskChangeState: "clean",
      }),
    ).toBe(false);
  });
});

describe("interaction mode preserved across view toggle (issue 3 fix)", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    setupDomMocks();
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    vi.restoreAllMocks();
  });

  it("interaction mode is preserved when view mode changes without remount", async () => {
    // With the fix, view mode changes use React state (no page reload),
    // so the DocumentWorkspace component stays mounted and interaction
    // mode is preserved.

    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;

    const renderWorkspace = async (viewMode: DocumentEditorViewMode) => {
      await act(async () => {
        root.render(
          <DocumentWorkspace
            documentPage={createPage()}
            activeDocumentPath="test.md"
            documentFilenameLabel="test.md"
            documentEditorViewMode={viewMode}
            onSaveDocument={async () => {}}
            onDocumentSaveStateChange={() => {}}
            onDocumentDirtyStateChange={() => {}}
            onDocumentLocalContentChange={() => {}}
            documentDiskChangeState="clean"
            documentForceResetKey={null}
            backend={createBackend()}
          />,
        );
      });
    };

    // Mount with rich-text.
    await renderWorkspace("rich-text");
    expect(queryByTestId(container, "document-mode-trigger")).toBeNull();
    expect(queryByTestId(container, "rich-text-editor")).not.toBeNull();

    // Rerender with code view (same component instance, no remount).
    await renderWorkspace("code");
    expect(queryByTestId(container, "markdown-code-editor")).not.toBeNull();
  });
});

describe("agent comment workflow affordance", () => {
  let container: HTMLDivElement;
  let root: Root;
  let writeText: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    setupDomMocks();
    writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    vi.restoreAllMocks();
  });

  async function renderWorkspace({
    content = "Hello world",
    activeDocumentPath = "test.md",
    projectPath,
    agentSession,
    submitAgentCommentTask,
    onSaveDocument = async () => {},
  }: {
    content?: string;
    activeDocumentPath?: string;
    projectPath?: string;
    agentSession?: AgentCommentSession;
    submitAgentCommentTask?: StorageBackend["submitAgentCommentTask"];
    onSaveDocument?: (id: string, content: string) => Promise<void>;
  }) {
    await act(async () => {
      root.render(
        <DocumentWorkspace
          documentPage={createPage(content)}
          activeDocumentPath={activeDocumentPath}
          documentFilenameLabel="test.md"
          documentEditorViewMode="rich-text"
          onSaveDocument={onSaveDocument}
          onDocumentSaveStateChange={() => {}}
          onDocumentDirtyStateChange={() => {}}
          onDocumentLocalContentChange={() => {}}
          documentDiskChangeState="clean"
          documentForceResetKey={null}
          backend={createBackend({
            projectPath,
            agentSession,
            submitAgentCommentTask,
          })}
        />,
      );
      await Promise.resolve();
    });
  }

  it("does not render a Done Reviewing primary action", async () => {
    await renderWorkspace({});

    expect(queryByTestId(container, "review-handoff-button")).toBeNull();
    expect(container.textContent).not.toContain("Review ready");
    expect(container.textContent).not.toContain("Copy prompt");
  });

  it("copies a paste-ready review prompt when comments exist and no agent adapter is available", async () => {
    await renderWorkspace({
      projectPath: "/tmp/project",
      agentSession: createAgentSession(),
      content:
        'Please review {==this claim==}{>>Needs evidence.<<}{id="c1" by="Nora" at="2026-05-24T12:00:00.000Z"} and {~~old wording~>new wording~~}{id="s1" by="AI" at="2026-05-24T12:01:00.000Z"}.',
    });

    const copyButton = getByTestId<HTMLButtonElement>(
      container,
      "review-copy-prompt-button",
    );
    expect(copyButton.getAttribute("aria-label")).toBe("Copy review prompt");

    await click(copyButton);

    expect(writeText).toHaveBeenCalledOnce();
    const prompt = writeText.mock.calls[0]?.[0] as string;
    expect(prompt).toContain("File: /tmp/project/test.md");
    expect(prompt).toContain("Comment c1 by Nora");
    expect(prompt).toContain('Reference: "this claim"');
    expect(prompt).toContain('Comment: "Needs evidence."');
    expect(prompt).toContain("Suggestion s1");
    expect(prompt).toContain('Replace "old wording" with "new wording".');
  });

  it("shows attached session status without writing thread metadata into the document", async () => {
    const onSaveDocument = vi.fn().mockResolvedValue(undefined);

    await renderWorkspace({
      content:
        'Please review {==this claim==}{>>Needs evidence.<<}{id="c1" by="Nora" at="2026-05-24T12:00:00.000Z"}.',
      agentSession: createAgentSession({
        mode: "attached",
        originThreadId: "thread-1",
        adapter: {
          available: true,
          name: "fake",
          reason: null,
          supportsAttached: true,
          supportsDetached: true,
        },
      }),
      onSaveDocument,
    });

    await act(async () => {
      await Promise.resolve();
    });

    expect(
      getByTestId(container, "agent-comment-inline-status").textContent,
    ).toContain("Connected to thread");
    expect(container.textContent).not.toContain("thread-1");
    expect(onSaveDocument).not.toHaveBeenCalled();
  });

  it("submits the edited comment as one agent task and shows working state", async () => {
    const submitAgentCommentTask = vi.fn().mockResolvedValue({
      task: {
        id: "act_1",
        documentPath: "/tmp/project/test.md",
        projectPath: "/tmp/project",
        relativePath: "test.md",
        fileVersion: "v1",
        mode: "detached",
        originThreadId: null,
        status: "working",
        adapterName: "fake",
        prompt: "prompt",
        createdAt: "2026-05-24T12:00:00.000Z",
        updatedAt: "2026-05-24T12:00:00.000Z",
        error: null,
        queuePosition: 0,
        comment: {
          id: "c1",
          text: "Needs evidence and numbers.",
          anchorText: "this claim",
          line: 1,
          column: 15,
          offset: 14,
          endOffset: 24,
          author: "Nora",
          createdAt: "2026-05-24T12:00:00.000Z",
        },
      },
    });
    const onSaveDocument = vi.fn().mockResolvedValue(undefined);

    await renderWorkspace({
      projectPath: "/tmp/project",
      content:
        'Please review {==this claim==}{>>Needs evidence.<<}{id="c1" by="Nora" at="2026-05-24T12:00:00.000Z"}.',
      agentSession: createAgentSession({
        adapter: {
          available: true,
          name: "fake",
          reason: null,
          supportsAttached: true,
          supportsDetached: true,
        },
      }),
      submitAgentCommentTask,
      onSaveDocument,
    });

    await click(getByTestId(container, "document-comment-marker-c1"));
    const editor = getByTestId<HTMLTextAreaElement>(
      container,
      "comment-rail-c1-editor",
    );
    await act(async () => {
      const valueSetter = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        "value",
      )?.set;
      valueSetter?.call(editor, "Needs evidence and numbers.");
      editor.dispatchEvent(new InputEvent("input", { bubbles: true }));
      await Promise.resolve();
    });
    await click(getByTestId(container, "comment-rail-c1-action-save"));

    expect(onSaveDocument).toHaveBeenCalled();
    expect(submitAgentCommentTask).toHaveBeenCalledWith("test.md", {
      commentId: "c1",
    });
    expect(getByTestId(container, "agent-comment-task-button")).not.toBeNull();
    expect(
      getByTestId(container, "agent-comment-inline-status").textContent,
    ).toContain("Agent working");
    const workingMarker = getByTestId(
      container,
      "document-comment-marker-c1-working",
    );
    expect(workingMarker).not.toBeNull();
    expect(
      getByTestId(container, "document-comment-marker-c1").textContent,
    ).toBe("");
    expect(getByTestId(container, "comment-decoration-working")).not.toBeNull();
  });
});
