import { expect, test } from "@playwright/test";
import {
  createMarkdownProject,
  doubleClickRichText,
  logE2eEvent,
  openMarkdownFile,
  readProjectFile,
  removeMarkdownProject,
  selectRichText,
  selectRichTextDuringPointerDrag,
  writeProjectFile,
} from "./helpers";

test.describe("CriticMarkup review flows", () => {
  let projectDir: string;

  test.beforeEach(() => {
    projectDir = createMarkdownProject("criticmarkup");
  });

  test.afterEach(() => {
    removeMarkdownProject(projectDir);
  });

  test("renders a comment and edits it directly @smoke", async ({ page }) => {
    const filePath = writeProjectFile(
      projectDir,
      "comment.md",
      [
        "# Comment Review",
        "",
        'This paragraph has {==target text==}{>>Needs detail<<}{id="c1" by="user" at="2026-04-23T18:00:00.000Z"}.',
        "",
      ].join("\n"),
    );

    await openMarkdownFile(page, filePath);
    await page.getByTestId("document-comment-marker-c1").click();
    await expect(page.getByTestId("document-comment-fallback")).toContainText(
      "Needs detail",
    );
    await expect
      .poll(() =>
        page
          .getByTestId("document-comment-popover")
          .evaluate(
            (element) => window.getComputedStyle(element).backgroundColor,
          ),
      )
      .toBe("rgb(20, 20, 20)");
    await expect(page.getByTestId("comment-rail-c1-action-save")).toHaveText(
      "Save",
    );

    await expect(page.getByTestId("comment-rail-c1-action-reply")).toHaveCount(
      0,
    );
    await expect(page.getByTestId("comment-rail-c1-action-edit")).toHaveCount(
      0,
    );
    await expect(page.getByTestId("comment-rail-c1-action-delete")).toHaveCount(
      0,
    );
    await expect(page.getByTestId("comment-rail-c1-editor")).toBeFocused();
    await page.keyboard.press(
      process.platform === "darwin" ? "Meta+A" : "Control+A",
    );
    await page.keyboard.type("Needs sharper detail");
    await expect(page.getByTestId("comment-rail-c1-editor")).toHaveValue(
      "Needs sharper detail",
    );
    await page
      .getByTestId("comment-rail-c1-action-save")
      .evaluate((element) => {
        (element as HTMLButtonElement).click();
      });

    await expect
      .poll(() => readProjectFile(projectDir, "comment.md"))
      .toContain("Needs sharper detail");

    logE2eEvent("criticmarkup.comment-edited", {
      file: "comment.md",
    });
  });

  test("creates a new root comment and saves it to disk @smoke", async ({
    page,
  }) => {
    const filePath = writeProjectFile(
      projectDir,
      "new-comment.md",
      [
        "# New Comment",
        "",
        "This paragraph has target text to review.",
        "",
      ].join("\n"),
    );

    await openMarkdownFile(page, filePath);
    await selectRichText(page, "target text");
    await expect(page.getByTestId("comment-rail-c1-editor")).toBeVisible();
    await page
      .getByTestId("comment-rail-c1-editor")
      .fill("Clarify this phrase.");
    await page.getByTestId("comment-rail-c1-action-save").click();

    await expect
      .poll(() => readProjectFile(projectDir, "new-comment.md"))
      .toMatch(
        /\{==target text==\}\{>>Clarify this phrase\.<<\}\{id="c1" by="user" at="[^"]+"\}/,
      );

    logE2eEvent("criticmarkup.root-comment-saved", {
      file: "new-comment.md",
    });
  });

  test("empty new comment disappears when dismissed before typing @smoke", async ({
    page,
  }) => {
    const filePath = writeProjectFile(
      projectDir,
      "empty-comment-dismiss.md",
      [
        "# Empty Comment Dismiss",
        "",
        "This paragraph has target text to review.",
        "",
      ].join("\n"),
    );

    await openMarkdownFile(page, filePath);
    await selectRichText(page, "target text");
    await expect(
      page.getByTestId("document-comment-marker-c1"),
    ).toHaveAttribute("aria-label", "New comment");
    await expect(page.getByTestId("comment-rail-c1-editor")).toBeVisible();

    await page.keyboard.press("Escape");

    await expect(page.getByTestId("comment-rail-c1-editor")).toHaveCount(0);
    await expect(page.getByTestId("document-comment-marker-c1")).toHaveCount(0);
    await expect
      .poll(() => readProjectFile(projectDir, "empty-comment-dismiss.md"))
      .not.toContain("{>>");

    await selectRichText(page, "target text");
    await expect(
      page.getByTestId("document-comment-marker-c1"),
    ).toHaveAttribute("aria-label", "New comment");
    await page.mouse.click(8, 8);

    await expect(page.getByTestId("comment-rail-c1-editor")).toHaveCount(0);
    await expect(page.getByTestId("document-comment-marker-c1")).toHaveCount(0);
    await expect
      .poll(() => readProjectFile(projectDir, "empty-comment-dismiss.md"))
      .not.toContain("{>>");

    logE2eEvent("criticmarkup.empty-comment-dismissed", {
      file: "empty-comment-dismiss.md",
    });
  });

  test("submitting a comment notifies the waiting agent without Done Reviewing @smoke", async ({
    page,
  }) => {
    const filePath = writeProjectFile(
      projectDir,
      "auto-handoff.md",
      [
        "# Auto Handoff",
        "",
        "This paragraph has target text for the agent.",
        "",
      ].join("\n"),
    );

    await openMarkdownFile(page, filePath);
    const watchPromise = page.evaluate(
      async ({ projectPath, relativePath }) => {
        const response = await fetch("/api/review-events/watch", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            projectPath,
            path: relativePath,
            fromNow: true,
            timeoutSeconds: 8,
            batchWindowSeconds: 0,
          }),
        });
        return response.json() as Promise<{
          events?: Array<{ relativePath?: string }>;
          timedOut?: boolean;
        }>;
      },
      { projectPath: projectDir, relativePath: "auto-handoff.md" },
    );

    await expect(page.getByTestId("review-handoff-button")).toBeVisible();
    await selectRichText(page, "target text");
    await page.getByTestId("comment-rail-c1-editor").fill("Work on this next.");
    await page.getByTestId("comment-rail-c1-action-save").click();

    await expect
      .poll(() => readProjectFile(projectDir, "auto-handoff.md"))
      .toContain("Work on this next.");

    const watchResult = await watchPromise;
    expect(watchResult.timedOut).toBe(false);
    expect(watchResult.events?.[0]?.relativePath).toBe("auto-handoff.md");
  });

  test("submits multiple comments as separate agent handoffs @smoke", async ({
    page,
  }) => {
    const filePath = writeProjectFile(
      projectDir,
      "multi-handoff.md",
      [
        "# Multi Handoff",
        "",
        "This paragraph has first target and second target for review.",
        "",
      ].join("\n"),
    );

    const watchReview = (relativePath: string) =>
      page.evaluate(
        async ({ projectPath, relativePath: watchedPath }) => {
          const response = await fetch("/api/review-events/watch", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              projectPath,
              path: watchedPath,
              fromNow: true,
              timeoutSeconds: 8,
              batchWindowSeconds: 0,
            }),
          });
          return response.json() as Promise<{
            events?: Array<{ relativePath?: string }>;
            timedOut?: boolean;
          }>;
        },
        { projectPath: projectDir, relativePath },
      );

    await openMarkdownFile(page, filePath);

    const firstWatch = watchReview("multi-handoff.md");
    await expect(page.getByTestId("review-handoff-button")).toBeVisible();
    await selectRichText(page, "first target");
    await page.getByTestId("comment-rail-c1-editor").fill("Do this first.");
    await page.getByTestId("comment-rail-c1-action-save").click();
    await expect(
      page.getByTestId("document-comment-marker-c1-working"),
    ).toBeVisible();

    const firstResult = await firstWatch;
    expect(firstResult.timedOut).toBe(false);
    expect(firstResult.events?.[0]?.relativePath).toBe("multi-handoff.md");

    const secondWatch = watchReview("multi-handoff.md");
    await expect(
      page.getByTestId("review-handoff-inline-status"),
    ).toContainText("Agent watching");
    await selectRichText(page, "second target");
    await page.getByTestId("comment-rail-c2-editor").fill("Then do this.");
    await page.getByTestId("comment-rail-c2-action-save").click();
    await expect(
      page.getByTestId("document-comment-marker-c2-working"),
    ).toBeVisible();

    await expect
      .poll(() => readProjectFile(projectDir, "multi-handoff.md"))
      .toContain("Then do this.");

    const secondResult = await secondWatch;
    expect(secondResult.timedOut).toBe(false);
    expect(secondResult.events?.[0]?.relativePath).toBe("multi-handoff.md");
  });

  test("double-clicking text opens the comment composer @smoke", async ({
    page,
  }) => {
    const filePath = writeProjectFile(
      projectDir,
      "double-click-comment.md",
      [
        "# Double Click Comment",
        "",
        "This paragraph has target text for a quick comment.",
        "",
      ].join("\n"),
    );

    await openMarkdownFile(page, filePath);
    await doubleClickRichText(page, "target");
    await expect(page.getByTestId("comment-rail-c1-editor")).toBeVisible();
  });

  test("waits until pointer release before opening the comment composer @smoke", async ({
    page,
  }) => {
    const filePath = writeProjectFile(
      projectDir,
      "drag-comment.md",
      [
        "# Drag Comment",
        "",
        "This paragraph has target text to review while dragging.",
        "",
      ].join("\n"),
    );

    await openMarkdownFile(page, filePath);
    await selectRichTextDuringPointerDrag(page, "target text to review");
    await expect(page.getByTestId("comment-rail-c1-editor")).toHaveCount(0);

    await page.evaluate(() => {
      document.dispatchEvent(
        new PointerEvent("pointerup", {
          bubbles: true,
          cancelable: true,
          button: 0,
          pointerType: "mouse",
        }),
      );
    });

    await expect(page.getByTestId("comment-rail-c1-editor")).toBeVisible();
  });

  test("accepts and rejects suggested changes on disk @smoke", async ({
    page,
  }) => {
    const filePath = writeProjectFile(
      projectDir,
      "suggestions.md",
      [
        "# Suggestion Review",
        "",
        'Keep {++clear wording++}{id="s1" by="user" at="2026-04-23T18:00:00.000Z"} here.',
        "",
        'Remove {--drafty --}{id="s2" by="user" at="2026-04-23T18:01:00.000Z"}there.',
        "",
      ].join("\n"),
    );

    await openMarkdownFile(page, filePath);
    await expect(page.locator('[data-critic-change-id="s1"]')).toBeVisible();

    await page.getByTestId("comment-rail-s1-action-accept").click();
    await expect
      .poll(() => readProjectFile(projectDir, "suggestions.md"))
      .toContain("Keep clear wording here.");

    await page.getByTestId("comment-rail-s2-action-reject").click();
    await expect
      .poll(() => readProjectFile(projectDir, "suggestions.md"))
      .toContain("Remove drafty there.");
    expect(readProjectFile(projectDir, "suggestions.md")).not.toContain("{++");
    expect(readProjectFile(projectDir, "suggestions.md")).not.toContain("{--");

    logE2eEvent("criticmarkup.suggestions-applied", {
      file: "suggestions.md",
    });
  });
});
