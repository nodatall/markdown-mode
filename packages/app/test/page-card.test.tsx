import type { Editor } from "@tiptap/react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type DocumentSaveController,
  type ManualSaveResult,
  PageCard,
  shouldDismissCommentThread,
} from "../src/PageCard";
import type { Page, StorageBackend } from "../src/storage";

function createDomRect({
  left = 0,
  top = 0,
  width = 120,
  height = 24,
}: {
  left?: number;
  top?: number;
  width?: number;
  height?: number;
} = {}) {
  return {
    x: left,
    y: top,
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
    toJSON() {
      return this;
    },
  } as DOMRect;
}

function createBackend(): StorageBackend {
  return {
    info: {
      kind: "local-storage",
      label: "Test backend",
      detail: "In-memory",
    },
    canManageProjects: false,
    async listPages() {
      return [];
    },
    async getPage(id) {
      return { id, title: id, content: "" };
    },
    async getMarkdownFile(relativePath) {
      return { id: relativePath, title: relativePath, content: "" };
    },
    async savePage() {},
    async saveMarkdownFile() {
      return undefined;
    },
    async createPage(title = "Untitled", content = "") {
      return { id: title, title, content };
    },
    async deletePage() {},
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
    async listDirectories(path = ".") {
      return {
        path,
        parentPath: null,
        directories: [],
      };
    },
    async listFileSystem(path = ".") {
      return {
        path,
        displayPath: path,
        parentPath: null,
        directories: [],
        files: [],
      };
    },
    async listProjectTree() {
      return { paths: [] };
    },
    async openProject() {},
    async createProject() {},
  };
}

function findTextRange(editor: Editor, text: string) {
  let range: { from: number; to: number } | null = null;

  editor.state.doc.descendants((node, pos) => {
    if (!node.isText || !node.text) return;

    const offset = node.text.indexOf(text);
    if (offset < 0) return;

    range = {
      from: pos + offset,
      to: pos + offset + text.length,
    };

    return false;
  });

  return range;
}

async function flushReact() {
  await act(async () => {
    await Promise.resolve();
  });
}

async function flushAnimationFrame() {
  await act(async () => {
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => resolve());
    });
  });
}

async function flushCommentLayout() {
  await flushAnimationFrame();
  await flushReact();
  await flushAnimationFrame();
}

async function selectText(editor: Editor, text: string) {
  const range = findTextRange(editor, text);
  expect(range).not.toBeNull();
  if (!range) {
    throw new Error(`Could not find text range for "${text}"`);
  }

  await act(async () => {
    editor.commands.focus();
    editor.commands.setTextSelection(range);
  });

  await flushReact();
}

async function addCommentWithShortcut() {
  await flushAnimationFrame();
  if (queryByTestId(document, "comment-rail-c1-editor")) {
    return;
  }

  const isApplePlatform = /mac|iphone|ipad|ipod/i.test(navigator.platform);

  await act(async () => {
    document.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "m",
        code: "KeyM",
        altKey: true,
        ctrlKey: !isApplePlatform,
        metaKey: isApplePlatform,
        bubbles: true,
        cancelable: true,
      }),
    );
    await Promise.resolve();
  });
  await flushReact();
  await flushReact();
}

async function insertTextAtEnd(editor: Editor, text: string) {
  await act(async () => {
    editor.chain().focus("end").insertContent(text).run();
  });

  await flushReact();
}

async function typeTextAsBrowserInput(editor: Editor, text: string) {
  for (const character of text) {
    await act(async () => {
      const { from, to } = editor.state.selection;
      let handled = false;

      editor.view.someProp("handleTextInput", (handler) => {
        handled = handler(editor.view, from, to, character);
        return handled;
      });

      expect(handled).toBe(true);
    });
  }

  await flushReact();
}

async function pressEditorKey(
  editor: Editor,
  key: string,
  options: {
    ctrlKey?: boolean;
    altKey?: boolean;
    metaKey?: boolean;
  } = {},
) {
  await act(async () => {
    let handled = false;

    editor.view.someProp("handleKeyDown", (handler) => {
      handled = handler(
        editor.view,
        new KeyboardEvent("keydown", {
          key,
          ...options,
          bubbles: true,
          cancelable: true,
        }),
      );
      return handled;
    });

    expect(handled).toBe(true);
  });

  await flushReact();
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

function getEditable(container: HTMLElement) {
  const editor = getByTestId(container, "rich-text-editor");
  const editable = editor.querySelector(".ProseMirror");
  expect(editable).not.toBeNull();
  return editable as HTMLElement;
}

type PageCardTestOptions = Partial<{
  page: Page;
  activeDocumentPath: string | null;
  backend: StorageBackend;
  editorViewMode: "rich-text" | "code";
  interactionMode: "viewing" | "suggesting" | "editing";
  selected: boolean;
  focusRequestKey: string | null;
  saveBlocked: boolean;
  forceResetKey: string | null;
  onCommentSubmit: (commentId: string) => void;
}>;

type RenderedPageCard = {
  container: HTMLDivElement;
  onSave: ReturnType<typeof vi.fn>;
  onSaveStateChange: ReturnType<typeof vi.fn>;
  getEditor: () => Editor;
  getSaveController: () => DocumentSaveController;
  rerender: (overrides?: PageCardTestOptions) => Promise<void>;
  unmount: () => Promise<void>;
};

const cleanups: Array<() => Promise<void>> = [];

async function renderPageCard(
  options: PageCardTestOptions = {},
): Promise<RenderedPageCard> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const backend = options.backend ?? createBackend();
  const onSave = vi.fn().mockResolvedValue(undefined);
  const onSaveStateChange = vi.fn();
  const onCommentSubmit = vi.fn();
  let editor: Editor | null = null;
  let saveController: DocumentSaveController | null = null;

  let props = {
    page: options.page ?? {
      id: "page-1",
      title: "Page 1",
      content: "Start",
    },
    activeDocumentPath: options.activeDocumentPath ?? null,
    selected: options.selected ?? true,
    focusRequestKey: options.focusRequestKey ?? null,
    editorViewMode: options.editorViewMode ?? "rich-text",
    interactionMode: options.interactionMode ?? "editing",
    onSave,
    onSaveStateChange,
    backend,
    onEditorReady: (nextEditor: Editor | null) => {
      editor = nextEditor;
    },
    onSaveControllerChange: (controller: DocumentSaveController | null) => {
      saveController = controller;
    },
    onCommentSubmit: options.onCommentSubmit ?? onCommentSubmit,
    saveBlocked: options.saveBlocked ?? false,
    forceResetKey: options.forceResetKey ?? null,
  } as const;

  const render = async () => {
    await act(async () => {
      const pageCard = <PageCard {...props} />;

      root.render(pageCard);

      await Promise.resolve();
    });
  };

  await render();

  const unmount = async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
  };

  cleanups.push(unmount);

  return {
    container,
    onSave,
    onSaveStateChange,
    getEditor() {
      expect(editor).not.toBeNull();
      return editor as Editor;
    },
    getSaveController() {
      expect(saveController).not.toBeNull();
      return saveController as DocumentSaveController;
    },
    async rerender(overrides = {}) {
      props = {
        ...props,
        ...overrides,
        page: overrides.page ?? props.page,
      };
      await render();
    },
    unmount,
  };
}

describe("PageCard comment thread dismissal", () => {
  it("keeps the thread open for clicks inside the thread container", () => {
    const container = document.createElement("div");
    container.dataset.commentThreadContainer = "true";
    const child = document.createElement("button");
    container.appendChild(child);

    expect(shouldDismissCommentThread(child)).toBe(false);
  });

  it("keeps the thread open for clicks on comment anchors", () => {
    const anchor = document.createElement("span");
    anchor.className = "comment-anchor";
    anchor.dataset.commentIds = JSON.stringify(["c1"]);

    expect(shouldDismissCommentThread(anchor)).toBe(false);
  });

  it("dismisses the thread for background clicks", () => {
    const background = document.createElement("div");

    expect(shouldDismissCommentThread(background)).toBe(true);
  });
});

describe("PageCard editor integration", () => {
  beforeEach(() => {
    vi.useRealTimers();
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
      function getBoundingClientRect() {
        const isEditor = this.classList.contains("ProseMirror");
        const isAnchor = this.classList.contains("comment-anchor");

        return createDomRect({
          width: isEditor ? 640 : isAnchor ? 80 : 120,
          height: isEditor ? 240 : 24,
        });
      },
    );

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
      value: {
        ready: Promise.resolve(),
      },
    });

    Object.defineProperty(Range.prototype, "getBoundingClientRect", {
      configurable: true,
      value() {
        return createDomRect({
          width: 80,
          height: 20,
        });
      },
    });

    Object.defineProperty(Range.prototype, "getClientRects", {
      configurable: true,
      value() {
        return [createDomRect({ width: 80, height: 20 })];
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
        return [createDomRect({ width: 80, height: 20 })];
      },
    });

    window.scrollBy = vi.fn();
  });

  afterEach(async () => {
    while (cleanups.length > 0) {
      const cleanup = cleanups.pop();
      if (cleanup) {
        await cleanup();
      }
    }

    vi.useRealTimers();
    vi.restoreAllMocks();
    window.history.replaceState(null, "", "/");
  });

  it("document mode edits trigger autosave", async () => {
    const rendered = await renderPageCard({
      page: {
        id: "doc-1",
        title: "Doc 1",
        content: "Start",
      },
      selected: true,
    });

    vi.useFakeTimers();

    await insertTextAtEnd(rendered.getEditor(), " now");

    expect(rendered.onSaveStateChange).toHaveBeenCalledWith("saving");

    await act(async () => {
      vi.advanceTimersByTime(500);
      await Promise.resolve();
    });

    expect(rendered.onSave).toHaveBeenCalledTimes(1);
    expect(rendered.onSave).toHaveBeenCalledWith(
      "doc-1",
      expect.stringContaining("Start now"),
    );
    expect(rendered.onSaveStateChange.mock.calls.at(-1)?.[0]).toBe("saved");
  });

  it("manual save flushes pending rich-text autosave immediately", async () => {
    const rendered = await renderPageCard({
      page: {
        id: "doc-manual-save-rich-1",
        title: "Manual Save Rich",
        content: "Start",
      },
      selected: true,
    });

    vi.useFakeTimers();

    await insertTextAtEnd(rendered.getEditor(), " now");

    expect(rendered.onSaveStateChange.mock.calls.at(-1)?.[0]).toBe("saving");
    expect(rendered.onSave).not.toHaveBeenCalled();

    await act(async () => {
      await rendered.getSaveController().flushSave();
    });

    expect(rendered.onSave).toHaveBeenCalledTimes(1);
    expect(rendered.onSave).toHaveBeenCalledWith(
      "doc-manual-save-rich-1",
      expect.stringContaining("Start now"),
    );

    await act(async () => {
      vi.advanceTimersByTime(500);
      await Promise.resolve();
    });

    expect(rendered.onSave).toHaveBeenCalledTimes(1);
    expect(rendered.onSaveStateChange.mock.calls.at(-1)?.[0]).toBe("saved");
  });

  it("manual save reports save failure without clearing dirty state", async () => {
    const rendered = await renderPageCard({
      page: {
        id: "doc-manual-save-failure-1",
        title: "Manual Save Failure",
        content: "Start",
      },
      selected: true,
    });
    rendered.onSave.mockRejectedValueOnce(new Error("disk unavailable"));

    vi.useFakeTimers();

    await insertTextAtEnd(rendered.getEditor(), " failed");

    let result: ManualSaveResult | undefined;
    await act(async () => {
      result = await rendered.getSaveController().flushSave();
    });

    expect(result).toMatchObject({ status: "error" });
    expect(rendered.onSaveStateChange.mock.calls.at(-1)?.[0]).toBe("error");
  });

  it("manual save is blocked without calling onSave when disk state blocks saves", async () => {
    const rendered = await renderPageCard({
      page: {
        id: "doc-manual-save-blocked-1",
        title: "Manual Save Blocked",
        content: "Start",
      },
      selected: true,
    });

    vi.useFakeTimers();
    await insertTextAtEnd(rendered.getEditor(), " blocked");
    await rendered.rerender({ saveBlocked: true });

    let result: ManualSaveResult | undefined;
    await act(async () => {
      result = await rendered.getSaveController().flushSave();
    });

    expect(result).toEqual({ status: "blocked" });
    expect(rendered.onSave).not.toHaveBeenCalled();
    expect(rendered.onSaveStateChange.mock.calls.at(-1)?.[0]).toBe("unsaved");
  });

  it("rich-text edits preserve raw YAML frontmatter on autosave", async () => {
    const frontmatter = [
      "---",
      "title: Frontmatter autosave",
      "summary: |",
      "  | column | value |",
      "  | --- | --- |",
      "  | path | docs/table.md |",
      "tags:",
      "  - roughdraft",
      "---",
      "",
    ].join("\n");
    const rendered = await renderPageCard({
      page: {
        id: "doc-frontmatter-autosave-1",
        title: "Doc Frontmatter Autosave 1",
        content: `${frontmatter}# Body\nKeep this body editable.\n`,
      },
      selected: true,
    });

    vi.useFakeTimers();

    await insertTextAtEnd(rendered.getEditor(), " updated");

    await act(async () => {
      vi.advanceTimersByTime(500);
      await Promise.resolve();
    });

    expect(rendered.onSave).toHaveBeenCalledTimes(1);
    expect(rendered.onSave.mock.calls[0]?.[1]).toBe(
      `${frontmatter}# Body\nKeep this body editable. updated\n`,
    );
  });

  it("rich-text edits preserve normal markdown table headers on autosave", async () => {
    const content = [
      "# Body",
      "| Column | Value |",
      "| --- | --- |",
      "| Body table | This table should remain editable as Markdown content. |",
      "",
    ].join("\n");
    const rendered = await renderPageCard({
      page: {
        id: "doc-table-autosave-1",
        title: "Doc Table Autosave 1",
        content,
      },
      selected: true,
    });

    vi.useFakeTimers();

    await insertTextAtEnd(rendered.getEditor(), " updated");

    await act(async () => {
      vi.advanceTimersByTime(500);
      await Promise.resolve();
    });

    expect(rendered.onSave).toHaveBeenCalledTimes(1);
    expect(rendered.onSave.mock.calls[0]?.[1]).toBe(
      [
        "# Body",
        "| Column | Value |",
        "| --- | --- |",
        "| Body table | This table should remain editable as Markdown content. |",
        "",
        "updated",
        "",
      ].join("\n"),
    );
  });

  it.each([
    {
      label: "as first body block",
      bodyLines: [
        "| Column | Value |",
        "| --- | --- |",
        "| Body table | This table is the first body block. |",
      ],
    },
    {
      label: "after a heading",
      bodyLines: [
        "# Body",
        "| Column | Value |",
        "| --- | --- |",
        "| Body table | This table follows a heading. |",
      ],
    },
  ])("rich-text edits preserve table headers after frontmatter $label", async ({
    label,
    bodyLines,
  }) => {
    const frontmatter = ["---", "title: Table body", "---", ""].join("\n");
    const body = [...bodyLines, ""].join("\n");
    const rendered = await renderPageCard({
      page: {
        id: `doc-frontmatter-table-autosave-${label.replaceAll(" ", "-")}`,
        title: "Doc Frontmatter Table Autosave",
        content: `${frontmatter}${body}`,
      },
      selected: true,
    });

    vi.useFakeTimers();

    await insertTextAtEnd(rendered.getEditor(), " updated");

    await act(async () => {
      vi.advanceTimersByTime(500);
      await Promise.resolve();
    });

    expect(rendered.onSave).toHaveBeenCalledTimes(1);
    expect(rendered.onSave.mock.calls[0]?.[1]).toBe(
      `${frontmatter}${[...bodyLines, "", "updated", ""].join("\n")}`,
    );
  });

  it("viewing mode disables rich-text editing", async () => {
    const rendered = await renderPageCard({
      page: {
        id: "doc-viewing-1",
        title: "Doc Viewing 1",
        content: "Read only",
      },
      interactionMode: "viewing",
      selected: true,
    });

    expect(
      getEditable(rendered.container).getAttribute("contenteditable"),
    ).toBe("false");
  });

  it("renders local markdown document links as Roughdraft routes", async () => {
    window.history.replaceState(
      null,
      "",
      "/?path=%2FUsers%2Fme%2Fproject%2Fnotes%2Fsource.md",
    );
    const backend = createBackend();
    backend.info = {
      ...backend.info,
      projectPath: "/Users/me/project",
    };

    const rendered = await renderPageCard({
      backend,
      activeDocumentPath: "notes/source.md",
      page: {
        id: "notes/source",
        title: "Source",
        content: "[Target](target.md)\n\n![Diagram](diagram.png)",
      },
    });

    expect(
      rendered.container
        .querySelector("a[data-markdown-src='target.md']")
        ?.getAttribute("href"),
    ).toBe("/?path=%2FUsers%2Fme%2Fproject%2Fnotes%2Ftarget.md");
    expect(
      rendered.container
        .querySelector("img[data-markdown-src='diagram.png']")
        ?.getAttribute("src"),
    ).toBe("file://diagram.png");
  });

  it("opens local markdown document links through Roughdraft from the link popover", async () => {
    window.history.replaceState(
      null,
      "",
      "/?path=%2FUsers%2Fme%2Fproject%2Fnotes%2Fsource.md",
    );
    const backend = createBackend();
    backend.info = {
      ...backend.info,
      projectPath: "/Users/me/project",
    };
    const openWindow = vi.spyOn(window, "open").mockImplementation(() => null);
    const rendered = await renderPageCard({
      backend,
      activeDocumentPath: "notes/source.md",
      page: {
        id: "notes/source",
        title: "Source",
        content: "[Target](target.md)",
      },
    });

    const link = rendered.container.querySelector(
      "a[data-markdown-src='target.md']",
    );
    expect(link).not.toBeNull();

    await act(async () => {
      link?.dispatchEvent(
        new MouseEvent("mousedown", { bubbles: true, cancelable: true }),
      );
    });
    await flushAnimationFrame();

    const openButton = document.querySelector<HTMLButtonElement>(
      'button[aria-label="Open link in new tab"]',
    );
    expect(openButton).not.toBeNull();

    await act(async () => {
      openButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(openWindow).toHaveBeenCalledWith(
      "/?path=%2FUsers%2Fme%2Fproject%2Fnotes%2Ftarget.md",
      "_blank",
      "noopener,noreferrer",
    );
  });

  it("keeps focus in the editor when placing the cursor inside a link", async () => {
    const rendered = await renderPageCard({
      page: {
        id: "doc-link-cursor-focus-1",
        title: "Doc Link Cursor Focus 1",
        content: "[linked](https://example.com)",
      },
      interactionMode: "editing",
      selected: true,
    });
    const editor = rendered.getEditor();

    await act(async () => {
      const range = findTextRange(editor, "linked");
      expect(range).not.toBeNull();
      editor.commands.focus();
      editor.commands.setTextSelection((range?.from ?? 1) + 2);
    });
    await flushAnimationFrame();

    expect(document.activeElement).toBe(getEditable(rendered.container));
    expect(queryByTestId(rendered.container, "link-url-input")).toBeNull();
  });

  it("opens the link edit popover without focusing the URL input when clicking link text", async () => {
    const rendered = await renderPageCard({
      page: {
        id: "doc-link-click-popover-1",
        title: "Doc Link Click Popover 1",
        content: "[linked](https://example.com)",
      },
      interactionMode: "editing",
      selected: true,
    });

    const link = rendered.container.querySelector(
      'a[href="https://example.com"]',
    );
    expect(link).not.toBeNull();

    await act(async () => {
      link?.dispatchEvent(
        new MouseEvent("mousedown", { bubbles: true, cancelable: true }),
      );
    });
    await flushAnimationFrame();

    const input = queryByTestId<HTMLInputElement>(
      rendered.container,
      "link-url-input",
    );

    expect(input).not.toBeNull();
    expect(input?.value).toBe("https://example.com");
    expect(document.activeElement).not.toBe(input);
  });

  it("suggesting mode turns typed text into insertion markup", async () => {
    const rendered = await renderPageCard({
      page: {
        id: "doc-suggesting-1",
        title: "Doc Suggesting 1",
        content: "Start",
      },
      interactionMode: "suggesting",
      selected: true,
    });
    const editor = rendered.getEditor();

    vi.useFakeTimers();

    await act(async () => {
      editor.commands.focus("end");
      const position = editor.state.selection.from;
      editor.view.someProp("handleTextInput", (handler) =>
        handler(editor.view, position, position, " now"),
      );
    });

    await act(async () => {
      vi.advanceTimersByTime(500);
      await Promise.resolve();
    });

    expect(rendered.onSave).toHaveBeenCalledWith(
      "doc-suggesting-1",
      expect.stringMatching(
        /^Start \{\+\+now\+\+\}\{id="s1" by="user" at="[^"]+"\}\n$/,
      ),
    );
  });

  it("suggesting mode groups sequential insertion keystrokes into one suggestion", async () => {
    const rendered = await renderPageCard({
      page: {
        id: "doc-suggesting-grouped-insertion-1",
        title: "Doc Suggesting Grouped Insertion 1",
        content: "Start-",
      },
      interactionMode: "suggesting",
      selected: true,
    });
    const editor = rendered.getEditor();

    vi.useFakeTimers();

    await act(async () => {
      const range = findTextRange(editor, "Start-");
      expect(range).not.toBeNull();
      editor.commands.focus();
      editor.commands.setTextSelection(range?.to ?? editor.state.selection.to);
    });
    await typeTextAsBrowserInput(editor, "now");

    await act(async () => {
      vi.advanceTimersByTime(500);
      await Promise.resolve();
    });

    expect(rendered.onSave).toHaveBeenCalledWith(
      "doc-suggesting-grouped-insertion-1",
      expect.stringMatching(
        /^Start-\{\+\+now\+\+\}\{id="s1" by="user" at="[^"]+"\}\n$/,
      ),
    );
  });

  it("suggesting mode turns typed replacement into substitution markup", async () => {
    const rendered = await renderPageCard({
      page: {
        id: "doc-suggesting-2",
        title: "Doc Suggesting 2",
        content: "Use old text",
      },
      interactionMode: "suggesting",
      selected: true,
    });
    const editor = rendered.getEditor();

    vi.useFakeTimers();
    await selectText(editor, "old");

    await act(async () => {
      const { from, to } = editor.state.selection;
      editor.view.someProp("handleTextInput", (handler) =>
        handler(editor.view, from, to, "new"),
      );
    });

    await act(async () => {
      vi.advanceTimersByTime(500);
      await Promise.resolve();
    });

    expect(rendered.onSave).toHaveBeenCalledWith(
      "doc-suggesting-2",
      expect.stringMatching(
        /^Use \{~~old~>new~~\}\{id="s1" by="user" at="[^"]+"\} text\n$/,
      ),
    );
  });

  it("suggesting mode groups sequential replacement keystrokes into one suggestion", async () => {
    const rendered = await renderPageCard({
      page: {
        id: "doc-suggesting-grouped-replacement-1",
        title: "Doc Suggesting Grouped Replacement 1",
        content: "Use old text",
      },
      interactionMode: "suggesting",
      selected: true,
    });
    const editor = rendered.getEditor();

    vi.useFakeTimers();
    await selectText(editor, "old");
    await typeTextAsBrowserInput(editor, "new");

    await act(async () => {
      vi.advanceTimersByTime(500);
      await Promise.resolve();
    });

    expect(rendered.onSave).toHaveBeenCalledWith(
      "doc-suggesting-grouped-replacement-1",
      expect.stringMatching(
        /^Use \{~~old~>new~~\}\{id="s1" by="user" at="[^"]+"\} text\n$/,
      ),
    );
  });

  it("suggesting mode advances repeated Delete keypresses from a cursor", async () => {
    const rendered = await renderPageCard({
      page: {
        id: "doc-suggesting-repeated-delete-1",
        title: "Doc Suggesting Repeated Delete 1",
        content: "Start",
      },
      interactionMode: "suggesting",
      selected: true,
    });
    const editor = rendered.getEditor();

    vi.useFakeTimers();

    await act(async () => {
      const range = findTextRange(editor, "Start");
      expect(range).not.toBeNull();
      editor.commands.focus();
      editor.commands.setTextSelection((range?.from ?? 1) + 1);
    });

    await pressEditorKey(editor, "Delete");
    await pressEditorKey(editor, "Delete");
    await pressEditorKey(editor, "Delete");

    await act(async () => {
      vi.advanceTimersByTime(500);
      await Promise.resolve();
    });

    expect(rendered.onSave).toHaveBeenCalledWith(
      "doc-suggesting-repeated-delete-1",
      expect.stringMatching(
        /^S\{--tar--\}\{id="s1" by="user" at="[^"]+"\}t\n$/,
      ),
    );
  });

  it("suggesting mode tracks Enter at the end of a paragraph as an inserted paragraph", async () => {
    const rendered = await renderPageCard({
      page: {
        id: "doc-suggesting-enter-paragraph-1",
        title: "Doc Suggesting Enter Paragraph 1",
        content: "Start",
      },
      interactionMode: "suggesting",
      selected: true,
    });
    const editor = rendered.getEditor();

    vi.useFakeTimers();

    await act(async () => {
      editor.commands.focus("end");
    });
    await pressEditorKey(editor, "Enter");
    await act(async () => {
      vi.advanceTimersByTime(20);
      await Promise.resolve();
    });

    expect(rendered.container.textContent).toContain("Inserted paragraph");

    await act(async () => {
      vi.advanceTimersByTime(500);
      await Promise.resolve();
    });

    expect(rendered.onSave).toHaveBeenCalledWith(
      "doc-suggesting-enter-paragraph-1",
      expect.stringMatching(
        /^Start\n\n\{\+\+\u2060\+\+\}\{id="s1" by="user" at="[^"]+"\}\n$/,
      ),
    );
  });

  it("accepts and rejects inserted paragraph suggestions without leaving marker text", async () => {
    const accepted = await renderPageCard({
      page: {
        id: "doc-suggesting-enter-accept-1",
        title: "Doc Suggesting Enter Accept 1",
        content: "Start",
      },
      interactionMode: "suggesting",
      selected: true,
    });
    const acceptEditor = accepted.getEditor();

    await act(async () => {
      acceptEditor.commands.focus("end");
    });
    await pressEditorKey(acceptEditor, "Enter");
    await act(async () => {
      acceptEditor.commands.acceptCriticChange("s1");
    });

    expect(acceptEditor.state.doc.childCount).toBe(2);
    expect(acceptEditor.getText()).not.toContain("\u2060");

    const rejected = await renderPageCard({
      page: {
        id: "doc-suggesting-enter-reject-1",
        title: "Doc Suggesting Enter Reject 1",
        content: "Start",
      },
      interactionMode: "suggesting",
      selected: true,
    });
    const rejectEditor = rejected.getEditor();

    await act(async () => {
      rejectEditor.commands.focus("end");
    });
    await pressEditorKey(rejectEditor, "Enter");
    await act(async () => {
      rejectEditor.commands.rejectCriticChange("s1");
    });

    expect(rejectEditor.state.doc.childCount).toBe(1);
    expect(rejectEditor.getText()).toBe("Start");
  });

  it("suggesting mode consumes Ctrl+Backspace at a paragraph start without joining paragraphs", async () => {
    const rendered = await renderPageCard({
      page: {
        id: "doc-suggesting-boundary-backspace-1",
        title: "Doc Suggesting Boundary Backspace 1",
        content: "First paragraph\n\nSecond paragraph",
      },
      interactionMode: "suggesting",
      selected: true,
    });
    const editor = rendered.getEditor();

    await act(async () => {
      const range = findTextRange(editor, "Second paragraph");
      expect(range).not.toBeNull();
      editor.commands.focus();
      editor.commands.setTextSelection(range?.from ?? 1);
    });
    await pressEditorKey(editor, "Backspace", { ctrlKey: true });

    expect(editor.state.doc.childCount).toBe(2);
    expect(editor.getText()).toBe("First paragraph\n\nSecond paragraph");
  });

  it("suggesting mode consumes Ctrl+Delete at a paragraph end without joining paragraphs", async () => {
    const rendered = await renderPageCard({
      page: {
        id: "doc-suggesting-boundary-delete-1",
        title: "Doc Suggesting Boundary Delete 1",
        content: "First paragraph\n\nSecond paragraph",
      },
      interactionMode: "suggesting",
      selected: true,
    });
    const editor = rendered.getEditor();

    await act(async () => {
      const range = findTextRange(editor, "First paragraph");
      expect(range).not.toBeNull();
      editor.commands.focus();
      editor.commands.setTextSelection(range?.to ?? 1);
    });
    await pressEditorKey(editor, "Delete", { ctrlKey: true });

    expect(editor.state.doc.childCount).toBe(2);
    expect(editor.getText()).toBe("First paragraph\n\nSecond paragraph");
  });

  it("document code mode shows raw markdown and hides rich text chrome", async () => {
    const rendered = await renderPageCard({
      page: {
        id: "doc-code-1",
        title: "Doc Code 1",
        content: "{==alpha==}{>>Comment body<<}\n\n# Heading\n\n`inline`",
      },
      editorViewMode: "code",
      selected: true,
    });

    expect(rendered.container.textContent).toContain("{==alpha==}");
    expect(rendered.container.textContent).toContain("{>>Comment body<<}");
    expect(
      queryByTestId(rendered.container, "selection-menu-block-type"),
    ).toBeNull();
    expect(
      rendered.container
        .querySelector('[data-testid="document-review-rail"]')
        ?.classList.contains("invisible"),
    ).toBe(true);
  });

  it("document code mode keeps rail space when comments exist", async () => {
    const rendered = await renderPageCard({
      page: {
        id: "doc-code-2",
        title: "Doc Code 2",
        content: "{==alpha==}{>>Comment body<<}\n\nParagraph",
      },
      editorViewMode: "code",
      selected: true,
    });

    expect(
      rendered.container
        .querySelector('[data-testid="document-page-shell"]')
        ?.classList.contains("document-page-shell-no-comments"),
    ).toBe(false);
    expect(
      queryByTestId(rendered.container, "document-review-rail"),
    ).not.toBeNull();
  });

  it("document code mode does not keep rail space for fenced CriticMarkup examples", async () => {
    const rendered = await renderPageCard({
      page: {
        id: "doc-code-examples",
        title: "Doc Code Examples",
        content: [
          "```md",
          "This is {--deleted--} text.",
          "This is {++inserted++} text.",
          "This is {~~old~>new~~} substituted text.",
          "This is {>>a comment<<} in the margin.",
          "```",
        ].join("\n"),
      },
      editorViewMode: "code",
      selected: true,
    });

    expect(
      rendered.container
        .querySelector('[data-testid="document-page-shell"]')
        ?.classList.contains("document-page-shell-no-comments"),
    ).toBe(true);
    expect(
      queryByTestId(rendered.container, "document-review-rail"),
    ).toBeNull();
  });

  it("document code mode shows line numbers without the default dotted focus outline", async () => {
    const rendered = await renderPageCard({
      page: {
        id: "doc-code-3",
        title: "Doc Code 3",
        content: "# Heading\n\nParagraph",
      },
      editorViewMode: "code",
      selected: true,
    });

    const editor = getByTestId(
      rendered.container,
      "markdown-code-editor",
    ).querySelector(".cm-editor");
    expect(editor).not.toBeNull();

    const gutters = getByTestId(
      rendered.container,
      "markdown-code-editor",
    ).querySelector(".cm-gutters");
    expect(gutters).not.toBeNull();
    expect(gutters?.textContent).toContain("1");
    expect(getComputedStyle(gutters as Element).display).not.toBe("none");
    expect(getComputedStyle(editor as Element).outlineStyle).not.toBe("dotted");
  });

  it("selection opens the comment composer directly", async () => {
    const rendered = await renderPageCard({
      page: {
        id: "doc-2",
        title: "Doc 2",
        content: "# Heading\n\nParagraph with **bold** text",
      },
      selected: true,
    });

    const editor = rendered.getEditor();

    await selectText(editor, "Heading");
    await flushCommentLayout();
    await flushReact();
    expect(
      queryByTestId(rendered.container, "selection-menu-action-comment"),
    ).toBeNull();
    expect(
      queryByTestId(rendered.container, "comment-rail-c1-editor"),
    ).not.toBeNull();
    expect(
      getByTestId(
        rendered.container,
        "document-comment-marker-c1",
      ).getAttribute("aria-label"),
    ).toBe("New comment");
  });

  it("shows an unsaved comment marker before comment text is submitted", async () => {
    const rendered = await renderPageCard({
      page: {
        id: "doc-empty-comment-dismiss",
        title: "Doc Empty Comment Dismiss",
        content: "# Heading\n\nParagraph with **bold** text",
      },
      selected: true,
    });

    await selectText(rendered.getEditor(), "Paragraph");
    await flushCommentLayout();
    expect(
      queryByTestId(rendered.container, "comment-rail-c1-editor"),
    ).not.toBeNull();
    expect(
      getByTestId(
        rendered.container,
        "document-comment-marker-c1",
      ).getAttribute("aria-label"),
    ).toBe("New comment");

    expect(
      getByTestId<HTMLButtonElement>(
        rendered.container,
        "comment-rail-c1-action-save",
      ).disabled,
    ).toBe(true);
    expect(
      queryByTestId(rendered.container, "document-comment-marker-c1"),
    ).not.toBeNull();
    expect(rendered.onSave).not.toHaveBeenCalled();
  });

  it("closes an empty comment composer when cancel is pressed", async () => {
    const rendered = await renderPageCard({
      page: {
        id: "doc-empty-comment-cancel",
        title: "Doc Empty Comment Cancel",
        content: "# Heading\n\nParagraph with **bold** text",
      },
      selected: true,
    });

    await selectText(rendered.getEditor(), "Paragraph");
    await flushCommentLayout();
    expect(
      queryByTestId(rendered.container, "comment-rail-c1-editor"),
    ).not.toBeNull();

    const PointerEventCtor = window.PointerEvent ?? MouseEvent;
    const cancelButton = getByTestId(
      rendered.container,
      "comment-rail-c1-action-cancel",
    );
    await act(async () => {
      cancelButton.dispatchEvent(
        new PointerEventCtor("pointerdown", {
          bubbles: true,
          cancelable: true,
          button: 0,
        }),
      );
    });

    await flushCommentLayout();
    expect(
      queryByTestId(rendered.container, "comment-rail-c1-editor"),
    ).toBeNull();
    expect(
      queryByTestId(rendered.container, "document-comment-marker-c1"),
    ).toBeNull();
    expect(rendered.onSave).not.toHaveBeenCalled();
  });

  it("drag selection opens the comment composer after pointer release", async () => {
    const rendered = await renderPageCard({
      page: {
        id: "doc-drag-comment",
        title: "Doc Drag Comment",
        content: "# Heading\n\nParagraph with **bold** text",
      },
      selected: true,
    });

    const editor = rendered.getEditor();
    const editable = getEditable(rendered.container);
    const PointerEventCtor = window.PointerEvent ?? MouseEvent;

    await act(async () => {
      editable.dispatchEvent(
        new PointerEventCtor("pointerdown", {
          bubbles: true,
          cancelable: true,
          button: 0,
        }),
      );
    });

    await selectText(editor, "Paragraph with");
    await flushAnimationFrame();
    expect(
      queryByTestId(rendered.container, "comment-rail-c1-editor"),
    ).toBeNull();

    await act(async () => {
      document.dispatchEvent(
        new PointerEventCtor("pointerup", {
          bubbles: true,
          cancelable: true,
          button: 0,
        }),
      );
    });

    await flushAnimationFrame();
    expect(
      queryByTestId(rendered.container, "comment-rail-c1-editor"),
    ).not.toBeNull();
  });

  it("double-click selection opens the comment composer even before pointer release", async () => {
    const rendered = await renderPageCard({
      page: {
        id: "doc-double-click-comment",
        title: "Doc Double Click Comment",
        content: "# Heading\n\nParagraph with **bold** text",
      },
      selected: true,
    });

    const editor = rendered.getEditor();
    const editable = getEditable(rendered.container);
    const PointerEventCtor = window.PointerEvent ?? MouseEvent;

    await act(async () => {
      editable.dispatchEvent(
        new PointerEventCtor("pointerdown", {
          bubbles: true,
          cancelable: true,
          button: 0,
        }),
      );
    });

    await selectText(editor, "Paragraph");
    await flushAnimationFrame();
    expect(
      queryByTestId(rendered.container, "comment-rail-c1-editor"),
    ).toBeNull();

    await act(async () => {
      editable.dispatchEvent(
        new MouseEvent("dblclick", {
          bubbles: true,
          cancelable: true,
        }),
      );
    });

    await flushAnimationFrame();
    await flushAnimationFrame();
    expect(
      queryByTestId(rendered.container, "comment-rail-c1-editor"),
    ).not.toBeNull();
  });

  it("external page content updates replace editor content when unfocused", async () => {
    const rendered = await renderPageCard({
      page: {
        id: "doc-3",
        title: "Doc 3",
        content: "Alpha",
      },
      selected: true,
    });

    expect(getEditable(rendered.container).textContent).toContain("Alpha");

    await rendered.rerender({
      page: {
        id: "doc-3",
        title: "Doc 3",
        content: "Beta",
      },
    });

    expect(getEditable(rendered.container).textContent).toContain("Beta");
    expect(getEditable(rendered.container).textContent).not.toContain("Alpha");
  });

  it("recent local save echo does not immediately overwrite current editor state", async () => {
    const rendered = await renderPageCard({
      page: {
        id: "doc-4",
        title: "Doc 4",
        content: "{==alpha==}{>>Comment body<<}\n\nTail",
      },
      selected: true,
    });

    vi.useFakeTimers();

    const editor = rendered.getEditor();
    await insertTextAtEnd(editor, " updated");

    await act(async () => {
      vi.advanceTimersByTime(500);
      await Promise.resolve();
    });

    const savedMarkdown = rendered.onSave.mock.calls[0]?.[1];
    expect(typeof savedMarkdown).toBe("string");

    await selectText(editor, "alpha");
    expect(
      queryByTestId(rendered.container, "document-comment-fallback")
        ?.textContent,
    ).toContain("Comment body");

    await act(async () => {
      editor.commands.blur();
    });

    await rendered.rerender({
      page: {
        id: "doc-4",
        title: "Doc 4",
        content: savedMarkdown as string,
      },
    });

    expect(
      queryByTestId(rendered.container, "document-comment-fallback")
        ?.textContent,
    ).toContain("Comment body");
  });

  it("same-content disk echoes do not recreate the rich text editor", async () => {
    const rendered = await renderPageCard({
      page: {
        id: "doc-same-content-echo-1",
        title: "Doc Same Content Echo 1",
        content: "Start",
      },
      selected: true,
    });

    vi.useFakeTimers();

    await insertTextAtEnd(rendered.getEditor(), " updated");

    await act(async () => {
      vi.advanceTimersByTime(500);
      await Promise.resolve();
    });

    const savedMarkdown = rendered.onSave.mock.calls[0]?.[1];
    expect(typeof savedMarkdown).toBe("string");

    const editorAfterSave = rendered.getEditor();
    const editableAfterSave = getEditable(rendered.container);

    await rendered.rerender({
      page: {
        id: "doc-same-content-echo-1",
        title: "Doc Same Content Echo 1",
        content: savedMarkdown as string,
      },
    });
    await rendered.rerender({
      page: {
        id: "doc-same-content-echo-1",
        title: "Doc Same Content Echo 1",
        content: savedMarkdown as string,
        version: "same-content-new-version",
      },
    });

    expect(rendered.getEditor()).toBe(editorAfterSave);
    expect(getEditable(rendered.container)).toBe(editableAfterSave);
    expect(rendered.getEditor().getText()).toContain("Start updated");
  });

  it("comment selection still updates fallback UI", async () => {
    const rendered = await renderPageCard({
      page: {
        id: "doc-5",
        title: "Doc 5",
        content: "{==alpha==}{>>Comment body<<}\n\nParagraph",
      },
      selected: true,
    });

    await selectText(rendered.getEditor(), "alpha");
    await flushAnimationFrame();

    expect(
      queryByTestId(rendered.container, "document-comment-fallback")
        ?.textContent,
    ).toContain("Comment body");
    expect(rendered.container.textContent).not.toContain("Me");
    expect(
      queryByTestId(rendered.container, "document-comment-markers"),
    ).not.toBeNull();
  });

  it("keeps an in-progress comment draft through same-file live updates", async () => {
    const rendered = await renderPageCard({
      page: {
        id: "doc-comment-live-draft-1",
        title: "Doc Comment Live Draft 1",
        content: "Comment target text",
      },
      selected: true,
      forceResetKey: "initial",
    });

    await selectText(rendered.getEditor(), "target");
    await addCommentWithShortcut();
    await flushCommentLayout();

    let commentEditor = getByTestId<HTMLTextAreaElement>(
      rendered.container,
      "comment-rail-c1-editor",
    );

    await act(async () => {
      const valueSetter = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        "value",
      )?.set;
      valueSetter?.call(commentEditor, "Draft survives live update");
      commentEditor.dispatchEvent(new InputEvent("input", { bubbles: true }));
    });
    await flushReact();

    await rendered.rerender({
      forceResetKey: "external-1",
      page: {
        id: "doc-comment-live-draft-1",
        title: "Doc Comment Live Draft 1",
        content: "Agent updated this document on disk",
      },
    });
    await flushReact();

    commentEditor = getByTestId<HTMLTextAreaElement>(
      rendered.container,
      "comment-rail-c1-editor",
    );
    expect(commentEditor.value).toBe("Draft survives live update");
  });

  it("does not autosave a newly-created empty comment before it is submitted", async () => {
    const onCommentSubmit = vi.fn();
    const rendered = await renderPageCard({
      page: {
        id: "doc-comment-empty-draft-1",
        title: "Doc Comment Empty Draft 1",
        content: "Comment target text",
      },
      selected: true,
      onCommentSubmit,
    });

    await selectText(rendered.getEditor(), "target");
    await addCommentWithShortcut();
    await flushCommentLayout();

    vi.useFakeTimers();

    const commentEditor = queryByTestId<HTMLTextAreaElement>(
      rendered.container,
      "comment-rail-c1-editor",
    );
    expect(commentEditor).not.toBeNull();
    expect(
      getByTestId(
        rendered.container,
        "document-comment-marker-c1",
      ).getAttribute("aria-label"),
    ).toBe("New comment");

    await act(async () => {
      vi.advanceTimersByTime(1000);
      await Promise.resolve();
    });

    expect(rendered.onSave).not.toHaveBeenCalled();
    expect(onCommentSubmit).not.toHaveBeenCalled();

    await act(async () => {
      if (!commentEditor) return;
      const valueSetter = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        "value",
      )?.set;
      valueSetter?.call(commentEditor, "Draft comment");
      commentEditor.dispatchEvent(new InputEvent("input", { bubbles: true }));
    });

    const saveButton = queryByTestId<HTMLButtonElement>(
      rendered.container,
      "comment-rail-c1-action-save",
    );
    expect(saveButton).not.toBeNull();

    await act(async () => {
      saveButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    await act(async () => {
      vi.advanceTimersByTime(500);
      await Promise.resolve();
    });

    expect(rendered.onSave).toHaveBeenCalledWith(
      "doc-comment-empty-draft-1",
      expect.stringMatching(
        /\{==target==\}\{>>Draft comment<<\}\{id="c1" by="user" at="[^"]+"\}/,
      ),
    );
    expect(onCommentSubmit).toHaveBeenCalledWith("c1");
    expect(
      getByTestId(
        rendered.container,
        "document-comment-marker-c1",
      ).getAttribute("aria-label"),
    ).toBe("Open comment 1");
    expect(
      queryByTestId(rendered.container, "document-comment-marker-c1-working"),
    ).not.toBeNull();
  });

  it("closes a new comment composer after Add and does not reopen it on outside clicks", async () => {
    const rendered = await renderPageCard({
      page: {
        id: "doc-comment-add-close-1",
        title: "Doc Comment Add Close 1",
        content: "Comment target text",
      },
      selected: true,
    });

    await selectText(rendered.getEditor(), "target");
    await flushCommentLayout();

    const commentEditor = getByTestId<HTMLTextAreaElement>(
      rendered.container,
      "comment-rail-c1-editor",
    );
    await act(async () => {
      const valueSetter = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        "value",
      )?.set;
      valueSetter?.call(commentEditor, "Close this after add");
      commentEditor.dispatchEvent(new InputEvent("input", { bubbles: true }));
      await Promise.resolve();
    });

    const addButton = getByTestId<HTMLButtonElement>(
      rendered.container,
      "comment-rail-c1-action-save",
    );
    expect(addButton.textContent).toBe("Add");

    await act(async () => {
      addButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });
    await flushCommentLayout();

    expect(
      queryByTestId(rendered.container, "comment-rail-c1-editor"),
    ).toBeNull();
    expect(
      getByTestId(
        rendered.container,
        "document-comment-marker-c1",
      ).getAttribute("aria-label"),
    ).toBe("Open comment 1");

    await act(async () => {
      document.body.dispatchEvent(
        new PointerEvent("pointerdown", {
          bubbles: true,
          cancelable: true,
          button: 0,
        }),
      );
      await Promise.resolve();
    });
    await flushCommentLayout();

    expect(
      queryByTestId(rendered.container, "comment-rail-c1-editor"),
    ).toBeNull();
  });

  it("lets existing comments be edited directly without reply, edit, or inline delete actions", async () => {
    const rendered = await renderPageCard({
      page: {
        id: "doc-comment-direct-edit-1",
        title: "Doc Comment Direct Edit 1",
        content:
          '{==alpha==}{>>Root comment<<}{id="root" by="user" at="2026-04-25T23:56:00.000Z"}{>>Nested reply<<}{id="child" by="user" at="2026-04-25T23:57:00.000Z" re="root"}\n\nParagraph',
      },
      selected: true,
    });

    await selectText(rendered.getEditor(), "alpha");

    expect(
      queryByTestId(rendered.container, "comment-rail-root-action-reply"),
    ).toBeNull();
    expect(
      queryByTestId(rendered.container, "comment-rail-root-action-edit"),
    ).toBeNull();
    expect(
      queryByTestId(rendered.container, "comment-rail-root-action-delete"),
    ).toBeNull();
    expect(
      queryByTestId(
        rendered.container,
        "comment-rail-root-action-delete-thread",
      ),
    ).not.toBeNull();

    const rootEditor = getByTestId<HTMLTextAreaElement>(
      rendered.container,
      "comment-rail-root-editor",
    );
    expect(rootEditor.value).toBe("Root comment");
    expect(
      rendered.container.querySelector('[data-testid="comment-tree-line"]'),
    ).toBeNull();

    vi.useFakeTimers();
    await act(async () => {
      const valueSetter = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        "value",
      )?.set;
      valueSetter?.call(rootEditor, "Edited root comment");
      rootEditor.dispatchEvent(new InputEvent("input", { bubbles: true }));
      await Promise.resolve();
    });

    const saveButton = getByTestId<HTMLButtonElement>(
      rendered.container,
      "comment-rail-root-action-save",
    );
    await act(async () => {
      saveButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });

    await act(async () => {
      vi.advanceTimersByTime(500);
      await Promise.resolve();
    });

    expect(rendered.onSave).toHaveBeenCalledWith(
      "doc-comment-direct-edit-1",
      expect.stringContaining("{>>Edited root comment<<}"),
    );
  });

  it("deletes only the selected comment from the far-right comment action", async () => {
    const rendered = await renderPageCard({
      page: {
        id: "doc-delete-comment-1",
        title: "Doc Delete Comment 1",
        content:
          '{==alpha==}{>>Root comment<<}{id="root" by="user" at="2026-04-25T23:56:00.000Z"}{>>Nested reply<<}{id="child" by="user" at="2026-04-25T23:57:00.000Z" re="root"}\n\nParagraph',
      },
      selected: true,
    });

    await selectText(rendered.getEditor(), "alpha");

    const deleteThreadButton = queryByTestId<HTMLButtonElement>(
      rendered.container,
      "comment-rail-root-action-delete-thread",
    );
    expect(deleteThreadButton).not.toBeNull();

    vi.useFakeTimers();
    await act(async () => {
      deleteThreadButton?.dispatchEvent(
        new MouseEvent("click", { bubbles: true }),
      );
      await Promise.resolve();
    });

    await act(async () => {
      vi.advanceTimersByTime(500);
      await Promise.resolve();
    });

    const savedMarkdown = rendered.onSave.mock.calls[0]?.[1];
    expect(savedMarkdown).toContain("alpha");
    expect(savedMarkdown).not.toContain("Root comment");
    expect(savedMarkdown).toContain("Nested reply");
    expect(savedMarkdown).not.toContain('id="root"');
    expect(savedMarkdown).toContain('id="child"');
  });

  it("renders suggestion comments only inside the suggestion card", async () => {
    const commentText = "Looks good as an inserted phrase.";
    const rendered = await renderPageCard({
      page: {
        id: "doc-suggestion-comment-1",
        title: "Doc Suggestion Comment 1",
        content: `This sentence includes an insertion: {++clearer wording++}{id="s1" by="user" at="2026-04-25T23:55:00.000Z"}{>>${commentText}<<}{id="c1" by="user" at="2026-04-25T23:56:00.000Z" re="s1"}`,
      },
      selected: true,
    });

    await flushAnimationFrame();

    const railText =
      queryByTestId(rendered.container, "document-review-rail")?.textContent ??
      "";

    expect(railText.split(commentText).length - 1).toBe(1);
  });

  it("renders suggestions without reviewer identity labels", async () => {
    const rendered = await renderPageCard({
      page: {
        id: "doc-suggestion-bubble-1",
        title: "Doc Suggestion Bubble 1",
        content:
          'This sentence removes {--conversation--}{id="s1" by="AI" at="2026-04-25T23:55:00.000Z"}',
      },
      selected: true,
    });

    await flushAnimationFrame();

    const suggestionThread = rendered.container.querySelector<HTMLElement>(
      '[data-suggestion-thread-container="true"]',
    );
    const suggestionText = suggestionThread?.textContent ?? "";

    expect(suggestionText).not.toContain("AI");
    expect(suggestionText).toContain('Delete: "conversation"');
    expect(suggestionText).not.toContain("Deletion");
  });

  it("renders suggestion comments without nested reply UI", async () => {
    const rendered = await renderPageCard({
      page: {
        id: "doc-suggestion-tree-1",
        title: "Doc Suggestion Tree 1",
        content:
          'This sentence includes {++clearer wording++}{id="s1" by="user" at="2026-04-25T23:55:00.000Z"}{>>Looks good.<<}{id="c1" by="user" at="2026-04-25T23:56:00.000Z" re="s1"}',
      },
      selected: true,
    });

    await flushAnimationFrame();

    const suggestionThread = rendered.container.querySelector<HTMLElement>(
      '[data-suggestion-thread-container="true"]',
    );

    expect(suggestionThread?.textContent).toContain(
      'Insert: "clearer wording"',
    );
    expect(suggestionThread?.textContent).toContain("Looks good.");
    expect(
      suggestionThread?.querySelector('[data-testid="comment-tree-line"]'),
    ).toBeNull();
  });

  it("preserves suggestion color when comments are attached to suggestion text", async () => {
    const rendered = await renderPageCard({
      page: {
        id: "doc-suggestion-comment-color-1",
        title: "Doc Suggestion Comment Color 1",
        content:
          'This sentence includes {++clearer wording++}{id="s1" by="user" at="2026-04-25T23:55:00.000Z"}{>>Looks good.<<}{id="c1" by="user" at="2026-04-25T23:56:00.000Z" re="s1"}',
      },
      selected: true,
    });

    await flushAnimationFrame();

    const suggestion = rendered.container.querySelector(
      '[data-critic-change-id="s1"]',
    );
    expect(suggestion?.textContent).toContain("clearer wording");
    expect(
      queryByTestId(rendered.container, "comment-decoration-on-critic-change"),
    ).not.toBeNull();
  });

  it("activates a suggestion thread when the cursor is inside suggested text", async () => {
    const rendered = await renderPageCard({
      page: {
        id: "doc-suggestion-cursor-active-1",
        title: "Doc Suggestion Cursor Active 1",
        content:
          'This sentence includes {++clearer wording++}{id="s1" by="user" at="2026-04-25T23:55:00.000Z"}{>>Looks good.<<}{id="c1" by="user" at="2026-04-25T23:56:00.000Z" re="s1"}',
      },
      selected: true,
    });
    const editor = rendered.getEditor();

    await flushAnimationFrame();
    const range = findTextRange(editor, "clearer wording");
    expect(range).not.toBeNull();

    await act(async () => {
      editor.commands.focus();
      editor.commands.setTextSelection((range?.from ?? 1) + 1);
    });
    await flushReact();
    await flushReact();

    const suggestionThread = rendered.container.querySelector<HTMLElement>(
      '[data-suggestion-thread-container="true"]',
    );
    expect(suggestionThread?.classList.contains("-translate-x-2")).toBe(true);
    expect(
      rendered.container.querySelector(".critic-change-decoration-active"),
    ).not.toBeNull();
  });

  it("centers document layout when there are no comments", async () => {
    const rendered = await renderPageCard({
      page: {
        id: "doc-6",
        title: "Doc 6",
        content: "Just text",
      },
      selected: true,
    });

    expect(
      rendered.container
        .querySelector('[data-testid="document-page-shell"]')
        ?.classList.contains("document-page-shell-no-comments"),
    ).toBe(true);

    await rendered.rerender({
      page: {
        id: "doc-6",
        title: "Doc 6",
        content: "{==alpha==}{>>Comment body<<}\n\nJust text",
      },
    });
    await flushAnimationFrame();

    expect(
      rendered.container
        .querySelector('[data-testid="document-page-shell"]')
        ?.classList.contains("document-page-shell-no-comments"),
    ).toBe(true);
    expect(
      queryByTestId(rendered.container, "document-comment-markers"),
    ).not.toBeNull();
  });

  it("document props churn does not lose editor content or selection", async () => {
    const rendered = await renderPageCard({
      page: {
        id: "doc-churn-1",
        title: "Doc Churn 1",
        content: "Hello document",
      },
      selected: true,
    });

    const editor = rendered.getEditor();
    await insertTextAtEnd(editor, " updated");
    await selectText(editor, "Hello");

    const initialEditable = getEditable(rendered.container);
    const initialSelection = {
      from: editor.state.selection.from,
      to: editor.state.selection.to,
    };

    await rendered.rerender({ selected: false });
    await rendered.rerender({ selected: true });
    await rendered.rerender({ selected: false });

    expect(rendered.getEditor().getText()).toContain("Hello document updated");
    expect(rendered.getEditor().state.selection.from).toBe(
      initialSelection.from,
    );
    expect(rendered.getEditor().state.selection.to).toBe(initialSelection.to);
    expect(getEditable(rendered.container)).toBe(initialEditable);
  });

  it("focus request changes focus the editor without recreating document state", async () => {
    const rendered = await renderPageCard({
      page: {
        id: "doc-focus-1",
        title: "Doc Focus 1",
        content: "Focus target",
      },
      selected: true,
      focusRequestKey: null,
    });

    const editor = rendered.getEditor();
    const initialEditable = getEditable(rendered.container);
    const initialSelection = editor.state.selection.from;

    await rendered.rerender({
      selected: true,
      focusRequestKey: "focus-1",
    });
    await flushAnimationFrame();

    expect(rendered.getEditor()).toBe(editor);
    expect(getEditable(rendered.container)).toBe(initialEditable);
    expect(rendered.getEditor().state.selection.from).toBeGreaterThan(
      initialSelection,
    );
    expect(rendered.getEditor().getText()).toContain("Focus target");
  });

  it("non-editor prop churn does not recreate the editor", async () => {
    const rendered = await renderPageCard({
      page: {
        id: "doc-stable-1",
        title: "Doc Stable 1",
        content: "# Heading",
      },
      selected: true,
    });

    await selectText(rendered.getEditor(), "Heading");
    const initialEditor = rendered.getEditor();
    const initialEditable = getEditable(rendered.container);

    await rendered.rerender({ selected: false });

    expect(rendered.getEditor()).toBe(initialEditor);
    expect(getEditable(rendered.container)).toBe(initialEditable);
    expect(rendered.getEditor().getText()).toContain("Heading");
  });
});
