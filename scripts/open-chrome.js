import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

const port = process.env.BRILLIANT_CDP_PORT || "9222";
const profileDir = path.resolve(process.cwd(), "data", "manual-chrome-profile");
const loginUrl = "https://www.chess.com/login";

const chromePath = findChrome();

if (!chromePath) {
  console.error("Could not find Google Chrome automatically.");
  console.error("Open Chrome manually with:");
  console.error(
    `chrome.exe --remote-debugging-port=${port} --user-data-dir="${profileDir}" ${loginUrl}`
  );
  process.exit(1);
}

const args = [
  `--remote-debugging-port=${port}`,
  `--user-data-dir=${profileDir}`,
  "--no-first-run",
  "--new-window",
  loginUrl
];

const child = spawn(chromePath, args, {
  detached: true,
  stdio: "ignore"
});

child.unref();

console.log("Opened regular Google Chrome for the scanner.");
console.log("1. Log into Chess.com in that Chrome window.");
console.log("2. Leave the Chrome window open.");
console.log("3. Start or resume the scan at http://localhost:5050.");

function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    path.join(process.env.PROGRAMFILES || "", "Google", "Chrome", "Application", "chrome.exe"),
    path.join(process.env["PROGRAMFILES(X86)"] || "", "Google", "Chrome", "Application", "chrome.exe"),
    path.join(process.env.LOCALAPPDATA || "", "Google", "Chrome", "Application", "chrome.exe")
  ].filter(Boolean);

  return candidates.find((candidate) => existsSync(candidate));
}

