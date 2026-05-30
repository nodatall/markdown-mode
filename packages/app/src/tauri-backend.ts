import { convertFileSrc } from "@tauri-apps/api/core";
import {
  type AgentCommentSession,
  type BackendInfo,
  MarkdownFileConflictError,
  type Page,
  type StorageBackend,
  type StoredAsset,
  type SubmitAgentCommentTaskOptions,
  type SubmitAgentCommentTaskResult,
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
  serverUrl?: string | null;
  originThreadId?: string | null;
  openSessionId?: string | null;
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
  private serverUrl: string | null = null;

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
    this.serverUrl = file.serverUrl?.trim() || null;
    this.info = {
      ...this.info,
      detail: file.baseDir,
      projectPath: file.baseDir,
      originThreadId: file.originThreadId?.trim() || undefined,
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

  private buildServerUrl(route: string, params?: Record<string, string>) {
    if (!this.serverUrl) {
      throw new Error("No Markdown Mode server session is attached.");
    }

    const url = new URL(route, this.serverUrl);
    const projectPath = this.info.projectPath?.trim();
    if (projectPath) {
      url.searchParams.set("projectPath", projectPath);
    }

    const originThreadId = this.info.originThreadId?.trim();
    if (originThreadId) {
      url.searchParams.set("originThreadId", originThreadId);
    }

    Object.entries(params ?? {}).forEach(([key, value]) => {
      url.searchParams.set(key, value);
    });

    return url.toString();
  }

  async getAgentCommentSession(
    relativePath: string,
  ): Promise<AgentCommentSession> {
    if (!this.serverUrl) {
      const absolutePath = joinNativePath(
        this.info.projectPath ?? "",
        relativePath,
      );
      const projectPath = this.info.projectPath ?? "";
      return {
        documentPath: absolutePath,
        projectPath,
        relativePath,
        mode: "detached",
        originThreadId: null,
        adapter: {
          available: false,
          name: "unavailable",
          reason:
            "No Codex thread session is attached. Open this file with `markdownmode open <path>` from a Codex app thread, or use the copy prompt fallback.",
          supportsAttached: false,
          supportsDetached: false,
        },
      };
    }

    const res = await fetch(
      this.buildServerUrl("/api/agent-comment-session", {
        path: relativePath,
      }),
    );

    if (!res.ok) {
      throw new Error(
        `Failed to get agent comment session ${relativePath}: ${res.status}`,
      );
    }

    return res.json();
  }

  async submitAgentCommentTask(
    relativePath: string,
    options: SubmitAgentCommentTaskOptions,
  ): Promise<SubmitAgentCommentTaskResult> {
    if (!this.serverUrl) {
      throw new Error("No Markdown Mode server session is attached.");
    }

    const res = await fetch(
      this.buildServerUrl("/api/agent-comment-tasks", {
        path: relativePath,
      }),
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectPath: this.info.projectPath,
          path: relativePath,
          originThreadId: this.info.originThreadId,
          ...options,
        }),
      },
    );

    if (!res.ok) {
      throw new Error(
        `Failed to submit agent comment task ${relativePath}: ${res.status}`,
      );
    }

    return res.json();
  }

  async getAgentCommentTask(
    taskId: string,
  ): Promise<SubmitAgentCommentTaskResult> {
    if (!this.serverUrl) {
      throw new Error("No Markdown Mode server session is attached.");
    }

    const res = await fetch(
      this.buildServerUrl(`/api/agent-comment-tasks/${taskId}`),
    );

    if (!res.ok) {
      throw new Error(
        `Failed to get agent comment task ${taskId}: ${res.status}`,
      );
    }

    return res.json();
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
