import fs from "node:fs";
import path from "node:path";
import type { RfmReviewItem } from "@roughdraft/rfm";

export type AgentCommentSessionMode = "attached" | "detached";

export type AgentCommentTaskStatus =
  | "accepted"
  | "working"
  | "applied"
  | "failed"
  | "needs_attention";

export interface AgentCommentSession {
  documentPath: string;
  projectPath: string;
  relativePath: string;
  mode: AgentCommentSessionMode;
  originThreadId: string | null;
  adapter: AgentCommentAdapterCapability;
}

export interface AgentCommentAdapterCapability {
  available: boolean;
  name: string;
  reason: string | null;
  supportsAttached: boolean;
  supportsDetached: boolean;
}

export interface AgentCommentTaskInput {
  documentPath: string;
  projectPath: string;
  relativePath: string;
  fileVersion: string;
  mode: AgentCommentSessionMode;
  originThreadId: string | null;
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

export interface AgentCommentTask extends AgentCommentTaskInput {
  id: string;
  status: AgentCommentTaskStatus;
  adapterName: string;
  prompt: string;
  createdAt: string;
  updatedAt: string;
  error: string | null;
  queuePosition: number;
}

export interface SubmitAgentCommentTaskResult {
  task: AgentCommentTask;
}

export interface AgentCommentAdapterResult {
  status: AgentCommentTaskStatus;
  error?: string | null;
}

export interface AgentCommentAdapter {
  capability(): AgentCommentAdapterCapability;
  submit(task: AgentCommentTask): Promise<AgentCommentAdapterResult>;
}

interface AgentCommentTaskServiceOptions {
  adapter?: AgentCommentAdapter;
  now?: () => Date;
  randomId?: () => string;
}

export class AgentCommentTaskService {
  private readonly adapter: AgentCommentAdapter;
  private readonly now: () => Date;
  private readonly randomId: () => string;
  private readonly tasks = new Map<string, AgentCommentTask>();
  private readonly documentQueues = new Map<string, string[]>();

  constructor(options: AgentCommentTaskServiceOptions = {}) {
    this.adapter = options.adapter ?? new UnavailableAgentCommentAdapter();
    this.now = options.now ?? (() => new Date());
    this.randomId =
      options.randomId ?? (() => `act_${Math.random().toString(36).slice(2)}`);
  }

  getSession(input: {
    documentPath: string;
    projectPath: string;
    relativePath: string;
    originThreadId?: string | null;
  }): AgentCommentSession {
    const originThreadId = normalizeOptionalString(input.originThreadId);
    return {
      documentPath: path.resolve(input.documentPath),
      projectPath: path.resolve(input.projectPath),
      relativePath: input.relativePath,
      mode: originThreadId ? "attached" : "detached",
      originThreadId,
      adapter: this.adapter.capability(),
    };
  }

  async submit(input: AgentCommentTaskInput): Promise<AgentCommentTask> {
    const capability = this.adapter.capability();
    const now = this.now().toISOString();
    const prompt = buildAgentCommentPrompt(input);
    const documentPath = path.resolve(input.documentPath);
    const queue = this.documentQueues.get(documentPath) ?? [];
    const task: AgentCommentTask = {
      ...input,
      documentPath,
      projectPath: path.resolve(input.projectPath),
      id: this.randomId(),
      status: "accepted",
      adapterName: capability.name,
      prompt,
      createdAt: now,
      updatedAt: now,
      error: null,
      queuePosition: queue.length,
    };

    if (!capability.available) {
      task.status = "needs_attention";
      task.error = capability.reason ?? "No agent adapter is configured.";
      this.rememberTask(task);
      appendSlog("agent-comment-task.needs-attention", {
        taskId: task.id,
        commentId: task.comment.id,
        reason: task.error,
      });
      return task;
    }

    if (task.mode === "attached" && !capability.supportsAttached) {
      task.status = "needs_attention";
      task.error =
        "The configured agent adapter does not support attached mode.";
      this.rememberTask(task);
      return task;
    }

    if (task.mode === "detached" && !capability.supportsDetached) {
      task.status = "needs_attention";
      task.error =
        "The configured agent adapter does not support detached mode.";
      this.rememberTask(task);
      return task;
    }

    this.rememberTask(task);
    try {
      const result = await this.adapter.submit(task);
      this.updateTask(task.id, {
        status: result.status,
        error: result.error ?? null,
      });
    } catch (error) {
      this.updateTask(task.id, {
        status: "failed",
        error:
          error instanceof Error
            ? error.message
            : "Agent adapter failed while submitting the task.",
      });
    }

    const submittedTask = this.tasks.get(task.id);
    if (!submittedTask) {
      throw new Error("Agent comment task disappeared after submission.");
    }
    return submittedTask;
  }

  getTask(taskId: string): AgentCommentTask | null {
    return this.tasks.get(taskId) ?? null;
  }

  capability(): AgentCommentAdapterCapability {
    return this.adapter.capability();
  }

  tasksForDocument(documentPath: string): AgentCommentTask[] {
    const normalizedPath = path.resolve(documentPath);
    const taskIds = this.documentQueues.get(normalizedPath) ?? [];
    return taskIds
      .map((taskId) => this.tasks.get(taskId))
      .filter((task): task is AgentCommentTask => Boolean(task));
  }

  private rememberTask(task: AgentCommentTask): void {
    this.tasks.set(task.id, task);
    const queue = this.documentQueues.get(task.documentPath) ?? [];
    queue.push(task.id);
    this.documentQueues.set(task.documentPath, queue);
  }

  private updateTask(
    taskId: string,
    patch: Pick<AgentCommentTask, "status" | "error">,
  ): void {
    const task = this.tasks.get(taskId);
    if (!task) return;
    this.tasks.set(taskId, {
      ...task,
      ...patch,
      updatedAt: this.now().toISOString(),
    });
  }
}

export class UnavailableAgentCommentAdapter implements AgentCommentAdapter {
  capability(): AgentCommentAdapterCapability {
    return {
      available: false,
      name: "unavailable",
      reason:
        "No verified Codex App Server adapter is configured. Use the copy prompt fallback or configure a real adapter.",
      supportsAttached: false,
      supportsDetached: false,
    };
  }

  async submit(): Promise<AgentCommentAdapterResult> {
    return {
      status: "needs_attention",
      error:
        "No verified Codex App Server adapter is configured. Use the copy prompt fallback or configure a real adapter.",
    };
  }
}

export class FakeAgentCommentAdapter implements AgentCommentAdapter {
  constructor(
    private readonly options: {
      status?: AgentCommentTaskStatus;
      error?: string | null;
      supportsAttached?: boolean;
      supportsDetached?: boolean;
    } = {},
  ) {}

  capability(): AgentCommentAdapterCapability {
    return {
      available: true,
      name: "fake",
      reason: null,
      supportsAttached: this.options.supportsAttached ?? true,
      supportsDetached: this.options.supportsDetached ?? true,
    };
  }

  async submit(): Promise<AgentCommentAdapterResult> {
    return {
      status: this.options.status ?? "working",
      error: this.options.error ?? null,
    };
  }
}

export function reviewItemToAgentCommentInput(input: {
  documentPath: string;
  projectPath: string;
  relativePath: string;
  fileVersion: string;
  mode: AgentCommentSessionMode;
  originThreadId: string | null;
  item: RfmReviewItem;
}): AgentCommentTaskInput {
  return {
    documentPath: input.documentPath,
    projectPath: input.projectPath,
    relativePath: input.relativePath,
    fileVersion: input.fileVersion,
    mode: input.mode,
    originThreadId: input.originThreadId,
    comment: {
      id: input.item.id,
      text: input.item.text,
      anchorText: input.item.anchorText ?? null,
      line: input.item.line,
      column: input.item.column,
      offset: input.item.offset,
      endOffset: input.item.endOffset,
      author: input.item.author,
      createdAt: input.item.createdAt,
    },
  };
}

export function buildAgentCommentPrompt(input: AgentCommentTaskInput): string {
  const absoluteFilePath = path.resolve(input.projectPath, input.relativePath);
  const lines = [
    "A Roughdraft comment was submitted on a Markdown file.",
    "",
    `File: ${absoluteFilePath}`,
    `Project: ${input.projectPath}`,
    `Comment id: ${input.comment.id}`,
    `Mode: ${input.mode}`,
  ];

  if (input.originThreadId) {
    lines.push(`Origin thread id: ${input.originThreadId}`);
  }

  lines.push(
    `Reference: ${input.comment.anchorText ?? ""}`,
    "",
    "Comment:",
    input.comment.text,
    "",
    "Please update the Markdown file to address this comment. Remove or resolve only this handled comment and leave unrelated Roughdraft comments intact.",
  );

  return lines.join("\n");
}

function normalizeOptionalString(
  value: string | null | undefined,
): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function appendSlog(event: string, data: Record<string, unknown>): void {
  const file = process.env.THOUGHTFUL_SLOG_FILE;
  if (!file) return;

  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(
    file,
    `${JSON.stringify({
      ts: new Date().toISOString(),
      runId: process.env.THOUGHTFUL_SLOG_RUN_ID ?? "manual",
      source: "packages/server/src/agent-comment-tasks.ts",
      event,
      data,
    })}\n`,
  );
}
