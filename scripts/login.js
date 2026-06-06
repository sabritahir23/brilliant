import path from "node:path";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { chromium } from "playwright";

const profileDir = path.resolve(process.cwd(), "data", "chrome-profile");

const context = await chromium.launchPersistentContext(profileDir, {
  headless: false,
  viewport: { width: 1400, height: 950 },
  locale: "en-US"
});

const page = await context.newPage();
await page.goto("https://www.chess.com/login", { waitUntil: "domcontentloaded" });

const rl = readline.createInterface({ input, output });
await rl.question(
  "Log into Chess.com in the opened browser. When you are fully logged in, press Enter here to save the session..."
);
rl.close();

await context.close();
console.log("Login session saved in data/chrome-profile.");

