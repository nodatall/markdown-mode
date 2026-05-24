export interface Page {
  id: string;
  title: string;
  content: string;
  version?: string;
}

export interface MarkdownFileChangeEvent {
  path: string;
  exists: boolean;
  version: string | null;
}

export class MarkdownFileConflictError extends Error {
  current: Page;

  constructor(current: Page) {
    super("Markdown file changed on disk");
    this.name = "MarkdownFileConflictError";
    this.current = current;
  }
}

export interface StoredAsset {
  markdownPath: string;
  previewUrl: string;
  mimeType: string;
}

export interface CompleteReviewResult {
  delivered: boolean;
}

export interface ReviewWatchStatus {
  watching: boolean;
  watcherCount: number;
}

export type AgentCommentSessionMode = "attached" | "detached";

export type AgentCommentTaskStatus =
  | "accepted"
  | "working"
  | "applied"
  | "failed"
  | "needs_attention";

export interface AgentCommentAdapterCapability {
  available: boolean;
  name: string;
  reason: string | null;
  supportsAttached: boolean;
  supportsDetached: boolean;
}

export interface AgentCommentSession {
  documentPath: string;
  projectPath: string;
  relativePath: string;
  mode: AgentCommentSessionMode;
  originThreadId: string | null;
  adapter: AgentCommentAdapterCapability;
}

export interface AgentCommentTask {
  id: string;
  documentPath: string;
  projectPath: string;
  relativePath: string;
  fileVersion: string;
  mode: AgentCommentSessionMode;
  originThreadId: string | null;
  status: AgentCommentTaskStatus;
  adapterName: string;
  prompt: string;
  createdAt: string;
  updatedAt: string;
  error: string | null;
  queuePosition: number;
  comment: {
    id: string;
    text: string;
    anchorText: string | null;
    line: number;
    column: number;
    offset: number;
    endOffset: number;
    author: string | null;
    createdAt: string | null;
  };
}

export interface SubmitAgentCommentTaskOptions {
  commentId: string;
  expectedVersion?: string;
}

export interface SubmitAgentCommentTaskResult {
  task: AgentCommentTask;
}

export interface BackendInfo {
  kind: "local-files" | "local-storage" | "remote";
  label: string;
  detail: string;
  projectPath?: string;
  sessionId?: string;
  originPath?: string;
  originThreadId?: string;
  authToken?: string;
}

export interface StorageBackend {
  info: BackendInfo;
  canManageProjects: boolean;
  getMarkdownFile(relativePath: string): Promise<Page>;
  saveMarkdownFile(
    relativePath: string,
    content: string,
    expectedVersion?: string,
  ): Promise<Page | undefined>;
  watchMarkdownFile?(
    relativePath: string,
    onChange: (event: MarkdownFileChangeEvent) => void,
  ): () => void;
  completeReview?(relativePath: string): Promise<CompleteReviewResult>;
  getReviewWatchStatus?(relativePath: string): Promise<ReviewWatchStatus>;
  getAgentCommentSession?(relativePath: string): Promise<AgentCommentSession>;
  submitAgentCommentTask?(
    relativePath: string,
    options: SubmitAgentCommentTaskOptions,
  ): Promise<SubmitAgentCommentTaskResult>;
  getAgentCommentTask?(taskId: string): Promise<SubmitAgentCommentTaskResult>;
  saveAsset(file: File): Promise<StoredAsset>;
  resolveFileUrl(path: string): string | null;
  openProject(path: string): Promise<void>;
}
