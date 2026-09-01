import { expect, test } from "@playwright/test";
import {
  createMarkdownProject,
  logE2eEvent,
  openMarkdownFile,
  readProjectFile,
  removeMarkdownProject,
  writeProjectFile,
} from "./helpers";

test.describe("review handoff", () => {
  let projectDir: string;
  let pendingWatch: Promise<unknown> | null = null;

  test.beforeEach(() => {
    projectDir = createMarkdownProject("review-handoff");
    pendingWatch = null;
  });

  test.afterEach(async () => {
    await pendingWatch?.catch(() => undefined);
    removeMarkdownProject(projectDir);
  });

  test("enables Comment mode only for a connected agent and preserves an active review across disconnect @smoke", async ({
    page,
    request,
  }) => {
    const relativePath = "agent-gated-comments.md";
    const filePath = writeProjectFile(
      projectDir,
      relativePath,
      ["# Agent-gated comments", "", "Review this document.", ""].join("\n"),
    );

    await openMarkdownFile(page, filePath);

    const commentMode = page.getByTestId("document-mode-comment");
    const commentModeTrigger = page.getByTestId(
      "document-mode-comment-trigger",
    );
    const connectionIndicator = page.getByTestId(
      "document-mode-comment-agent-indicator",
    );

    await expect(commentMode).toBeDisabled();
    await expect(commentMode).toHaveAttribute(
      "data-agent-status",
      "disconnected",
    );
    await commentModeTrigger.hover();
    await expect(page.getByTestId("document-mode-comment-tooltip")).toHaveText(
      "No agent is reviewing this file",
    );

    pendingWatch = request.post("/api/review-events/watch", {
      data: {
        projectPath: projectDir,
        path: relativePath,
        timeoutSeconds: 10,
      },
    });

    await expect(commentMode).toBeEnabled();
    await expect(commentMode).toHaveAttribute("data-agent-status", "connected");
    await expect(connectionIndicator).toHaveAttribute(
      "data-agent-status",
      "connected",
    );

    await commentMode.click();
    await expect(commentMode).toHaveAttribute("aria-pressed", "true");

    const releaseResponse = await request.post("/api/review-events", {
      data: {
        projectPath: projectDir,
        path: relativePath,
      },
    });
    expect(releaseResponse.ok()).toBe(true);
    await pendingWatch;

    await expect(commentMode).toHaveAttribute(
      "data-agent-status",
      "disconnected",
    );
    await expect(commentMode).toBeEnabled();
    await expect(commentMode).toHaveAttribute("aria-pressed", "true");
    await expect(connectionIndicator).toHaveAttribute(
      "data-agent-status",
      "disconnected",
    );

    await page.getByTestId("document-mode-view").click();
    await expect(commentMode).toBeDisabled();
    await expect(commentMode).toHaveAttribute("aria-pressed", "false");

    logE2eEvent("review-handoff.comment-agent-gate", {
      disconnectedInitially: true,
      enabledWhenConnected: true,
      activeReviewPreservedAfterDisconnect: true,
      reentryDisabledAfterReturningToView: true,
    });
  });

  test("persists an overall handoff comment from the primary done button to YAML endmatter @smoke", async ({
    page,
    request,
  }) => {
    const filePath = writeProjectFile(
      projectDir,
      "handoff-comment.md",
      ["# Handoff Comment", "", "Review this document.", ""].join("\n"),
    );
    const relativePath = "handoff-comment.md";
    const overallComment = "Please prioritize the CLI contract.";

    pendingWatch = request.post("/api/review-events/watch", {
      data: {
        projectPath: projectDir,
        path: relativePath,
        timeoutSeconds: 10,
      },
    });

    await openMarkdownFile(page, filePath);
    await expect(page.getByTestId("review-handoff-button")).toBeVisible();

    await page.getByTestId("review-handoff-comment-trigger").click();
    await page
      .getByTestId("review-handoff-overall-comment")
      .fill(overallComment);
    await page.getByTestId("review-handoff-button").click();

    await expect(page.getByTestId("review-handoff-status")).toContainText(
      "Your agent is now working",
    );

    await expect
      .poll(() => readProjectFile(projectDir, relativePath))
      .toMatch(
        /---\ncomments:\n {2}c1:\n {4}body: Please prioritize the CLI contract\.\n {4}by: user\n {4}at: [^\n]+\n?$/,
      );

    const watchResponse = await pendingWatch;
    const payload = await watchResponse.json();
    expect(payload.events).toHaveLength(1);
    expect(payload.events[0]).toMatchObject({
      type: "review.completed",
      overallComment,
      summary: {
        comments: 1,
      },
    });
  });

  test("reopens the sent handoff status from the muted primary button", async ({
    page,
    request,
  }) => {
    const filePath = writeProjectFile(
      projectDir,
      "sent-handoff.md",
      ["# Sent Handoff", "", "Review already completed.", ""].join("\n"),
    );
    const relativePath = "sent-handoff.md";

    pendingWatch = request.post("/api/review-events/watch", {
      data: {
        projectPath: projectDir,
        path: relativePath,
        timeoutSeconds: 10,
      },
    });

    await openMarkdownFile(page, filePath);
    await page.getByTestId("review-handoff-button").click();

    await expect(page.getByTestId("review-handoff-button")).toHaveText("Sent");
    await expect(page.getByTestId("review-handoff-status")).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(page.getByTestId("review-handoff-status")).toBeHidden();

    await page.getByTestId("review-handoff-button").click();

    await expect(page.getByTestId("review-handoff-status")).toBeVisible();
    logE2eEvent("review-handoff.sent-button-reopened-status", {
      buttonLabel: await page.getByTestId("review-handoff-button").innerText(),
    });

    await pendingWatch;
  });
});
