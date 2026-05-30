import fs from "node:fs";
import path from "node:path";
import {
  spawn,
  spawnSync,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
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
  status?(task: AgentCommentTask): AgentCommentAdapterResult | null;
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
    const task = this.tasks.get(taskId);
    if (!task) return null;
    this.refreshTaskFromAdapter(task);
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
      .filter((task): task is AgentCommentTask => Boolean(task))
      .map((task) => {
        this.refreshTaskFromAdapter(task);
        return this.tasks.get(task.id) ?? task;
      });
  }

  private refreshTaskFromAdapter(task: AgentCommentTask): void {
    const result = this.adapter.status?.(task);
    if (!result) return;
    if (
      result.status === task.status &&
      (result.error ?? null) === task.error
    ) {
      return;
    }
    this.updateTask(task.id, {
      status: result.status,
      error: result.error ?? null,
    });
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

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params: unknown;
}

interface JsonRpcResponse {
  id?: number;
  result?: unknown;
  error?: { message?: string } | string;
  method?: string;
  params?: unknown;
}

interface CodexThreadResponse {
  thread?: {
    id?: string;
  };
}

interface CodexTurnResponse {
  turn?: {
    id?: string;
  };
}

interface CodexTurnCompletedParams {
  threadId?: string;
  turn?: {
    id?: string;
    status?: string;
    error?: { message?: string } | string | null;
  };
}

export class CodexAppServerJsonRpcClient {
  private child: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private initialized: Promise<void> | null = null;
  private stdoutBuffer = "";
  private readonly pending = new Map<
    number,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
    }
  >();
  private readonly turnCompletedHandlers = new Set<
    (params: CodexTurnCompletedParams) => void
  >();

  constructor(
    private readonly command = "codex",
    private readonly args = ["app-server", "--listen", "stdio://"],
  ) {}

  onTurnCompleted(handler: (params: CodexTurnCompletedParams) => void): void {
    this.turnCompletedHandlers.add(handler);
  }

  async initialize(): Promise<void> {
    if (!this.initialized) {
      this.initialized = this.request("initialize", {
        clientInfo: {
          name: "markdown-mode",
          version: "0.1.0",
        },
        capabilities: null,
      }).then(() => undefined);
    }

    await this.initialized;
  }

  async request(method: string, params: unknown): Promise<unknown> {
    this.ensureChild();
    const id = this.nextId;
    this.nextId += 1;

    const payload: JsonRpcRequest = {
      jsonrpc: "2.0",
      id,
      method,
      params,
    };

    const promise = new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
    this.child?.stdin.write(`${JSON.stringify(payload)}\n`);
    return promise;
  }

  private ensureChild(): void {
    if (this.child) return;

    const child = spawn(this.command, this.args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    });
    this.child = child;

    child.stdout.on("data", (chunk: Buffer) => {
      this.handleStdout(chunk.toString("utf8"));
    });
    child.stderr.on("data", (chunk: Buffer) => {
      appendSlog("codex-app-server.stderr", {
        message: chunk.toString("utf8"),
      });
    });
    child.on("error", (error) => {
      this.rejectPending(error);
    });
    child.on("exit", (code, signal) => {
      this.rejectPending(
        new Error(
          `Codex app-server exited before the agent task completed (${signal ?? code ?? "unknown"}).`,
        ),
      );
      this.child = null;
      this.initialized = null;
    });

    const shutdown = () => {
      child.kill("SIGTERM");
    };
    process.once("exit", shutdown);
  }

  private handleStdout(chunk: string): void {
    this.stdoutBuffer += chunk;
    while (true) {
      const newlineIndex = this.stdoutBuffer.indexOf("\n");
      if (newlineIndex === -1) break;

      const line = this.stdoutBuffer.slice(0, newlineIndex).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1);
      if (!line) continue;
      this.handleMessage(line);
    }
  }

  private handleMessage(line: string): void {
    let message: JsonRpcResponse;
    try {
      message = JSON.parse(line) as JsonRpcResponse;
    } catch {
      appendSlog("codex-app-server.invalid-json", { line });
      return;
    }

    if (typeof message.id === "number") {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) {
        pending.reject(
          new Error(
            typeof message.error === "string"
              ? message.error
              : (message.error.message ?? "Codex app-server request failed."),
          ),
        );
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    if (message.method === "turn/completed") {
      const params = message.params as CodexTurnCompletedParams;
      for (const handler of this.turnCompletedHandlers) {
        handler(params);
      }
    }
  }

  private rejectPending(error: Error): void {
    for (const [, pending] of this.pending) {
      pending.reject(error);
    }
    this.pending.clear();
  }
}

export class CodexAppServerAgentCommentAdapter implements AgentCommentAdapter {
  private readonly client: CodexAppServerJsonRpcClient;
  private readonly unavailableReason: string | null;
  private readonly taskStatus = new Map<string, AgentCommentAdapterResult>();
  private readonly taskByTurn = new Map<string, string>();

  constructor(
    options: {
      command?: string;
      client?: CodexAppServerJsonRpcClient;
      unavailableReason?: string | null;
    } = {},
  ) {
    this.client =
      options.client ??
      new CodexAppServerJsonRpcClient(options.command ?? "codex");
    this.unavailableReason =
      options.unavailableReason ??
      detectCodexAppServerUnavailableReason(options.command ?? "codex");
    this.client.onTurnCompleted((params) => {
      this.handleTurnCompleted(params);
    });
  }

  capability(): AgentCommentAdapterCapability {
    return {
      available: this.unavailableReason === null,
      name: "codex-app-server",
      reason: this.unavailableReason,
      supportsAttached: this.unavailableReason === null,
      supportsDetached: this.unavailableReason === null,
    };
  }

  async submit(task: AgentCommentTask): Promise<AgentCommentAdapterResult> {
    if (this.unavailableReason) {
      return { status: "needs_attention", error: this.unavailableReason };
    }

    await this.client.initialize();
    const threadId =
      task.mode === "attached" && task.originThreadId
        ? await this.forkAttachedThread(task)
        : await this.startDetachedThread(task);
    const turnId = await this.startTurn(threadId, task);
    this.taskByTurn.set(`${threadId}:${turnId}`, task.id);
    this.taskStatus.set(task.id, { status: "working", error: null });

    appendSlog("agent-comment-task.codex-started", {
      taskId: task.id,
      commentId: task.comment.id,
      threadId,
      turnId,
      mode: task.mode,
    });

    return { status: "working", error: null };
  }

  status(task: AgentCommentTask): AgentCommentAdapterResult | null {
    return this.taskStatus.get(task.id) ?? null;
  }

  private async forkAttachedThread(task: AgentCommentTask): Promise<string> {
    const result = (await this.client.request("thread/fork", {
      threadId: task.originThreadId,
      cwd: task.projectPath,
      approvalPolicy: "never",
      sandbox: "workspace-write",
      ephemeral: false,
      excludeTurns: true,
    })) as CodexThreadResponse;

    const threadId = result.thread?.id;
    if (!threadId) {
      throw new Error("Codex app-server did not return a forked thread id.");
    }
    return threadId;
  }

  private async startDetachedThread(task: AgentCommentTask): Promise<string> {
    const result = (await this.client.request("thread/start", {
      cwd: task.projectPath,
      approvalPolicy: "never",
      sandbox: "workspace-write",
      serviceName: "Markdown Mode",
      ephemeral: false,
    })) as CodexThreadResponse;

    const threadId = result.thread?.id;
    if (!threadId) {
      throw new Error("Codex app-server did not return a thread id.");
    }
    return threadId;
  }

  private async startTurn(
    threadId: string,
    task: AgentCommentTask,
  ): Promise<string> {
    const result = (await this.client.request("turn/start", {
      threadId,
      cwd: task.projectPath,
      approvalPolicy: "never",
      sandboxPolicy: {
        type: "workspaceWrite",
        writableRoots: [task.projectPath],
        networkAccess: false,
        excludeTmpdirEnvVar: false,
        excludeSlashTmp: false,
      },
      input: [
        {
          type: "text",
          text: task.prompt,
          text_elements: [],
        },
      ],
    })) as CodexTurnResponse;

    const turnId = result.turn?.id;
    if (!turnId) {
      throw new Error("Codex app-server did not return a turn id.");
    }
    return turnId;
  }

  private handleTurnCompleted(params: CodexTurnCompletedParams): void {
    const threadId = params.threadId;
    const turnId = params.turn?.id;
    if (!threadId || !turnId) return;

    const taskId = this.taskByTurn.get(`${threadId}:${turnId}`);
    if (!taskId) return;

    const failed = params.turn?.status === "failed";
    const rawError = params.turn?.error;
    const error =
      typeof rawError === "string"
        ? rawError
        : (rawError?.message ?? (failed ? "Codex turn failed." : null));

    this.taskStatus.set(taskId, {
      status: failed ? "failed" : "applied",
      error,
    });
  }
}

function detectCodexAppServerUnavailableReason(command: string): string | null {
  const result = spawnSync(command, ["app-server", "--help"], {
    stdio: "ignore",
  });

  if (result.error) {
    return result.error.message;
  }

  if (result.status !== 0) {
    return "The `codex app-server` command is not available.";
  }

  return null;
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
    "A Markdown Mode comment was submitted on a Markdown file.",
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
