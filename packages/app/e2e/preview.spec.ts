import { expect, test } from "@playwright/test";
import { appendInCodeEditor, codeEditor, logE2eEvent } from "./helpers";

test.describe("in-memory preview", () => {
  test("edits the preview document without persisting it @smoke", async ({
    page,
  }) => {
    await page.goto("/preview?editor=code");

    await expect(codeEditor(page)).toContainText("Live Preview");
    await appendInCodeEditor(page, "\n\nPreview-only edit.");
    await expect(codeEditor(page)).toContainText("Preview-only edit.");

    const roughdraftStorageKeys = await page.evaluate(() =>
      Object.keys(window.localStorage).filter((key) =>
        key.startsWith("roughdraft:"),
      ),
    );
    expect(roughdraftStorageKeys).toEqual([]);

    await page.reload();
    await expect(codeEditor(page)).toContainText("Live Preview");
    await expect(codeEditor(page)).not.toContainText("Preview-only edit.");

    logE2eEvent("preview.in-memory-edit", {
      route: "/preview",
      persistedStorageKeys: roughdraftStorageKeys.length,
    });
  });

  test("does not show Done Reviewing controls in preview", async ({ page }) => {
    await page.goto("/preview");

    await expect(page.getByTestId("review-handoff-button")).toHaveCount(0);
    await expect(page.getByTestId("document-save-status")).toContainText(
      "Saved",
    );

    logE2eEvent("preview.no-done-reviewing-control", {
      route: "/preview",
    });
  });
});
