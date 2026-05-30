import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServer as createHttpServer, type Server } from "node:http";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "./index";
import {
  createCliDependencies,
  ensureServerRunning,
  getNativeOpenSessionsFilePath,
  getServerStateFilePath,
  runCli,
} from "./cli";
import { ROUGHDRAFT_DEFAULT_PORT } from "./network";

interface StartedServer {
  close: () => Promise<void>;
}

async function listenOnLoopbackServers(
  port: number,
  app: ReturnType<typeof createApp>["app"],
): Promise<StartedServer> {
  const servers: Server[] = [];

  for (const host of ["127.0.0.1", "::1"]) {
    const server = createHttpServer(app);
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", (error: NodeJS.ErrnoException) => {
          if (error.code === "EAFNOSUPPORT" || error.code === "EADDRNOTAVAIL") {
            resolve();
            return;
          }

          reject(error);
        });

        server.listen(port, host, () => resolve());
      });
      if (server.listening) {
        servers.push(server);
      }
    } catch (error) {
      await new Promise((resolve) => server.close(() => resolve(undefined)));
      throw error;
    }
  }

  return {
    close: async () => {
      await Promise.all(
        servers.map(
          (server) =>
            new Promise<void>((resolve, reject) => {
              server.closeAllConnections?.();
              server.close((error) => {
                if (error) {
                  reject(error);
                  return;
                }
                resolve();
              });
            }),
        ),
      );
    },
  };
}

describe("cli", () => {
  let tempDir: string;
  let stateDir: string;
  let projectDir: string;
  let devFrontendStateFile: string;
  let previousNativeSessionsFile: string | undefined;
  let nextPid: number;
  let runningPids: Set<number>;
  let serverByPid: Map<number, StartedServer>;
  let portByPid: Map<number, number>;
  const serverRoot = path.resolve(
    fileURLToPath(new URL("../../..", import.meta.url)),
  );

  beforeEach(() => {
    previousNativeSessionsFile =
      process.env.ROUGHDRAFT_NATIVE_OPEN_SESSIONS_FILE;
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "markdownmode-cli-"));
    stateDir = path.join(tempDir, "state");
    projectDir = path.join(tempDir, "project");
    devFrontendStateFile = path.join(tempDir, "dev-frontend.json");
    process.env.ROUGHDRAFT_NATIVE_OPEN_SESSIONS_FILE = path.join(
      stateDir,
      "native-open-sessions.json",
    );
    fs.mkdirSync(projectDir, { recursive: true });
    nextPid = 1000;
    runningPids = new Set<number>();
    serverByPid = new Map<number, StartedServer>();
    portByPid = new Map<number, number>();
  });

  function parseOnlyJsonLog<T>(logs: string[]): T {
    expect(logs).toHaveLength(1);
    return JSON.parse(logs[0] ?? "{}") as T;
  }

  async function noUpdateStatus() {
    return {
      packageName: "markdownmode",
      currentVersion: "0.1.0",
      latestVersion: "0.1.0",
      updateAvailable: false,
      updateCommand: "npm i -g markdownmode@latest",
    };
  }

  afterEach(async () => {
    await Promise.all(
      Array.from(serverByPid.values(), (server) => server.close()),
    );
    if (previousNativeSessionsFile === undefined) {
      delete process.env.ROUGHDRAFT_NATIVE_OPEN_SESSIONS_FILE;
    } else {
      process.env.ROUGHDRAFT_NATIVE_OPEN_SESSIONS_FILE =
        previousNativeSessionsFile;
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function createTestDependencies() {
    const logs: string[] = [];
    const errors: string[] = [];
    let lastOpenedDesktopPath: string | null = null;
    let spawnCount = 0;

    const deps = createCliDependencies({
      env: {
        ...process.env,
        CODEX_THREAD_ID: "",
        ROUGHDRAFT_STATE_DIR: stateDir,
        ROUGHDRAFT_DEV_FRONTEND_STATE_FILE: devFrontendStateFile,
      },
      cwd: projectDir,
      fetchImpl: async (input, init) => {
        const url =
          input instanceof URL
            ? input
            : new URL(
                typeof input === "string" ? input : input.url,
                "http://localhost",
              );
        const port = Number.parseInt(url.port || "80", 10);
        const hasActiveServer = Array.from(portByPid.entries()).some(
          ([pid, activePort]) => runningPids.has(pid) && activePort === port,
        );

        if (url.pathname === "/api/status" && !hasActiveServer) {
          throw new Error("connect ECONNREFUSED");
        }

        return fetch(input, init);
      },
      log: (message) => logs.push(message),
      error: (message) => errors.push(message),
      openDesktopApp: (filePath) => {
        lastOpenedDesktopPath = filePath;
        return true;
      },
      resolveUpdateStatus: noUpdateStatus,
      spawnServerProcess: async ({ port, projectDir: nextProjectDir }) => {
        spawnCount += 1;
        const pid = nextPid;
        nextPid += 1;
        const { app } = createApp({
          port,
          projectDir: nextProjectDir,
          serverRoot,
          staticDirPath: nextProjectDir,
        });
        const started = await listenOnLoopbackServers(port, app);
        runningPids.add(pid);
        serverByPid.set(pid, started);
        portByPid.set(pid, port);
        return { pid };
      },
      isProcessRunning: (pid) => runningPids.has(pid),
      stopProcess: async (pid) => {
        const server = serverByPid.get(pid);
        if (server) {
          await server.close();
        }
        serverByPid.delete(pid);
        portByPid.delete(pid);
        runningPids.delete(pid);
      },
    });

    return {
      deps,
      logs,
      errors,
      getLastOpenedDesktopPath: () => lastOpenedDesktopPath,
      getSpawnCount: () => spawnCount,
    };
  }

  it("writes server state and reuses a running background server", async () => {
    const test = createTestDependencies();

    const first = await ensureServerRunning(test.deps, { projectDir });
    const second = await ensureServerRunning(test.deps, { projectDir });

    expect(first.reused).toBe(false);
    expect(second.reused).toBe(true);
    expect(first.server.url).toBe(`http://localhost:${first.server.port}`);
    expect(test.getSpawnCount()).toBe(1);

    const stateFilePath = getServerStateFilePath(test.deps.env);
    const persisted = JSON.parse(fs.readFileSync(stateFilePath, "utf8")) as {
      port: number;
      pid: number;
      startedAt: string;
      url: string;
    };

    expect(persisted).toMatchObject({
      port: first.server.port,
      pid: first.server.pid,
      url: first.server.url,
    });
    expect(typeof persisted.startedAt).toBe("string");
  });

  it("auto-starts from open and opens the requested markdown file in the native app", async () => {
    const test = createTestDependencies();
    const documentPath = path.join(projectDir, "draft.md");
    fs.writeFileSync(documentPath, "# Draft\n");

    const exitCode = await runCli(
      ["open", documentPath, "--no-watch"],
      test.deps,
    );
    const persisted = JSON.parse(
      fs.readFileSync(getServerStateFilePath(test.deps.env), "utf8"),
    ) as { port: number };

    expect(exitCode).toBe(0);
    expect(test.getSpawnCount()).toBe(1);
    expect(test.getLastOpenedDesktopPath()).toBe(documentPath);
    const sessions = JSON.parse(
      fs.readFileSync(getNativeOpenSessionsFilePath(test.deps.env), "utf8"),
    ) as Array<{ filePath: string; serverUrl: string; relativePath: string }>;
    expect(sessions.at(-1)).toMatchObject({
      filePath: documentPath,
      serverUrl: `http://localhost:${persisted.port}`,
      relativePath: "draft.md",
    });
    expect(fs.existsSync(getServerStateFilePath(test.deps.env))).toBeTruthy();
  });

  it("prints an update notice after a successful human-readable command", async () => {
    const test = createTestDependencies();
    const documentPath = path.join(projectDir, "draft.md");
    fs.writeFileSync(documentPath, "# Draft\n");

    const exitCode = await runCli(["open", documentPath, "--no-watch"], {
      ...test.deps,
      resolveUpdateStatus: async () => ({
        packageName: "markdownmode",
        currentVersion: "0.1.1",
        latestVersion: "0.1.3",
        updateAvailable: true,
        updateCommand: "npm i -g markdownmode@latest",
      }),
    });

    expect(exitCode).toBe(0);
    expect(test.logs.at(-1)).toBe(
      "Markdown Mode update available: 0.1.1 -> 0.1.3. Run `npm i -g markdownmode@latest` to update.",
    );
  });

  it("does not add an update notice to JSON command output", async () => {
    const test = createTestDependencies();
    const documentPath = path.join(projectDir, "draft.md");
    fs.writeFileSync(documentPath, "# Draft\n");

    const exitCode = await runCli(
      ["open", documentPath, "--no-watch", "--json"],
      {
        ...test.deps,
        resolveUpdateStatus: async () => ({
          packageName: "markdownmode",
          currentVersion: "0.1.1",
          latestVersion: "0.1.3",
          updateAvailable: true,
          updateCommand: "npm i -g markdownmode@latest",
        }),
      },
    );
    const payload = parseOnlyJsonLog<{ opened: boolean }>(test.logs);

    expect(exitCode).toBe(0);
    expect(payload.opened).toBe(true);
  });

  it("keeps the original command result when the update check fails", async () => {
    const test = createTestDependencies();
    const documentPath = path.join(projectDir, "draft.md");
    fs.writeFileSync(documentPath, "# Draft\n");

    const exitCode = await runCli(["open", documentPath, "--no-watch"], {
      ...test.deps,
      resolveUpdateStatus: async () => {
        throw new Error("registry unavailable");
      },
    });

    expect(exitCode).toBe(0);
    expect(test.logs).not.toContain("registry unavailable");
  });

  it("does not post browser open requests for native app opens", async () => {
    const documentPath = path.join(projectDir, "draft.md");
    fs.writeFileSync(documentPath, "# Draft\n");

    let postedOpenRequest: { path?: string; url?: string } | null = null;
    let openedDesktopPath: string | null = null;
    const deps = createCliDependencies({
      env: {
        ...process.env,
        CODEX_THREAD_ID: "",
        ROUGHDRAFT_STATE_DIR: stateDir,
      },
      cwd: projectDir,
      fetchImpl: async (input, init) => {
        const url =
          input instanceof URL
            ? input
            : new URL(
                typeof input === "string" ? input : input.url,
                "http://localhost",
              );

        if (
          url.pathname === "/api/status" &&
          url.port === String(ROUGHDRAFT_DEFAULT_PORT)
        ) {
          return new Response(
            JSON.stringify({
              backend: "local-files",
              port: ROUGHDRAFT_DEFAULT_PORT,
              projectDir,
              serverRoot,
            }),
            {
              status: 200,
              headers: { "Content-Type": "application/json" },
            },
          );
        }

        if (url.pathname === "/api/open-request" && init?.method === "POST") {
          postedOpenRequest = JSON.parse(String(init.body));
          return new Response(JSON.stringify({ delivered: true }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }

        throw new Error("connect ECONNREFUSED");
      },
      isProcessRunning: () => false,
      stopProcess: async () => {},
      spawnServerProcess: async () => {
        throw new Error("should not spawn");
      },
      openDesktopApp: (filePath) => {
        openedDesktopPath = filePath;
        return true;
      },
      log: () => {},
      error: () => {},
    });

    const exitCode = await runCli(["open", documentPath, "--no-watch"], deps);

    expect(exitCode).toBe(0);
    expect(postedOpenRequest).toBeNull();
    expect(openedDesktopPath).toBe(documentPath);
  });

  it("opens the native Markdown Mode app after starting the server session", async () => {
    const test = createTestDependencies();
    const documentPath = path.join(projectDir, "draft.md");
    fs.writeFileSync(documentPath, "# Draft\n");
    let openedDesktopPath: string | null = null;

    const exitCode = await runCli(["open", documentPath], {
      ...test.deps,
      openDesktopApp: (filePath) => {
        openedDesktopPath = filePath;
        return true;
      },
    });

    expect(exitCode).toBe(0);
    expect(openedDesktopPath).toBe(documentPath);
    expect(test.getSpawnCount()).toBe(1);
    expect(test.logs).toContain(`Opened Markdown Mode app: ${documentPath}`);
  });

  it("does not fall back to a browser when the native app is unavailable", async () => {
    const test = createTestDependencies();
    const documentPath = path.join(projectDir, "draft.md");
    fs.writeFileSync(documentPath, "# Draft\n");

    const exitCode = await runCli(["open", documentPath], {
      ...test.deps,
      openDesktopApp: () => false,
    });

    expect(exitCode).toBe(1);
    expect(test.getSpawnCount()).toBe(1);
    expect(test.errors.join("\n")).toContain(
      "Could not open Markdown Mode.app",
    );
  });

  it("rejects open --print-url because web UI mode is removed", async () => {
    const test = createTestDependencies();
    const documentPath = path.join(projectDir, "draft.md");
    fs.writeFileSync(documentPath, "# Draft\n");

    const exitCode = await runCli(
      ["open", documentPath, "--print-url"],
      test.deps,
    );
    expect(exitCode).toBe(2);
    expect(test.errors.join("\n")).toContain(
      "URL browser mode has been removed",
    );
    expect(test.getLastOpenedDesktopPath()).toBeNull();
  });

  it("adds explicit origin thread metadata to the native open session", async () => {
    const test = createTestDependencies();
    const documentPath = path.join(projectDir, "draft.md");
    fs.writeFileSync(documentPath, "# Draft\n");

    const exitCode = await runCli(
      ["open", documentPath, "--origin-thread-id", "thread-1"],
      test.deps,
    );
    const sessions = JSON.parse(
      fs.readFileSync(getNativeOpenSessionsFilePath(test.deps.env), "utf8"),
    ) as Array<{ filePath: string; originThreadId: string | null }>;

    expect(exitCode).toBe(0);
    expect(sessions.at(-1)).toMatchObject({
      filePath: documentPath,
      originThreadId: "thread-1",
    });
  });

  it("uses CODEX_THREAD_ID for attached opens unless detached is requested", async () => {
    const test = createTestDependencies();
    const documentPath = path.join(projectDir, "draft.md");
    const detachedDocumentPath = path.join(projectDir, "detached.md");
    fs.writeFileSync(documentPath, "# Draft\n");
    fs.writeFileSync(detachedDocumentPath, "# Detached\n");
    const deps = {
      ...test.deps,
      env: {
        ...test.deps.env,
        CODEX_THREAD_ID: "thread-from-env",
      },
    };

    const attachedExitCode = await runCli(["open", documentPath], deps);
    const detachedExitCode = await runCli(
      ["open", detachedDocumentPath, "--detached"],
      deps,
    );
    const sessions = JSON.parse(
      fs.readFileSync(getNativeOpenSessionsFilePath(test.deps.env), "utf8"),
    ) as Array<{ originThreadId: string | null }>;

    expect(attachedExitCode).toBe(0);
    expect(detachedExitCode).toBe(0);
    expect(
      sessions.find((session) => session.filePath === documentPath)
        ?.originThreadId,
    ).toBe("thread-from-env");
    expect(
      sessions.find((session) => session.filePath === detachedDocumentPath)
        ?.originThreadId,
    ).toBeNull();
  });

  it("emits JSON from default open --json without waiting", async () => {
    const test = createTestDependencies();
    const documentPath = path.join(projectDir, "draft.md");
    fs.writeFileSync(documentPath, "# Draft\n");

    const exitCode = await runCli(["open", documentPath, "--json"], test.deps);
    const persisted = JSON.parse(
      fs.readFileSync(getServerStateFilePath(test.deps.env), "utf8"),
    ) as { port: number };
    const payload = parseOnlyJsonLog<{
      opened: boolean;
      serverUrl: string;
      path: string;
      projectPath: string;
      relativePath: string;
      openMode: string;
      originThreadId: string | null;
      nativeSessionId: string;
    }>(test.logs);

    expect(exitCode).toBe(0);
    expect(payload).toMatchObject({
      opened: true,
      serverUrl: `http://localhost:${persisted.port}`,
      path: documentPath,
      projectPath: projectDir,
      relativePath: "draft.md",
      originThreadId: null,
      openMode: "desktop-app",
    });
    expect(typeof payload.nativeSessionId).toBe("string");
  });

  it("prefers the live dev frontend URL when it matches this checkout", async () => {
    const documentPath = path.join(projectDir, "draft.md");
    fs.writeFileSync(documentPath, "# Draft\n");
    fs.writeFileSync(
      devFrontendStateFile,
      `${JSON.stringify(
        {
          apiPort: 3000,
          appPort: 5173,
          mode: "full-dev",
          repoRoot: serverRoot,
          startedAt: new Date().toISOString(),
          url: "http://localhost:5173",
        },
        null,
        2,
      )}\n`,
    );

    let openedDesktopPath: string | null = null;
    let spawnCount = 0;

    const deps = createCliDependencies({
      env: {
        ...process.env,
        CODEX_THREAD_ID: "",
        ROUGHDRAFT_STATE_DIR: stateDir,
        ROUGHDRAFT_DEV_FRONTEND_STATE_FILE: devFrontendStateFile,
      },
      cwd: projectDir,
      fetchImpl: async (input, init) => {
        const url =
          input instanceof URL
            ? input
            : new URL(
                typeof input === "string" ? input : input.url,
                "http://localhost",
              );

        if (url.pathname === "/api/status" && url.port === "5173") {
          return new Response(
            JSON.stringify({
              backend: "local-files",
              projectDir,
              serverRoot,
            }),
            {
              status: 200,
              headers: { "Content-Type": "application/json" },
            },
          );
        }

        return fetch(input, init);
      },
      spawnServerProcess: async () => {
        spawnCount += 1;
        throw new Error("should not spawn");
      },
      isProcessRunning: (pid) => runningPids.has(pid),
      stopProcess: async (pid) => {
        const server = serverByPid.get(pid);
        if (server) {
          await server.close();
        }
        serverByPid.delete(pid);
        portByPid.delete(pid);
        runningPids.delete(pid);
      },
      openDesktopApp: (filePath) => {
        openedDesktopPath = filePath;
        return true;
      },
      log: () => {},
      error: () => {},
    });

    const exitCode = await runCli(["open", documentPath, "--no-watch"], deps);

    expect(exitCode).toBe(0);
    expect(spawnCount).toBe(0);
    expect(openedDesktopPath).toBe(documentPath);
    const sessions = JSON.parse(
      fs.readFileSync(getNativeOpenSessionsFilePath(deps.env), "utf8"),
    ) as Array<{ filePath: string; serverUrl: string }>;
    expect(sessions.at(-1)).toMatchObject({
      filePath: documentPath,
      serverUrl: "http://localhost:3000",
    });
  });

  it("rejects open --watch instead of launching a web review flow", async () => {
    const documentPath = path.join(projectDir, "draft.md");
    fs.writeFileSync(documentPath, "# Draft\n");
    fs.writeFileSync(
      devFrontendStateFile,
      `${JSON.stringify(
        {
          apiPort: 3000,
          appPort: 5173,
          mode: "full-dev",
          repoRoot: serverRoot,
          startedAt: new Date().toISOString(),
          url: "http://localhost:5173",
        },
        null,
        2,
      )}\n`,
    );

    let spawnCount = 0;
    const errors: string[] = [];

    const deps = createCliDependencies({
      env: {
        ...process.env,
        CODEX_THREAD_ID: "",
        ROUGHDRAFT_STATE_DIR: stateDir,
        ROUGHDRAFT_DEV_FRONTEND_STATE_FILE: devFrontendStateFile,
      },
      cwd: projectDir,
      fetchImpl: async (input, _init) => {
        const url =
          input instanceof URL
            ? input
            : new URL(
                typeof input === "string" ? input : input.url,
                "http://localhost",
              );

        if (url.pathname === "/api/status" && url.port === "5173") {
          return new Response(
            JSON.stringify({
              backend: "local-files",
              port: 3000,
              projectDir,
              serverRoot,
            }),
            {
              status: 200,
              headers: { "Content-Type": "application/json" },
            },
          );
        }

        throw new Error(`Unexpected request: ${url.toString()}`);
      },
      spawnServerProcess: async () => {
        spawnCount += 1;
        throw new Error("should not spawn");
      },
      isProcessRunning: () => false,
      stopProcess: async () => {},
      openDesktopApp: () => true,
      log: () => {},
      error: (message) => errors.push(message),
      resolveUpdateStatus: noUpdateStatus,
    });

    const exitCode = await runCli(
      ["open", documentPath, "--watch", "--json", "--batch-window", "0"],
      deps,
    );

    expect(exitCode).toBe(2);
    expect(spawnCount).toBe(0);
    expect(errors.join("\n")).toContain(
      "blocking review wait flow is no longer part of `markdownmode open`",
    );
  });

  it("falls back to the api server URL when the dev frontend hint is stale", async () => {
    const documentPath = path.join(projectDir, "draft.md");
    fs.writeFileSync(documentPath, "# Draft\n");
    fs.writeFileSync(
      devFrontendStateFile,
      `${JSON.stringify(
        {
          apiPort: 3000,
          appPort: 5173,
          mode: "full-dev",
          repoRoot: serverRoot,
          startedAt: new Date().toISOString(),
          url: "http://localhost:5173",
        },
        null,
        2,
      )}\n`,
    );

    const test = createTestDependencies();
    const exitCode = await runCli(
      ["open", documentPath, "--no-watch"],
      test.deps,
    );
    const persisted = JSON.parse(
      fs.readFileSync(getServerStateFilePath(test.deps.env), "utf8"),
    ) as { port: number };

    expect(exitCode).toBe(0);
    expect(test.getSpawnCount()).toBe(1);
    expect(test.getLastOpenedDesktopPath()).toBe(documentPath);
    const sessions = JSON.parse(
      fs.readFileSync(getNativeOpenSessionsFilePath(test.deps.env), "utf8"),
    ) as Array<{ filePath: string; serverUrl: string }>;
    expect(sessions.at(-1)).toMatchObject({
      filePath: documentPath,
      serverUrl: `http://localhost:${persisted.port}`,
    });
  });

  it("uses the preview-web frontend URL when that workflow is active", async () => {
    const documentPath = path.join(projectDir, "draft.md");
    fs.writeFileSync(documentPath, "# Draft\n");
    fs.writeFileSync(
      devFrontendStateFile,
      `${JSON.stringify(
        {
          apiPort: null,
          appPort: 5174,
          mode: "preview-web",
          repoRoot: serverRoot,
          startedAt: new Date().toISOString(),
          url: "http://localhost:5174",
        },
        null,
        2,
      )}\n`,
    );

    let openedDesktopPath: string | null = null;
    let spawnCount = 0;

    const deps = createCliDependencies({
      env: {
        ...process.env,
        CODEX_THREAD_ID: "",
        ROUGHDRAFT_STATE_DIR: stateDir,
        ROUGHDRAFT_DEV_FRONTEND_STATE_FILE: devFrontendStateFile,
      },
      cwd: projectDir,
      fetchImpl: async (input) => {
        const url =
          input instanceof URL
            ? input
            : new URL(
                typeof input === "string" ? input : input.url,
                "http://localhost",
              );

        if (url.href === "http://localhost:5174/") {
          return new Response("<!doctype html><html></html>", {
            status: 200,
            headers: { "Content-Type": "text/html" },
          });
        }

        throw new Error("connect ECONNREFUSED");
      },
      spawnServerProcess: async () => {
        spawnCount += 1;
        throw new Error("should not spawn");
      },
      isProcessRunning: () => false,
      stopProcess: async () => {},
      openDesktopApp: (filePath) => {
        openedDesktopPath = filePath;
        return true;
      },
      log: () => {},
      error: () => {},
    });

    const exitCode = await runCli(["open", documentPath, "--no-watch"], deps);

    expect(exitCode).toBe(0);
    expect(spawnCount).toBe(0);
    expect(openedDesktopPath).toBe(documentPath);
    const sessions = JSON.parse(
      fs.readFileSync(getNativeOpenSessionsFilePath(deps.env), "utf8"),
    ) as Array<{ filePath: string; serverUrl: string }>;
    expect(sessions.at(-1)).toMatchObject({
      filePath: documentPath,
      serverUrl: "http://localhost:5174/",
    });
  });

  it("rejects missing markdown files before opening", async () => {
    const test = createTestDependencies();
    const missingPath = path.join(projectDir, "missing.md");

    const exitCode = await runCli(["open", missingPath], test.deps);

    expect(exitCode).toBe(1);
    expect(test.getSpawnCount()).toBe(0);
    expect(test.errors).toContain(`Path not found: ${missingPath}`);
  });

  it("stops the running server and removes persisted state", async () => {
    const test = createTestDependencies();

    await ensureServerRunning(test.deps, { projectDir });
    const stopExitCode = await runCli(["stop"], test.deps);
    const statusExitCode = await runCli(["status"], test.deps);

    expect(stopExitCode).toBe(0);
    expect(statusExitCode).toBe(1);
    expect(fs.existsSync(getServerStateFilePath(test.deps.env))).toBeFalsy();
    expect(test.logs).toContain(
      "Markdown Mode is not running. Start it with `markdownmode start`.",
    );
  });

  it("returns successful JSON status when Markdown Mode is not running", async () => {
    const test = createTestDependencies();

    const exitCode = await runCli(["status", "--json"], test.deps);
    const payload = parseOnlyJsonLog<{
      running: boolean;
      stateFile: string;
    }>(test.logs);

    expect(exitCode).toBe(0);
    expect(payload).toEqual({
      running: false,
      stateFile: getServerStateFilePath(test.deps.env),
    });
  });

  it("emits JSON from status when Markdown Mode is running", async () => {
    const test = createTestDependencies();
    const result = await ensureServerRunning(test.deps, { projectDir });

    const exitCode = await runCli(["status", "--json"], test.deps);
    const payload = parseOnlyJsonLog<{
      running: boolean;
      url: string;
      port: number;
      pid: number;
      startedAt: string;
      stateFile: string;
      managed: boolean;
    }>(test.logs);

    expect(exitCode).toBe(0);
    expect(payload).toEqual({
      running: true,
      url: result.server.url,
      port: result.server.port,
      pid: result.server.pid,
      startedAt: result.server.startedAt,
      stateFile: getServerStateFilePath(test.deps.env),
      managed: true,
    });
  });

  it("prints watch and mcp in top-level help", async () => {
    const test = createTestDependencies();

    const exitCode = await runCli(["--help"], test.deps);

    expect(exitCode).toBe(0);
    expect(test.logs.join("\n")).toContain("watch <path>");
    expect(test.logs.join("\n")).toContain("mcp");
  });

  it("waits for a review completed event from watch --json", async () => {
    const test = createTestDependencies();
    const documentPath = path.join(projectDir, "draft.md");
    fs.writeFileSync(documentPath, "# Draft\n");

    const watchPromise = runCli(
      [
        "watch",
        documentPath,
        "--json",
        "--timeout",
        "2",
        "--batch-window",
        "0",
      ],
      test.deps,
    );

    let persisted: { port: number } | null = null;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const stateFile = getServerStateFilePath(test.deps.env);
      if (fs.existsSync(stateFile)) {
        persisted = JSON.parse(fs.readFileSync(stateFile, "utf8")) as {
          port: number;
        };
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    expect(persisted).not.toBeNull();
    await fetch(`http://localhost:${persisted?.port}/api/review-events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectPath: projectDir, path: "draft.md" }),
    });

    const exitCode = await watchPromise;
    const payload = parseOnlyJsonLog<{
      timedOut: boolean;
      events: Array<{ documentPath: string; type: string }>;
    }>(test.logs);

    expect(exitCode).toBe(0);
    expect(payload.timedOut).toBe(false);
    expect(payload.events).toHaveLength(1);
    expect(payload.events[0]).toMatchObject({
      documentPath,
      type: "review.completed",
    });
  });

  it("rejects open --watch --json before starting legacy watch flow", async () => {
    const test = createTestDependencies();
    const documentPath = path.join(projectDir, "draft.md");
    fs.writeFileSync(documentPath, "# Draft\n");

    const exitCode = await runCli(
      ["open", documentPath, "--watch", "--json", "--batch-window", "0"],
      test.deps,
    );

    expect(exitCode).toBe(2);
    expect(test.getSpawnCount()).toBe(0);
    expect(test.errors.join("\n")).toContain(
      "blocking review wait flow is no longer part of `markdownmode open`",
    );
  });

  it("cleans stale state during status checks", async () => {
    const test = createTestDependencies();
    const stateFilePath = getServerStateFilePath(test.deps.env);

    fs.mkdirSync(path.dirname(stateFilePath), { recursive: true });
    fs.writeFileSync(
      stateFilePath,
      JSON.stringify({
        port: 3999,
        pid: 999999,
        startedAt: new Date().toISOString(),
        url: "http://localhost:3999",
      }),
    );

    const exitCode = await runCli(["status"], test.deps);

    expect(exitCode).toBe(1);
    expect(fs.existsSync(stateFilePath)).toBeFalsy();
  });

  it("reports and reuses an unmanaged server when the tracked pid is stale", async () => {
    const logs: string[] = [];
    const stateFilePath = path.join(stateDir, "server.json");

    fs.mkdirSync(path.dirname(stateFilePath), { recursive: true });
    fs.writeFileSync(
      stateFilePath,
      JSON.stringify({
        port: ROUGHDRAFT_DEFAULT_PORT,
        pid: 424242,
        startedAt: new Date().toISOString(),
        url: `http://localhost:${ROUGHDRAFT_DEFAULT_PORT}`,
      }),
    );

    const deps = createCliDependencies({
      env: {
        ...process.env,
        CODEX_THREAD_ID: "",
        ROUGHDRAFT_STATE_DIR: stateDir,
      },
      cwd: projectDir,
      fetchImpl: async (input) => {
        const url =
          input instanceof URL
            ? input
            : new URL(
                typeof input === "string" ? input : input.url,
                "http://localhost",
              );

        if (
          url.pathname === "/api/status" &&
          url.port === String(ROUGHDRAFT_DEFAULT_PORT)
        ) {
          return new Response(
            JSON.stringify({
              backend: "local-files",
              port: ROUGHDRAFT_DEFAULT_PORT,
              projectDir,
              serverRoot,
            }),
            {
              status: 200,
              headers: { "Content-Type": "application/json" },
            },
          );
        }

        throw new Error("connect ECONNREFUSED");
      },
      isProcessRunning: () => false,
      stopProcess: async () => {},
      spawnServerProcess: async () => {
        throw new Error("should not spawn");
      },
      openDesktopApp: () => true,
      log: (message) => logs.push(message),
      error: () => {},
    });

    const documentPath = path.join(projectDir, "draft.md");
    fs.writeFileSync(documentPath, "# Draft\n");

    const statusExitCode = await runCli(["status"], deps);
    const openExitCode = await runCli(
      ["open", documentPath, "--no-watch"],
      deps,
    );

    expect(statusExitCode).toBe(0);
    expect(openExitCode).toBe(0);
    expect(logs).toContain(
      `Markdown Mode is running at http://localhost:${ROUGHDRAFT_DEFAULT_PORT}`,
    );
    expect(logs).toContain(
      `This server is not managed by ${getServerStateFilePath(deps.env)}.`,
    );
    expect(fs.existsSync(stateFilePath)).toBeFalsy();
  });

  it("rejects directories before opening", async () => {
    const test = createTestDependencies();

    const exitCode = await runCli(["open", projectDir], test.deps);

    expect(exitCode).toBe(1);
    expect(test.getSpawnCount()).toBe(0);
    expect(test.errors).toContain(
      `Markdown Mode can only open .md files: ${projectDir}`,
    );
  });

  it("cleans stale state and warns when another Markdown Mode instance owns the port during stop", async () => {
    const errors: string[] = [];
    const stateFilePath = path.join(stateDir, "server.json");

    fs.mkdirSync(path.dirname(stateFilePath), { recursive: true });
    fs.writeFileSync(
      stateFilePath,
      JSON.stringify({
        port: ROUGHDRAFT_DEFAULT_PORT,
        pid: 424242,
        startedAt: new Date().toISOString(),
        url: `http://localhost:${ROUGHDRAFT_DEFAULT_PORT}`,
      }),
    );

    const deps = createCliDependencies({
      env: {
        ...process.env,
        CODEX_THREAD_ID: "",
        ROUGHDRAFT_STATE_DIR: stateDir,
      },
      cwd: projectDir,
      fetchImpl: async (input) => {
        const url =
          input instanceof URL
            ? input
            : new URL(
                typeof input === "string" ? input : input.url,
                "http://localhost",
              );

        if (
          url.pathname === "/api/status" &&
          url.port === String(ROUGHDRAFT_DEFAULT_PORT)
        ) {
          return new Response(
            JSON.stringify({
              backend: "local-files",
              port: ROUGHDRAFT_DEFAULT_PORT,
              projectDir,
              serverRoot,
            }),
            {
              status: 200,
              headers: { "Content-Type": "application/json" },
            },
          );
        }

        throw new Error("connect ECONNREFUSED");
      },
      isProcessRunning: () => false,
      stopProcess: async () => {},
      spawnServerProcess: async () => {
        throw new Error("should not spawn");
      },
      openDesktopApp: () => false,
      log: () => {},
      error: (message) => errors.push(message),
    });

    const stopExitCode = await runCli(["stop"], deps);

    expect(stopExitCode).toBe(1);
    expect(errors).toContain(
      `Stopped tracked Markdown Mode process 424242, but another Markdown Mode instance is still running at http://localhost:${ROUGHDRAFT_DEFAULT_PORT}.`,
    );
    expect(fs.existsSync(stateFilePath)).toBeFalsy();
  });

  it("stops a confidently identified unmanaged server with stop --all", async () => {
    const logs: string[] = [];
    let unmanagedRunning = true;
    let stoppedPid: number | null = null;

    const deps = createCliDependencies({
      env: {
        ...process.env,
        CODEX_THREAD_ID: "",
        ROUGHDRAFT_STATE_DIR: stateDir,
      },
      cwd: projectDir,
      fetchImpl: async (input) => {
        const url =
          input instanceof URL
            ? input
            : new URL(
                typeof input === "string" ? input : input.url,
                "http://localhost",
              );

        if (
          unmanagedRunning &&
          url.pathname === "/api/status" &&
          url.port === String(ROUGHDRAFT_DEFAULT_PORT)
        ) {
          return new Response(
            JSON.stringify({
              backend: "local-files",
              pid: 4242,
              port: ROUGHDRAFT_DEFAULT_PORT,
              projectDir,
              serverRoot,
            }),
            {
              status: 200,
              headers: { "Content-Type": "application/json" },
            },
          );
        }

        throw new Error("connect ECONNREFUSED");
      },
      isProcessRunning: (pid) => unmanagedRunning && pid === 4242,
      stopProcess: async (pid) => {
        stoppedPid = pid;
        unmanagedRunning = false;
      },
      spawnServerProcess: async () => {
        throw new Error("should not spawn");
      },
      openDesktopApp: () => false,
      log: (message) => logs.push(message),
      error: () => {},
    });

    const exitCode = await runCli(["stop", "--all"], deps);

    expect(exitCode).toBe(0);
    expect(stoppedPid).toBe(4242);
    expect(logs).toContain(
      `Stopped unmanaged Markdown Mode at http://localhost:${ROUGHDRAFT_DEFAULT_PORT}.`,
    );
  });

  it("documents extended review syntax in criticmarkup help", async () => {
    const test = createTestDependencies();

    const exitCode = await runCli(["help", "criticmarkup"], test.deps);

    expect(exitCode).toBe(0);
    expect(test.logs).toContain("When adding new review feedback:");
    expect(test.logs).toContain(
      '  Prefer the extended Markdown Mode format with `id`, `by`, and `at` metadata, for example {>>Comment<<}{id="c1" by="AI" at="2026-04-28T12:00:00.000Z"}.',
    );
    expect(test.logs).toContain(
      "  Use `c1`, `c2`, etc. for comment ids and `s1`, `s2`, etc. for suggested-change ids.",
    );
    expect(test.logs).toContain("Suggested changes with ids:");
    expect(test.logs).toContain(
      '  Add {++one concrete example++}{id="s1" by="AI" at="2026-04-28T12:05:00.000Z"}.',
    );
    expect(test.logs).toContain(
      '  Replace {~~vague phrasing~>specific wording~~}{id="s2" by="AI" at="2026-04-28T12:06:00.000Z"}.',
    );
    expect(test.logs).toContain("Comment guidance:");
    expect(test.logs).toContain(
      "  Add new feedback as a root comment or suggested change.",
    );
    expect(test.logs).toContain(
      "  Comment ids are document-local and usually look like `c1`, `c2`, `c3`.",
    );
    expect(test.logs).toContain(
      "  Treat CriticMarkup inside fenced code blocks as literal example text.",
    );
    expect(test.logs).toContain(
      "  https://roughdraft.md/spec/roughdraft-flavored-markdown.md",
    );
  });

  it("points general help to agent setup", async () => {
    const test = createTestDependencies();

    const exitCode = await runCli(["help"], test.deps);

    expect(exitCode).toBe(0);
    expect(test.logs).toContain(
      "  help agent         Print the agent setup prompt",
    );
    expect(test.logs).toContain("Agent setup: https://roughdraft.md/setup.md");
    expect(test.logs).toContain(
      "Use `markdownmode help agent` for a copyable setup prompt.",
    );
  });

  it("prints a copyable agent setup prompt", async () => {
    const test = createTestDependencies();

    const exitCode = await runCli(["help", "agent"], test.deps);

    expect(exitCode).toBe(0);
    expect(test.logs).toContain(
      "To set up your coding agent, paste this into it:",
    );
    expect(test.logs).toContain(
      "Install Markdown Mode for me using `npm i -g markdownmode`, then read https://roughdraft.md/setup.md and set yourself up to use it.",
    );
    expect(test.logs).toContain(
      "This command only prints setup text. It does not edit agent instruction files.",
    );
  });

  it("keeps CLAUDE.md as a short compatibility shim to AGENTS.md", () => {
    const claudePath = path.join(serverRoot, "CLAUDE.md");
    const claude = fs.readFileSync(claudePath, "utf8");

    expect(claude.length).toBeLessThan(200);
    expect(claude).toContain("@AGENTS.md");
    expect(claude).toContain("compatibility shim");
    expect(fs.lstatSync(claudePath).isSymbolicLink()).toBe(false);
  });

  it("treats removed install command as an unknown command", async () => {
    const test = createTestDependencies();

    const exitCode = await runCli(["install"], test.deps);

    expect(exitCode).toBe(2);
    expect(test.errors).toContain("Unknown command: install.");
    expect(test.logs).toEqual([]);
  });

  it("prints package version only for --version", async () => {
    const test = createTestDependencies();

    const exitCode = await runCli(["--version"], test.deps);

    expect(exitCode).toBe(0);
    expect(test.logs).toHaveLength(1);
    expect(test.logs[0]).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("shows per-command help", async () => {
    const test = createTestDependencies();

    const exitCode = await runCli(["open", "--help"], test.deps);

    expect(exitCode).toBe(0);
    expect(test.logs).toContain(
      "  markdownmode open <path> [--no-open] [--port <port>]",
    );
    expect(test.logs).toContain(
      "  --no-watch           Compatibility no-op; open returns by default",
    );
    expect(test.logs).toContain("  --origin-thread-id <id>");
    expect(test.logs).toContain(
      "  --print-url          Removed; Markdown Mode no longer opens a web UI",
    );
  });

  it("shows doctor help with the optional markdown path", async () => {
    const test = createTestDependencies();

    const exitCode = await runCli(["doctor", "--help"], test.deps);

    expect(exitCode).toBe(0);
    expect(test.logs).toContain("  markdownmode doctor [path] [--json]");
  });

  it("rejects unknown command typos with suggestions", async () => {
    const test = createTestDependencies();

    const exitCode = await runCli(["stats"], test.deps);

    expect(exitCode).toBe(2);
    expect(test.errors).toContain(
      "Unknown command: stats. Did you mean status?",
    );
  });

  it("supports agent-setup as a direct setup helper", async () => {
    const test = createTestDependencies();

    const exitCode = await runCli(["agent-setup"], test.deps);

    expect(exitCode).toBe(0);
    expect(test.logs).toContain(
      "Live setup instructions: https://roughdraft.md/setup.md",
    );
  });

  it("reports dev wrapper metadata from doctor --json", async () => {
    const logs: string[] = [];
    const wrapperPath = path.join(tempDir, "bin", "markdownmode-dev-lyon-v2");
    const devStateDir = path.join(
      tempDir,
      ".markdownmode",
      "dev",
      "markdownmode-dev-lyon-v2",
    );
    const deps = createCliDependencies({
      env: {
        ...process.env,
        CODEX_THREAD_ID: "",
        ROUGHDRAFT_DEV_WRAPPER_NAME: "markdownmode-dev-lyon-v2",
        ROUGHDRAFT_DEV_WRAPPER_PATH: wrapperPath,
        ROUGHDRAFT_DEV_WRAPPER_REPO_ROOT: serverRoot,
        ROUGHDRAFT_STATE_DIR: devStateDir,
      },
      cwd: projectDir,
      fetchImpl: async () => {
        throw new Error("connect ECONNREFUSED");
      },
      log: (message) => logs.push(message),
      error: () => {},
    });

    const exitCode = await runCli(["doctor", "--json"], deps);
    const payload = parseOnlyJsonLog<{
      devWrapper: {
        commandName: string;
        path: string;
        repoRoot: string;
        repoRootMatches: boolean;
        stateDir: string;
      };
    }>(logs);

    expect(exitCode).toBe(0);
    expect(payload.devWrapper).toEqual({
      commandName: "markdownmode-dev-lyon-v2",
      path: wrapperPath,
      repoRoot: serverRoot,
      repoRootMatches: true,
      stateDir: devStateDir,
    });
  });

  it("validates a conforming markdown file from doctor path", async () => {
    const test = createTestDependencies();
    const documentPath = path.join(projectDir, "draft.md");
    fs.writeFileSync(
      documentPath,
      'Please revisit {==this sentence==}{>>Needs a source.<<}{id="c1" by="user" at="2026-04-28T12:00:00.000Z"}.\n',
    );

    const exitCode = await runCli(["doctor", documentPath], test.deps);

    expect(exitCode).toBe(0);
    expect(test.logs).toContain("Markdown Mode Markdown doctor: draft.md");
    expect(test.logs).toContain("Status: passed");
    expect(test.logs).toContain("Found 1 comment(s) and 0 suggestion(s).");
  });

  it("returns validation errors from doctor path", async () => {
    const test = createTestDependencies();
    const documentPath = path.join(projectDir, "draft.md");
    fs.writeFileSync(documentPath, "{>>Needs metadata<<}\n");

    const exitCode = await runCli(["doctor", documentPath], test.deps);

    expect(exitCode).toBe(1);
    expect(test.logs).toContain("Status: failed");
    expect(test.logs).toContain("Errors:");
    expect(test.logs).toContain(
      "  1:1  Missing required metadata attribute `id`.",
    );
  });

  it("emits JSON validation output from doctor path --json", async () => {
    const test = createTestDependencies();
    const documentPath = path.join(projectDir, "draft.md");
    fs.writeFileSync(
      documentPath,
      [
        '{>>First<<}{id="c1" by="user" at="2026-04-28T12:00:00.000Z"}',
        '{++Second++}{id="c1" by="user" at="2026-04-28T12:01:00.000Z"}',
      ].join("\n"),
    );

    const exitCode = await runCli(
      ["doctor", documentPath, "--json"],
      test.deps,
    );
    const payload = parseOnlyJsonLog<{
      kind: string;
      path: string;
      ok: boolean;
      errors: Array<{ code: string }>;
      summary: { comments: number; suggestions: number };
    }>(test.logs);

    expect(exitCode).toBe(1);
    expect(payload).toMatchObject({
      kind: "markdown",
      path: documentPath,
      ok: false,
      summary: {
        comments: 1,
        suggestions: 1,
      },
    });
    expect(payload.errors.map((error) => error.code)).toContain("duplicate-id");
  });

  it("rejects missing markdown files from doctor path before validation", async () => {
    const test = createTestDependencies();
    const documentPath = path.join(projectDir, "missing.md");

    const exitCode = await runCli(["doctor", documentPath], test.deps);

    expect(exitCode).toBe(2);
    expect(test.errors).toContain(`Path not found: ${documentPath}`);
  });

  it("rejects non-markdown doctor paths as usage errors", async () => {
    const test = createTestDependencies();
    const documentPath = path.join(projectDir, "draft.txt");
    fs.writeFileSync(documentPath, "# Draft\n");

    const exitCode = await runCli(["doctor", documentPath], test.deps);

    expect(exitCode).toBe(2);
    expect(test.errors).toContain(
      `Markdown Mode doctor can only validate .md files: ${documentPath}`,
    );
  });

  it("starts a new server when the preferred port belongs to another checkout", async () => {
    const stateFilePath = path.join(stateDir, "server.json");
    const otherServerRoot = path.join(tempDir, "other-checkout");
    let spawnedPort: number | null = null;
    let spawnedProjectDir: string | null = null;
    let spawned = false;

    fs.mkdirSync(path.dirname(stateFilePath), { recursive: true });
    fs.writeFileSync(
      stateFilePath,
      JSON.stringify({
        port: ROUGHDRAFT_DEFAULT_PORT,
        pid: 424242,
        startedAt: new Date().toISOString(),
        url: `http://localhost:${ROUGHDRAFT_DEFAULT_PORT}`,
      }),
    );

    const deps = createCliDependencies({
      env: {
        ...process.env,
        ROUGHDRAFT_STATE_DIR: stateDir,
      },
      cwd: projectDir,
      fetchImpl: async (input) => {
        const url =
          input instanceof URL
            ? input
            : new URL(
                typeof input === "string" ? input : input.url,
                "http://localhost",
              );

        if (url.pathname !== "/api/status") {
          throw new Error("Unexpected request");
        }

        if (url.port === String(ROUGHDRAFT_DEFAULT_PORT)) {
          return new Response(
            JSON.stringify({
              backend: "local-files",
              port: ROUGHDRAFT_DEFAULT_PORT,
              projectDir: path.join(tempDir, "other-project"),
              serverRoot: otherServerRoot,
            }),
            {
              status: 200,
              headers: { "Content-Type": "application/json" },
            },
          );
        }

        if (url.port === String(ROUGHDRAFT_DEFAULT_PORT + 1) && spawned) {
          return new Response(
            JSON.stringify({
              backend: "local-files",
              port: ROUGHDRAFT_DEFAULT_PORT + 1,
              projectDir,
              serverRoot,
            }),
            {
              status: 200,
              headers: { "Content-Type": "application/json" },
            },
          );
        }

        throw new Error("connect ECONNREFUSED");
      },
      findAvailablePortImpl: async () => ROUGHDRAFT_DEFAULT_PORT + 1,
      spawnServerProcess: async ({ port, projectDir: nextProjectDir }) => {
        spawned = true;
        spawnedPort = port;
        spawnedProjectDir = nextProjectDir;
        return { pid: 1001 };
      },
      isProcessRunning: (pid) => pid === 424242,
      stopProcess: async () => {},
      openDesktopApp: () => false,
      log: () => {},
      error: () => {},
    });

    const result = await ensureServerRunning(deps, { projectDir });

    expect(result.reused).toBe(false);
    expect(spawnedPort).toBe(ROUGHDRAFT_DEFAULT_PORT + 1);
    expect(spawnedProjectDir).toBe(projectDir);
    expect(result.server.port).toBe(ROUGHDRAFT_DEFAULT_PORT + 1);
  });
});

describe("runCli open with removed remote browser mode", () => {
  let tempDir: string;
  let projectDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "markdownmode-remote-"));
    projectDir = path.join(tempDir, "project");
    fs.mkdirSync(projectDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("rejects ROUGHDRAFT_HOST remote browser opens", async () => {
    const filePath = path.join(projectDir, "draft.md");
    fs.writeFileSync(filePath, "# hello\n");

    const errors: string[] = [];

    const exitCode = await runCli(["open", filePath], {
      env: { ROUGHDRAFT_HOST: "http://127.0.0.1:1" },
      cwd: projectDir,
      log: () => {},
      error: (message) => errors.push(message),
      openDesktopApp: () => true,
      resolveUpdateStatus: async () => ({
        packageName: "markdownmode",
        currentVersion: "0.1.0",
        latestVersion: "0.1.0",
        updateAvailable: false,
        updateCommand: "",
      }),
    });

    expect(exitCode).toBe(2);
    expect(errors.join("\n")).toContain(
      "Remote browser open mode has been removed",
    );
  });
});
