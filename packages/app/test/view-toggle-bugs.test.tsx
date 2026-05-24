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
  isReviewHandoffDisabled,
} from "../src/DocumentWorkspace";
import type { DocumentSaveState } from "../src/PageCard";
import type {
  CompleteReviewResult,
  Page,
  StorageBackend,
} from "../src/storage";

function createBackend({
  watcherCount,
  projectPath,
}: {
  watcherCount?: number;
  projectPath?: string;
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

  return backend;
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
          onCompleteReview={async () => ({ delivered: false })}
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

  it("renders save status below the handoff button when handoff exists", async () => {
    await renderWorkspace({ watcherCount: 1 });

    const stack = queryByTestId(container, "document-status-stack");
    const doneReviewingButton = queryByTestId(
      container,
      "review-handoff-button",
    );
    expect(stack).not.toBeNull();
    expect(doneReviewingButton).toBeDefined();
    expect(doneReviewingButton?.getAttribute("aria-label")).toBe(
      "Done Reviewing",
    );
    expect(doneReviewingButton?.textContent).not.toContain("Saved");
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
  >)("keeps handoff disabled for save state %s and disk state %s", (saveState, documentDiskChangeState) => {
    expect(
      isReviewHandoffDisabled({
        saveState,
        documentDiskChangeState,
        reviewHandoffState: "idle",
      }),
    ).toBe(true);
  });

  it("allows handoff only when saved, conflict-free, and idle", () => {
    expect(
      isReviewHandoffDisabled({
        saveState: "saved",
        documentDiskChangeState: "clean",
        reviewHandoffState: "idle",
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
            onCompleteReview={async () => ({ delivered: false })}
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

describe("review handoff watcher affordance", () => {
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
    getWatcherCount,
    onCompleteReview = async () => ({ delivered: false }),
    content = "Hello world",
    activeDocumentPath = "test.md",
    projectPath,
  }: {
    getWatcherCount: () => number;
    onCompleteReview?: () => Promise<CompleteReviewResult>;
    content?: string;
    activeDocumentPath?: string;
    projectPath?: string;
  }) {
    await act(async () => {
      root.render(
        <DocumentWorkspace
          documentPage={createPage(content)}
          activeDocumentPath={activeDocumentPath}
          documentFilenameLabel="test.md"
          documentEditorViewMode="rich-text"
          onSaveDocument={async () => {}}
          onDocumentSaveStateChange={() => {}}
          onDocumentDirtyStateChange={() => {}}
          onDocumentLocalContentChange={() => {}}
          documentDiskChangeState="clean"
          documentForceResetKey={null}
          onCompleteReview={onCompleteReview}
          backend={createBackend({
            watcherCount: getWatcherCount(),
            projectPath,
          })}
        />,
      );
      await Promise.resolve();
    });
  }

  it("hides the done reviewing button when no agent is watching", async () => {
    const onCompleteReview = vi
      .fn<() => Promise<CompleteReviewResult>>()
      .mockResolvedValue({ delivered: false });

    await renderWorkspace({ getWatcherCount: () => 0, onCompleteReview });

    expect(queryByTestId(container, "review-handoff-button")).toBeNull();
    expect(container.textContent).not.toContain("Review ready");
    expect(container.textContent).not.toContain("Copy prompt");
    expect(onCompleteReview).not.toHaveBeenCalled();
  });

  it("copies a paste-ready review prompt when comments exist and no agent is watching", async () => {
    await renderWorkspace({
      getWatcherCount: () => 0,
      projectPath: "/tmp/project",
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

  it("shows the done reviewing button only for an active watcher", async () => {
    const onCompleteReview = vi
      .fn<() => Promise<CompleteReviewResult>>()
      .mockResolvedValue({ delivered: true });

    await renderWorkspace({ getWatcherCount: () => 1, onCompleteReview });

    const doneReviewingButton = queryByTestId<HTMLButtonElement>(
      container,
      "review-handoff-button",
    );
    expect(doneReviewingButton).toBeDefined();
    expect(container.textContent).toContain("Agent watching");

    if (!doneReviewingButton) {
      throw new Error("Done Reviewing button not found");
    }
    await click(doneReviewingButton);

    expect(onCompleteReview).toHaveBeenCalledOnce();
    expect(
      getByTestId(container, "review-handoff-button").getAttribute(
        "aria-label",
      ),
    ).toBe("Sent");
    expect(container.textContent).not.toContain("Agent notified");
    expect(container.textContent).not.toContain("Review ready");
    expect(container.textContent).not.toContain("Copy prompt");
  });

  it("shows visible feedback when the watcher disappears before handoff delivery", async () => {
    const onCompleteReview = vi
      .fn<() => Promise<CompleteReviewResult>>()
      .mockResolvedValue({ delivered: false });

    await renderWorkspace({ getWatcherCount: () => 1, onCompleteReview });

    const doneReviewingButton = queryByTestId<HTMLButtonElement>(
      container,
      "review-handoff-button",
    );
    if (!doneReviewingButton) {
      throw new Error("Done Reviewing button not found");
    }
    await click(doneReviewingButton);

    expect(onCompleteReview).toHaveBeenCalledOnce();
    expect(container.textContent).toContain("Review not sent");
    expect(
      getByTestId(container, "review-handoff-button").getAttribute(
        "aria-label",
      ),
    ).toBe("Not sent");
  });

  it("keeps visible sent feedback after the watcher receives the event", async () => {
    let watcherCount = 1;
    const onCompleteReview = vi
      .fn<() => Promise<CompleteReviewResult>>()
      .mockImplementation(async () => {
        watcherCount = 0;
        return { delivered: true };
      });

    await renderWorkspace({
      getWatcherCount: () => watcherCount,
      onCompleteReview,
    });

    const doneReviewingButton = queryByTestId<HTMLButtonElement>(
      container,
      "review-handoff-button",
    );
    if (!doneReviewingButton) {
      throw new Error("Done Reviewing button not found");
    }

    await click(doneReviewingButton);
    await renderWorkspace({
      getWatcherCount: () => watcherCount,
      onCompleteReview,
    });

    expect(onCompleteReview).toHaveBeenCalledOnce();
    expect(
      getByTestId(container, "review-handoff-button").getAttribute(
        "aria-label",
      ),
    ).toBe("Sent");
    expect(container.textContent).not.toContain("Agent notified");
  });

  it("lets a new watcher start another handoff after sent feedback", async () => {
    let watcherCount = 1;
    const onCompleteReview = vi
      .fn<() => Promise<CompleteReviewResult>>()
      .mockImplementation(async () => {
        watcherCount = 0;
        return { delivered: true };
      });

    await renderWorkspace({
      getWatcherCount: () => watcherCount,
      onCompleteReview,
    });

    const doneReviewingButton = queryByTestId<HTMLButtonElement>(
      container,
      "review-handoff-button",
    );
    if (!doneReviewingButton) {
      throw new Error("Done Reviewing button not found");
    }

    await click(doneReviewingButton);
    await renderWorkspace({
      getWatcherCount: () => watcherCount,
      onCompleteReview,
    });

    expect(
      getByTestId(container, "review-handoff-button").getAttribute(
        "aria-label",
      ),
    ).toBe("Sent");

    watcherCount = 1;
    await renderWorkspace({
      getWatcherCount: () => watcherCount,
      onCompleteReview,
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(
      getByTestId(container, "review-handoff-button").getAttribute(
        "aria-label",
      ),
    ).toBe("Done Reviewing");
    expect(container.textContent).not.toContain("Sent");
  });
});
