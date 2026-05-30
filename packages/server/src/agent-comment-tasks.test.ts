import { describe, expect, it, vi } from "vitest";
import {
  AgentCommentTaskService,
  buildAgentCommentPrompt,
  CodexAppServerAgentCommentAdapter,
  type CodexAppServerJsonRpcClient,
  FakeAgentCommentAdapter,
  reviewItemToAgentCommentInput,
} from "./agent-comment-tasks";

const fixedDate = new Date("2026-05-24T12:00:00.000Z");

function commentInput(overrides = {}) {
  return {
    documentPath: "/tmp/project/draft.md",
    projectPath: "/tmp/project",
    relativePath: "draft.md",
    fileVersion: "version-1",
    mode: "detached" as const,
    originThreadId: null,
    comment: {
      id: "c1",
      text: "Add concrete evidence.",
      anchorText: "this claim",
      line: 3,
      column: 10,
      offset: 42,
      endOffset: 52,
      author: "Nora",
      createdAt: "2026-05-24T11:59:00.000Z",
    },
    ...overrides,
  };
}

describe("AgentCommentTaskService", () => {
  it("reports detached and attached sessions from transient origin metadata", () => {
    const service = new AgentCommentTaskService({
      adapter: new FakeAgentCommentAdapter(),
    });

    const detached = service.getSession({
      documentPath: "/tmp/project/draft.md",
      projectPath: "/tmp/project",
      relativePath: "draft.md",
    });
    const attached = service.getSession({
      documentPath: "/tmp/project/draft.md",
      projectPath: "/tmp/project",
      relativePath: "draft.md",
      originThreadId: "thread-1",
    });

    expect(detached).toMatchObject({
      mode: "detached",
      originThreadId: null,
      adapter: { available: true, name: "fake" },
    });
    expect(attached).toMatchObject({
      mode: "attached",
      originThreadId: "thread-1",
      adapter: { available: true, name: "fake" },
    });
  });

  it("queues one saved comment task per file through the fake adapter", async () => {
    const service = new AgentCommentTaskService({
      adapter: new FakeAgentCommentAdapter({ status: "working" }),
      now: () => fixedDate,
      randomId: () => "act_1",
    });

    const task = await service.submit(commentInput());

    expect(task).toMatchObject({
      id: "act_1",
      status: "working",
      adapterName: "fake",
      queuePosition: 0,
      comment: {
        id: "c1",
        text: "Add concrete evidence.",
        anchorText: "this claim",
      },
    });
    expect(service.getTask("act_1")).toEqual(task);
    expect(service.tasksForDocument("/tmp/project/draft.md")).toEqual([task]);
  });

  it("marks unsupported attached tasks as needing attention without deleting the comment payload", async () => {
    const service = new AgentCommentTaskService({
      adapter: new FakeAgentCommentAdapter({ supportsAttached: false }),
      now: () => fixedDate,
      randomId: () => "act_1",
    });

    const task = await service.submit(
      commentInput({
        mode: "attached",
        originThreadId: "thread-1",
      }),
    );

    expect(task.status).toBe("needs_attention");
    expect(task.error).toContain("does not support attached mode");
    expect(task.comment).toMatchObject({
      id: "c1",
      text: "Add concrete evidence.",
    });
  });

  it("refreshes a working task from adapter status notifications", async () => {
    const adapter = new FakeAgentCommentAdapter({ status: "working" });
    adapter.status = () => ({ status: "applied", error: null });
    const service = new AgentCommentTaskService({
      adapter,
      now: () => fixedDate,
      randomId: () => "act_1",
    });

    await service.submit(commentInput());

    expect(service.getTask("act_1")).toMatchObject({
      status: "applied",
      error: null,
    });
  });
});

describe("CodexAppServerAgentCommentAdapter", () => {
  it("forks the origin thread and starts a turn with the comment prompt", async () => {
    const requests: Array<{ method: string; params: unknown }> = [];
    let turnCompleted:
      | ((params: {
          threadId?: string;
          turn?: { id?: string; status?: string };
        }) => void)
      | null = null;
    const client = {
      initialize: vi.fn().mockResolvedValue(undefined),
      onTurnCompleted: vi.fn((handler) => {
        turnCompleted = handler;
      }),
      request: vi.fn(async (method: string, params: unknown) => {
        requests.push({ method, params });
        if (method === "thread/fork") {
          return { thread: { id: "forked-thread" } };
        }
        if (method === "turn/start") {
          return { turn: { id: "turn-1" } };
        }
        throw new Error(`Unexpected method: ${method}`);
      }),
    } as unknown as CodexAppServerJsonRpcClient;
    const adapter = new CodexAppServerAgentCommentAdapter({
      client,
      unavailableReason: null,
    });
    const task = {
      ...commentInput({ mode: "attached", originThreadId: "thread-1" }),
      id: "act_1",
      status: "accepted" as const,
      adapterName: "codex-app-server",
      prompt: "Address this comment.",
      createdAt: fixedDate.toISOString(),
      updatedAt: fixedDate.toISOString(),
      error: null,
      queuePosition: 0,
    };

    const result = await adapter.submit(task);

    expect(result).toEqual({ status: "working", error: null });
    expect(requests).toMatchObject([
      {
        method: "thread/fork",
        params: {
          threadId: "thread-1",
          cwd: "/tmp/project",
          approvalPolicy: "never",
          sandbox: "workspace-write",
          excludeTurns: true,
        },
      },
      {
        method: "turn/start",
        params: {
          threadId: "forked-thread",
          cwd: "/tmp/project",
          approvalPolicy: "never",
          input: [
            {
              type: "text",
              text: "Address this comment.",
              text_elements: [],
            },
          ],
        },
      },
    ]);
    expect(adapter.status(task)).toEqual({ status: "working", error: null });

    turnCompleted?.({
      threadId: "forked-thread",
      turn: { id: "turn-1", status: "completed" },
    });

    expect(adapter.status(task)).toEqual({ status: "applied", error: null });
  });
});

describe("agent comment payload helpers", () => {
  it("extracts a stable task payload from a Roughdraft comment item", () => {
    const input = reviewItemToAgentCommentInput({
      documentPath: "/tmp/project/draft.md",
      projectPath: "/tmp/project",
      relativePath: "draft.md",
      fileVersion: "version-1",
      mode: "attached",
      originThreadId: "thread-1",
      item: {
        kind: "comment",
        id: "c1",
        text: "Add concrete evidence.",
        anchorText: "this claim",
        line: 3,
        column: 10,
        offset: 42,
        endOffset: 52,
        author: "Nora",
        createdAt: "2026-05-24T11:59:00.000Z",
        parentId: null,
      },
    });

    expect(input).toMatchObject({
      mode: "attached",
      originThreadId: "thread-1",
      comment: {
        id: "c1",
        text: "Add concrete evidence.",
        anchorText: "this claim",
      },
    });
  });

  it("keeps thread metadata in the prompt and not in Markdown content", () => {
    const markdown =
      'Please revisit {==this claim==}{>>Add concrete evidence.<<}{id="c1" by="Nora" at="2026-05-24T11:59:00.000Z"}.';
    const prompt = buildAgentCommentPrompt(
      commentInput({ mode: "attached", originThreadId: "thread-1" }),
    );

    expect(prompt).toContain("Origin thread id: thread-1");
    expect(prompt).toContain("Comment id: c1");
    expect(markdown).not.toContain("thread-1");
  });
});
