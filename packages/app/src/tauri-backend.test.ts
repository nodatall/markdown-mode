import { afterEach, describe, expect, it, vi } from "vitest";
import { TauriBackend, type TauriMarkdownFile } from "./tauri-backend";

function markdownFile(
  overrides: Partial<TauriMarkdownFile> = {},
): TauriMarkdownFile {
  return {
    path: "/tmp/project/draft.md",
    fileName: "draft.md",
    baseDir: "/tmp/project",
    contents: "# Draft\n",
    modified: 123,
    ...overrides,
  };
}

describe("TauriBackend agent comment sessions", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("returns a detached unavailable session when the file was not opened from the CLI", async () => {
    const backend = new TauriBackend();
    backend.configureProjectFromFile(markdownFile());

    const session = await backend.getAgentCommentSession("draft.md");

    expect(session).toMatchObject({
      documentPath: "/tmp/project/draft.md",
      projectPath: "/tmp/project",
      relativePath: "draft.md",
      mode: "detached",
      originThreadId: null,
      adapter: {
        available: false,
        name: "unavailable",
      },
    });
    expect(session.adapter.reason).toContain("No Codex thread session");
  });

  it("passes origin thread metadata through server-backed native sessions", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          documentPath: "/tmp/project/draft.md",
          projectPath: "/tmp/project",
          relativePath: "draft.md",
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
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const backend = new TauriBackend();
    backend.configureProjectFromFile(
      markdownFile({
        serverUrl: "http://localhost:7373",
        originThreadId: "thread-1",
      }),
    );

    const session = await backend.getAgentCommentSession("draft.md");

    expect(session.mode).toBe("attached");
    expect(session.originThreadId).toBe("thread-1");
    const calledUrl = new URL(fetchMock.mock.calls[0]?.[0] as string);
    expect(calledUrl.origin).toBe("http://localhost:7373");
    expect(calledUrl.pathname).toBe("/api/agent-comment-session");
    expect(calledUrl.searchParams.get("path")).toBe("draft.md");
    expect(calledUrl.searchParams.get("projectPath")).toBe("/tmp/project");
    expect(calledUrl.searchParams.get("originThreadId")).toBe("thread-1");
  });

  it("submits native comment tasks through the attached server session", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ task: { id: "act_1" } }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const backend = new TauriBackend();
    backend.configureProjectFromFile(
      markdownFile({
        serverUrl: "http://localhost:7373",
        originThreadId: "thread-1",
      }),
    );

    await backend.submitAgentCommentTask("draft.md", { commentId: "c1" });

    const [url, init] = fetchMock.mock.calls[0] ?? [];
    const calledUrl = new URL(url as string);
    expect(calledUrl.pathname).toBe("/api/agent-comment-tasks");
    expect(init).toMatchObject({ method: "POST" });
    expect(JSON.parse(String(init?.body))).toMatchObject({
      projectPath: "/tmp/project",
      path: "draft.md",
      originThreadId: "thread-1",
      commentId: "c1",
    });
  });

  it("reads native comment task status through the attached server session", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ task: { id: "act_1", status: "applied" } }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const backend = new TauriBackend();
    backend.configureProjectFromFile(
      markdownFile({
        serverUrl: "http://localhost:7373",
        originThreadId: "thread-1",
      }),
    );

    await backend.getAgentCommentTask("act_1");

    const calledUrl = new URL(fetchMock.mock.calls[0]?.[0] as string);
    expect(calledUrl.origin).toBe("http://localhost:7373");
    expect(calledUrl.pathname).toBe("/api/agent-comment-tasks/act_1");
    expect(calledUrl.searchParams.get("projectPath")).toBe("/tmp/project");
    expect(calledUrl.searchParams.get("originThreadId")).toBe("thread-1");
  });
});
