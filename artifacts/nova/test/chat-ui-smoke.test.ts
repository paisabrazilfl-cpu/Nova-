import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser } from "playwright-core";
import { createServer, type ViteDevServer } from "vite";

/**
 * Layout smoke test for the Nova chat UI (artifacts/nova/index.html).
 *
 * The redesign was originally verified by hand via screenshots. This drives a
 * real browser (the Replit-provided Chromium) against an in-process Vite dev
 * server and asserts the things a future edit to index.html / bob.js could
 * silently break:
 *   - the empty state renders
 *   - the composer accepts typed input
 *   - there is no horizontal overflow at 390 / 820 / 1280 widths
 *   - the mobile hamburger opens and closes the sidebar
 *
 * No LLM API key is required: the page renders and the composer works without
 * sending a real message.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const novaRoot = path.resolve(here, "..");

// Replit ships a Chromium binary for Playwright via this env var. When it is
// absent (e.g. a bare CI without it) the whole suite is skipped rather than
// failing on a missing browser.
const chromiumExecutable = process.env.REPLIT_PLAYWRIGHT_CHROMIUM_EXECUTABLE;

const VIEWPORTS = [
  { name: "mobile", width: 390, height: 844 },
  { name: "tablet", width: 820, height: 1180 },
  { name: "desktop", width: 1280, height: 800 },
] as const;

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

describe.skipIf(!chromiumExecutable)("Nova chat UI smoke", () => {
  let server: ViteDevServer;
  let browser: Browser;
  let baseURL: string;

  beforeAll(async () => {
    const port = await freePort();
    // vite.config.ts throws unless these are set; mirror the workflow contract.
    process.env.PORT = String(port);
    process.env.BASE_PATH = "/";
    server = await createServer({
      configFile: path.join(novaRoot, "vite.config.ts"),
      root: novaRoot,
      logLevel: "silent",
      server: { port, strictPort: true, host: "127.0.0.1" },
    });
    await server.listen(port);
    baseURL = `http://127.0.0.1:${port}/`;
    browser = await chromium.launch({
      executablePath: chromiumExecutable,
      headless: true,
      args: ["--no-sandbox"],
    });
  }, 120_000);

  afterAll(async () => {
    await browser?.close();
    await server?.close();
  });

  for (const vp of VIEWPORTS) {
    it(`renders, accepts input, and has no horizontal overflow at ${vp.name} (${vp.width}px)`, async () => {
      const page = await browser.newPage({
        viewport: { width: vp.width, height: vp.height },
      });
      try {
        await page.goto(baseURL, { waitUntil: "load", timeout: 30_000 });

        // Empty state renders.
        await page.locator("#empty-state").waitFor({
          state: "visible",
          timeout: 15_000,
        });

        // Composer accepts typed input (no message is sent).
        const input = page.locator("#user-input");
        await input.fill("hello nova");
        expect(await input.inputValue()).toBe("hello nova");

        // No horizontal overflow at this width.
        const { scrollW, innerW } = await page.evaluate(() => ({
          scrollW: Math.max(
            document.documentElement.scrollWidth,
            document.body.scrollWidth,
          ),
          innerW: window.innerWidth,
        }));
        expect(scrollW).toBeLessThanOrEqual(innerW + 1);
      } finally {
        await page.close();
      }
    }, 60_000);
  }

  it("mobile hamburger opens and closes the sidebar", async () => {
    const page = await browser.newPage({
      viewport: { width: 390, height: 844 },
    });
    try {
      await page.goto(baseURL, { waitUntil: "load", timeout: 30_000 });

      const sidebarOpen = () =>
        page.evaluate(
          () =>
            document.getElementById("sidebar")?.classList.contains("open") ??
            false,
        );

      // Hamburger is visible on mobile; sidebar starts closed.
      await page.locator("#hamburger").waitFor({ state: "visible" });
      expect(await sidebarOpen()).toBe(false);

      // Opens the sidebar.
      await page.locator("#hamburger").click();
      await page.waitForFunction(
        () =>
          document.getElementById("sidebar")?.classList.contains("open") ===
          true,
        undefined,
        { timeout: 5_000 },
      );

      // Closes it again via the backdrop overlay (the open sidebar covers the
      // hamburger, so it can't be re-clicked). Click the overlay to the right
      // of the 264px sidebar so the sidebar doesn't intercept the click.
      await page.locator("#sidebar-overlay").click({
        position: { x: 340, y: 420 },
      });
      await page.waitForFunction(
        () =>
          document.getElementById("sidebar")?.classList.contains("open") ===
          false,
        undefined,
        { timeout: 5_000 },
      );
    } finally {
      await page.close();
    }
  }, 60_000);
});
