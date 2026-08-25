import { expect, test } from "@playwright/test";
import {
  codeEditor,
  createMarkdownProject,
  logE2eEvent,
  openMarkdownFile,
  removeMarkdownProject,
  writeProjectFile,
} from "./helpers";

test.describe("opening local markdown files", () => {
  let projectDir: string;

  test.beforeEach(() => {
    projectDir = createMarkdownProject("open-file");
  });

  test.afterEach(() => {
    removeMarkdownProject(projectDir);
  });

  test("renders core Markdown blocks from a real file @smoke", async ({
    page,
  }) => {
    const filePath = writeProjectFile(
      projectDir,
      "review.md",
      [
        "# Smoke Fixture",
        "",
        "A paragraph with [local link](./notes.md), [anchor](#smoke-fixture), and [mail](mailto:review@example.com).",
        "",
        "- first",
        "- second",
        "",
        "- [x] shipped",
        "- [ ] pending",
        "",
        "| Name | Status |",
        "| --- | --- |",
        "| Roughdraft | ready |",
        "",
        '![Sketch](./images/sketch.png "Sketch title")',
        "",
        "```ts",
        "const value = 1;",
        "```",
        "",
      ].join("\n"),
    );
    writeProjectFile(
      projectDir,
      "images/sketch.png",
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
        "base64",
      ),
    );

    await openMarkdownFile(page, filePath);

    const editor = page.getByTestId("rich-text-editor");
    await expect(editor).toContainText("Smoke Fixture");
    await expect(editor).toContainText("first");
    await expect(editor).toContainText("Roughdraft");
    await expect(
      editor.locator('a[data-markdown-src="./notes.md"]', {
        hasText: "local link",
      }),
    ).toBeVisible();
    await expect(
      editor.locator(
        'img[alt="Sketch"][data-markdown-src="./images/sketch.png"]',
      ),
    ).toBeVisible();
    await expect(editor).toContainText("const value = 1;");

    logE2eEvent("open-file.rendered", {
      projectDir,
      file: "review.md",
    });
  });

  test("centers the single Markdown reader in View mode below the review-rail breakpoint", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    const filePath = writeProjectFile(
      projectDir,
      "centered-reader.md",
      "# Centered reader\n\nThe reader should sit in the middle of the window.\n",
    );

    await openMarkdownFile(page, filePath);
    await expect(page.getByTestId("document-mode-view")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(page.getByTestId("document-content-card")).toBeVisible();

    const geometry = await page.evaluate(() => {
      const reader = document.querySelector<HTMLElement>(
        '[data-testid="document-content-card"]',
      );
      if (!reader) throw new Error("Markdown reader column missing");

      const readerBox = reader.getBoundingClientRect();
      const viewportWidth = document.documentElement.clientWidth;
      const readerCenter = readerBox.left + readerBox.width / 2;
      const viewportCenter = viewportWidth / 2;

      return {
        viewportWidth,
        viewportCenter,
        readerLeft: readerBox.left,
        readerWidth: readerBox.width,
        readerCenter,
        centerDelta: readerCenter - viewportCenter,
      };
    });

    logE2eEvent("open-file.view-reader-geometry", geometry);

    expect(Math.abs(geometry.centerDelta)).toBeLessThanOrEqual(1);
  });

  test("opens local and external links directly in View mode @smoke", async ({
    page,
  }) => {
    const targetPath = writeProjectFile(
      projectDir,
      "target.md",
      "# Local target\n",
    );
    const sourcePath = writeProjectFile(
      projectDir,
      "source.md",
      [
        "# View links",
        "",
        "[Local target](./target.md)",
        "",
        "[External target](https://example.com/view-proof)",
        "",
        "[Keyboard target](https://example.com/keyboard-proof)",
        "",
      ].join("\n"),
    );
    await page.context().route("https://example.com/**", async (route) => {
      await route.fulfill({
        contentType: "text/html",
        body: "<title>External target</title>",
      });
    });

    await openMarkdownFile(page, sourcePath);
    await expect(page.getByTestId("document-mode-view")).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    const editor = page.getByTestId("rich-text-editor");
    const localPopupPromise = page.waitForEvent("popup");
    await editor
      .locator('a[data-markdown-src="./target.md"]', {
        hasText: "Local target",
      })
      .click();
    const localPopup = await localPopupPromise;
    await expect
      .poll(() => new URL(localPopup.url()).searchParams.get("path"))
      .toBe(targetPath);
    await localPopup.close();
    await expect(page.getByTestId("link-popover")).toHaveCount(0);

    const externalPopupPromise = page.waitForEvent("popup");
    await editor
      .locator('a[data-markdown-src="https://example.com/view-proof"]', {
        hasText: "External target",
      })
      .click();
    const externalPopup = await externalPopupPromise;
    await expect
      .poll(() => externalPopup.url())
      .toBe("https://example.com/view-proof");
    await externalPopup.close();
    await expect(page.getByTestId("link-popover")).toHaveCount(0);

    const keyboardTarget = editor.locator(
      'a[data-markdown-src="https://example.com/keyboard-proof"]',
      { hasText: "Keyboard target" },
    );
    await keyboardTarget.focus();
    const keyboardPopupPromise = page.waitForEvent("popup");
    await page.keyboard.press("Enter");
    const keyboardPopup = await keyboardPopupPromise;
    await expect
      .poll(() => keyboardPopup.url())
      .toBe("https://example.com/keyboard-proof");
    await keyboardPopup.close();
    await expect(page.getByTestId("link-popover")).toHaveCount(0);

    logE2eEvent("open-file.view-links-opened-directly", {
      projectDir,
      source: "source.md",
      target: "target.md",
    });
  });

  test("keeps neutral document mode controls at the viewport top-right and the update notice below them", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.emulateMedia({ colorScheme: "dark" });
    const filePath = writeProjectFile(
      projectDir,
      "update-notice.md",
      "# Update notice layout\n",
    );
    await page.route("**/api/update-status", async (route) => {
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          packageName: "roughdraft",
          currentVersion: "0.1.0",
          latestVersion: "0.2.0",
          updateAvailable: true,
          updateCommand: "npm i -g roughdraft@latest",
        }),
      });
    });

    await openMarkdownFile(page, filePath);

    const updateNotice = page.getByTestId("update-notice");
    const modeGroup = page.getByTestId("document-mode-group");
    const viewMode = page.getByTestId("document-mode-view");
    const commentMode = page.getByTestId("document-mode-comment");
    await expect(updateNotice).toBeVisible();
    await expect(modeGroup).toBeVisible();
    await expect(viewMode).toHaveAttribute("aria-pressed", "true");
    await expect(commentMode).toBeVisible();

    const updateNoticeBox = await updateNotice.boundingBox();
    const modeGroupBox = await modeGroup.boundingBox();
    if (!updateNoticeBox || !modeGroupBox) {
      throw new Error("Expected visible update notice and mode control boxes");
    }
    const colors = await page.evaluate(() => {
      const group = document.querySelector<HTMLElement>(
        '[role="group"][aria-label="Document mode"]',
      );
      const active = document.querySelector<HTMLElement>(
        '[data-testid="document-mode-view"]',
      );
      if (!group || !active) throw new Error("Document mode controls missing");

      return {
        groupBackground: getComputedStyle(group).backgroundColor,
        activeBackground: getComputedStyle(active).backgroundColor,
        activeForeground: getComputedStyle(active).color,
      };
    });

    expect.soft(modeGroupBox.y).toBeLessThanOrEqual(16);
    expect
      .soft(1280 - (modeGroupBox.x + modeGroupBox.width))
      .toBeLessThanOrEqual(16);
    expect.soft(colors.groupBackground).toBe("rgb(21, 23, 21)");
    expect.soft(colors.activeBackground).toBe("rgb(42, 45, 43)");
    expect.soft(colors.activeForeground).toBe("rgb(231, 233, 231)");
    expect
      .soft(updateNoticeBox.y)
      .toBeGreaterThanOrEqual(modeGroupBox.y + modeGroupBox.height + 8);
  });

  test("focuses an existing window for a repeated open request", async ({
    page,
  }) => {
    const filePath = writeProjectFile(
      projectDir,
      "repeat.md",
      "# Repeat Open\n\nExisting window body.\n",
    );

    await openMarkdownFile(page, filePath, "code");
    await expect(codeEditor(page)).toContainText("Existing window body.");

    const targetUrl = `/?${new URLSearchParams({
      path: filePath,
      editor: "code",
    }).toString()}`;
    const response = await page.request.post("/api/open-request", {
      data: { path: filePath, url: targetUrl },
    });

    expect(response.ok()).toBe(true);
    await expect(response.json()).resolves.toEqual({ delivered: true });
    await expect(codeEditor(page)).toContainText("Existing window body.");

    logE2eEvent("open-file.reused-existing-window", {
      projectDir,
      file: "repeat.md",
    });
  });
});
