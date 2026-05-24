import fs from "node:fs";
import { expect, test } from "@playwright/test";
import {
  appendInCodeEditor,
  codeEditor,
  createMarkdownProject,
  documentSaveStatus,
  logE2eEvent,
  openMarkdownFile,
  readProjectFile,
  removeMarkdownProject,
  writeProjectFile,
} from "./helpers";

test.describe("stale writes", () => {
  let projectDir: string;

  test.beforeEach(() => {
    projectDir = createMarkdownProject("stale-write");
  });

  test.afterEach(() => {
    removeMarkdownProject(projectDir);
  });

  test("reloads the disk version after a stale autosave @smoke", async ({
    page,
  }) => {
    await page.route("**/api/markdown-file/events**", (route) => route.abort());

    const filePath = writeProjectFile(
      projectDir,
      "conflict.md",
      "# Conflict\n\nOriginal body.\n",
    );

    await openMarkdownFile(page, filePath, "code");
    await expect(codeEditor(page)).toContainText("Original body.");

    fs.writeFileSync(filePath, "# Conflict\n\nExternal body.\n");
    await appendInCodeEditor(page, "\nLocal body.\n");

    await expect(documentSaveStatus(page)).toContainText("Saved");
    await expect(page.getByTestId("file-conflict-notice")).toBeHidden();
    await expect(codeEditor(page)).toContainText("External body.");
    await expect(codeEditor(page)).not.toContainText("Local body.");
    expect(readProjectFile(projectDir, "conflict.md")).toBe(
      "# Conflict\n\nExternal body.\n",
    );

    logE2eEvent("stale-write.disk-version-reloaded", {
      file: "conflict.md",
    });
  });

  test("manual save reloads the disk version when the expected version is stale", async ({
    page,
  }) => {
    await page.route("**/api/markdown-file/events**", (route) => route.abort());

    const filePath = writeProjectFile(
      projectDir,
      "manual-conflict.md",
      "# Manual Conflict\n\nOriginal body.\n",
    );

    await openMarkdownFile(page, filePath, "code");
    await expect(codeEditor(page)).toContainText("Original body.");

    fs.writeFileSync(filePath, "# Manual Conflict\n\nExternal body.\n");
    await appendInCodeEditor(page, "\nLocal body.\n");
    await page.keyboard.press(
      process.platform === "darwin" ? "Meta+S" : "Control+S",
    );

    await expect(documentSaveStatus(page)).toContainText("Saved");
    await expect(page.getByTestId("file-conflict-notice")).toBeHidden();
    await expect(codeEditor(page)).toContainText("External body.");
    await expect(codeEditor(page)).not.toContainText("Local body.");
    expect(readProjectFile(projectDir, "manual-conflict.md")).toBe(
      "# Manual Conflict\n\nExternal body.\n",
    );

    logE2eEvent("stale-write.manual-disk-version-reloaded", {
      file: "manual-conflict.md",
    });
  });

  test("reloads external content with stable file metadata", async ({
    page,
  }) => {
    const fixedTimestamp = new Date("2026-01-01T00:00:00.000Z");
    const filePath = writeProjectFile(
      projectDir,
      "metadata-conflict.md",
      "# Original\n",
    );
    fs.utimesSync(filePath, fixedTimestamp, fixedTimestamp);

    await openMarkdownFile(page, filePath, "code");
    await expect(codeEditor(page)).toContainText("Original");

    fs.writeFileSync(filePath, "# External\n");
    fs.utimesSync(filePath, fixedTimestamp, fixedTimestamp);
    await appendInCodeEditor(page, "\nLocal body.\n");

    await expect(documentSaveStatus(page)).toContainText("Saved");
    await expect(page.getByTestId("file-conflict-notice")).toBeHidden();
    await expect(codeEditor(page)).toContainText("External");
    expect(readProjectFile(projectDir, "metadata-conflict.md")).toBe(
      "# External\n",
    );

    logE2eEvent("stale-write.metadata-disk-version-reloaded", {
      file: "metadata-conflict.md",
    });
  });

  test("keeps the status stack unobstructed without a conflict banner", async ({
    page,
  }) => {
    await page.route("**/api/markdown-file/events**", (route) => route.abort());

    const filePath = writeProjectFile(
      projectDir,
      "layout-conflict.md",
      "# Layout conflict\n\nOriginal body.\n",
    );

    for (const viewport of [
      { width: 1280, height: 720 },
      { width: 390, height: 844 },
    ]) {
      fs.writeFileSync(filePath, "# Layout conflict\n\nOriginal body.\n");
      await page.setViewportSize(viewport);
      await openMarkdownFile(page, filePath, "code");
      await expect(codeEditor(page)).toContainText("Original body.");

      fs.writeFileSync(filePath, "# Layout conflict\n\nExternal body.\n");
      await appendInCodeEditor(page, `\nLocal body ${viewport.width}.\n`);

      await expect(page.getByTestId("file-conflict-notice")).toBeHidden();
      await expect(page.getByTestId("document-status-stack")).toBeVisible();
      await expect(documentSaveStatus(page)).toContainText("Saved");
    }
  });
});
