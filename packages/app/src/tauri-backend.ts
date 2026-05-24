import { convertFileSrc } from "@tauri-apps/api/core";
import {
  type BackendInfo,
  MarkdownFileConflictError,
  type Page,
  type StorageBackend,
  type StoredAsset,
} from "./storage";

type TauriInternalsWindow = Window & {
  __TAURI_INTERNALS__?: unknown;
};

export interface TauriMarkdownFile {
  path: string;
  fileName: string;
  baseDir: string;
  contents: string;
  modified: number;
}

interface TauriWriteResult {
  saved?: TauriMarkdownFile | null;
  conflict?: TauriMarkdownFile | null;
}

export function isTauriRuntime() {
  return (
    typeof window !== "undefined" &&
    Boolean((window as TauriInternalsWindow).__TAURI_INTERNALS__)
  );
}

async function invokeTauri<T>(command: string, args?: Record<string, unknown>) {
  if (!isTauriRuntime()) {
    throw new Error("Markdown Mode desktop APIs are not available.");
  }

  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(command, args);
}

function isAbsolutePath(path: string) {
  return path.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(path);
}

function joinNativePath(basePath: string, relativePath: string) {
  if (isAbsolutePath(relativePath)) return relativePath;

  const separator = basePath.includes("\\") ? "\\" : "/";
  return `${basePath.replace(/[\\/]+$/, "")}${separator}${relativePath.replace(/^[\\/]+/, "")}`;
}

function titleForMarkdown(file: TauriMarkdownFile) {
  const firstLine = file.contents.split(/\r?\n/, 1)[0] ?? "";
  return firstLine.replace(/^#*\s*/, "").trim() || file.fileName;
}

export class TauriBackend implements StorageBackend {
  info: BackendInfo = {
    kind: "local-files" as const,
    label: "Local files",
    detail: "Markdown file on disk",
  };

  canManageProjects = true;

  openMarkdownDialog() {
    return invokeTauri<TauriMarkdownFile | null>("open_markdown_dialog");
  }

  takePendingOpenedFile() {
    return invokeTauri<TauriMarkdownFile | null>("take_pending_opened_file");
  }

  async listenForOpenedFiles(
    onOpen: (file: TauriMarkdownFile) => void,
    onError: (message: string) => void,
  ) {
    const { listen } = await import("@tauri-apps/api/event");
    const unlistenOpen = await listen<TauriMarkdownFile>(
      "markdown-file-opened",
      (event) => onOpen(event.payload),
    );
    const unlistenError = await listen<string>(
      "markdown-file-open-error",
      (event) => onError(event.payload),
    );

    return () => {
      unlistenOpen();
      unlistenError();
    };
  }

  configureProjectFromFile(file: TauriMarkdownFile) {
    this.info = {
      ...this.info,
      detail: file.baseDir,
      projectPath: file.baseDir,
    };
    return file.fileName;
  }

  pageFromMarkdownFile(file: TauriMarkdownFile, id = file.fileName): Page {
    return {
      id,
      title: titleForMarkdown(file),
      content: file.contents,
      version: String(file.modified),
    };
  }

  async getMarkdownFile(relativePath: string): Promise<Page> {
    const absolutePath = joinNativePath(
      this.info.projectPath ?? "",
      relativePath,
    );
    const file = await invokeTauri<TauriMarkdownFile>("read_markdown_file", {
      path: absolutePath,
    });

    if (!this.info.projectPath) {
      this.configureProjectFromFile(file);
    }

    return this.pageFromMarkdownFile(file, relativePath);
  }

  async saveMarkdownFile(
    relativePath: string,
    content: string,
    expectedVersion?: string,
  ): Promise<Page> {
    const absolutePath = joinNativePath(
      this.info.projectPath ?? "",
      relativePath,
    );
    const result = await invokeTauri<TauriWriteResult>("write_markdown_file", {
      path: absolutePath,
      contents: content,
      expectedModified: expectedVersion,
    });

    if (result.conflict) {
      throw new MarkdownFileConflictError(
        this.pageFromMarkdownFile(result.conflict, relativePath),
      );
    }

    if (!result.saved) {
      throw new Error("Markdown Mode did not return the saved file.");
    }

    return this.pageFromMarkdownFile(result.saved, relativePath);
  }

  watchMarkdownFile(
    relativePath: string,
    onChange: (event: {
      path: string;
      exists: boolean;
      version: string | null;
    }) => void,
  ) {
    let lastVersion: string | null = null;
    let disposed = false;

    const poll = async () => {
      try {
        const page = await this.getMarkdownFile(relativePath);
        if (disposed) return;

        const version = page.version ?? null;
        if (lastVersion === null) {
          lastVersion = version;
          return;
        }

        if (version !== lastVersion) {
          lastVersion = version;
          onChange({ path: relativePath, exists: true, version });
        }
      } catch {
        if (!disposed) {
          onChange({ path: relativePath, exists: false, version: null });
        }
      }
    };

    void poll();
    const interval = window.setInterval(poll, 1200);
    return () => {
      disposed = true;
      window.clearInterval(interval);
    };
  }

  async completeReview() {
    const delivered = await invokeTauri<boolean>("notify_review_complete");
    return { delivered };
  }

  async saveAsset(_file: File): Promise<StoredAsset> {
    throw new Error("Image paste is not yet available in Markdown Mode.");
  }

  resolveFileUrl(path: string): string | null {
    if (!path) return null;
    const absolutePath = joinNativePath(this.info.projectPath ?? "", path);
    return convertFileSrc(absolutePath);
  }

  async openProject(path: string): Promise<void> {
    this.info = {
      ...this.info,
      detail: path || "Markdown file on disk",
      projectPath: path,
    };
  }
}

export function isTauriBackend(
  backend: StorageBackend | null,
): backend is TauriBackend {
  return backend instanceof TauriBackend;
}
