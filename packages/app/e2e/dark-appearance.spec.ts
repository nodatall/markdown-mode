import { expect, test } from "@playwright/test";
import {
  createMarkdownProject,
  logE2eEvent,
  openMarkdownFile,
  removeMarkdownProject,
  writeProjectFile,
} from "./helpers";

test.describe("dark document appearance", () => {
  let projectDir: string;

  test.beforeEach(() => {
    projectDir = createMarkdownProject("dark-appearance");
  });

  test.afterEach(() => {
    removeMarkdownProject(projectDir);
  });

  test("matches the reference background and blends the scrollbar into it @smoke", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 900, height: 480 });
    await page.emulateMedia({ colorScheme: "dark" });
    const filePath = writeProjectFile(
      projectDir,
      "long-document.md",
      ["# Dark appearance", ...Array(80).fill("A line of Markdown.")].join(
        "\n\n",
      ),
    );

    await openMarkdownFile(page, filePath);
    await expect(page.getByTestId("rich-text-editor")).toBeVisible();

    const appearance = await page.evaluate(() => {
      const normalizeColor = (color: string) => {
        const canvas = document.createElement("canvas");
        canvas.width = 1;
        canvas.height = 1;
        const context = canvas.getContext("2d");
        if (!context) throw new Error("Canvas 2D context unavailable");

        context.clearRect(0, 0, 1, 1);
        context.fillStyle = color;
        context.fillRect(0, 0, 1, 1);
        const [red, green, blue, alpha] = context.getImageData(0, 0, 1, 1).data;

        return alpha === 255
          ? `rgb(${red}, ${green}, ${blue})`
          : `rgba(${red}, ${green}, ${blue}, ${alpha / 255})`;
      };
      const root = getComputedStyle(document.documentElement);
      const body = getComputedStyle(document.body);
      const scrollbar = getComputedStyle(
        document.documentElement,
        "::-webkit-scrollbar",
      );
      const track = getComputedStyle(
        document.documentElement,
        "::-webkit-scrollbar-track",
      );

      return {
        bodyBackground: normalizeColor(body.backgroundColor),
        colorScheme: root.colorScheme,
        scrollbarBackground: normalizeColor(scrollbar.backgroundColor),
        trackBackground: normalizeColor(track.backgroundColor),
      };
    });

    logE2eEvent("dark-appearance.styles-observed", appearance);

    expect.soft(appearance.bodyBackground).toBe("rgb(24, 24, 24)");
    expect.soft(appearance.colorScheme).toBe("dark");
    expect.soft(appearance.scrollbarBackground).toBe("rgb(24, 24, 24)");
    expect.soft(appearance.trackBackground).toBe("rgb(24, 24, 24)");
  });
});
