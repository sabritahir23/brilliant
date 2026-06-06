import path from "node:path";
import { chromium } from "playwright";

const PROFILE_DIR = path.resolve(process.cwd(), "data", "chrome-profile");
const DEFAULT_CDP_URL = "http://127.0.0.1:9222";

export async function createReviewBrowserContext(config) {
  const cdpUrl = process.env.BRILLIANT_CDP_URL || DEFAULT_CDP_URL;

  if (await isCdpAvailable(cdpUrl)) {
    const browser = await chromium.connectOverCDP(cdpUrl);
    const context = browser.contexts()[0];
    if (!context) {
      throw new Error("Connected to Chrome, but no browser context was available.");
    }

    return {
      context,
      mode: "attached-chrome",
      cleanup: async () => {
        // Leave the user's Chrome window open. Closing the CDP browser can close Chrome itself.
      }
    };
  }

  if (process.env.BRILLIANT_USE_PLAYWRIGHT_BROWSER === "true") {
    const context = await chromium.launchPersistentContext(PROFILE_DIR, {
      headless: config.headless,
      viewport: { width: 1600, height: 1050 },
      locale: "en-US"
    });

    return {
      context,
      mode: "playwright-browser",
      cleanup: async () => {
        await context.close().catch(() => {});
      }
    };
  }

  throw new Error(
    "Could not connect to normal Chrome on port 9222. Run `npm run chrome`, log into Chess.com in that Chrome window, leave it open, then start the scan again."
  );
}

async function isCdpAvailable(cdpUrl) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 750);
    const response = await fetch(`${cdpUrl.replace(/\/$/, "")}/json/version`, {
      signal: controller.signal
    });
    clearTimeout(timeout);
    return response.ok;
  } catch {
    return false;
  }
}

