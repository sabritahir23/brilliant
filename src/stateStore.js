import { promises as fs } from "node:fs";
import path from "node:path";

const DATA_DIR = path.resolve(process.cwd(), "data");
const EXPORT_DIR = path.join(DATA_DIR, "exports");
const STATE_FILE = path.join(DATA_DIR, "state.json");
const STATE_BACKUP_FILE = path.join(DATA_DIR, "state.json.bak");
const TRANSIENT_WRITE_ERRORS = new Set(["EACCES", "EBUSY", "EPERM"]);
const WRITE_RETRY_COUNT = Number(process.env.BRILLIANT_STATE_WRITE_RETRIES) || 12;
const WRITE_RETRY_BASE_MS = Number(process.env.BRILLIANT_STATE_WRITE_RETRY_MS) || 75;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const createEmptyState = () => ({
  status: "idle",
  username: "",
  requestedAt: null,
  startedAt: null,
  finishedAt: null,
  updatedAt: new Date().toISOString(),
  message: "Ready.",
  currentIndex: 0,
  totalGames: 0,
  scanned: 0,
  found: 0,
  failed: 0,
  skipped: 0,
  currentGame: null,
  games: [],
  results: [],
  errors: []
});

export async function ensureDataDir() {
  await fs.mkdir(DATA_DIR, { recursive: true });
}

export async function readState() {
  await ensureDataDir();

  try {
    const raw = await fs.readFile(STATE_FILE, "utf8");
    return { ...createEmptyState(), ...JSON.parse(raw) };
  } catch (error) {
    if (error.code === "ENOENT") return createEmptyState();
    throw error;
  }
}

export async function writeState(nextState) {
  await ensureDataDir();
  const state = {
    ...nextState,
    updatedAt: new Date().toISOString()
  };
  const tmpFile = path.join(
    DATA_DIR,
    `state.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`
  );
  const content = `${JSON.stringify(state, null, 2)}\n`;

  await fs.writeFile(tmpFile, content, "utf8");

  try {
    await preserveCurrentState();
    await retryFileOperation(() => fs.rename(tmpFile, STATE_FILE));
  } catch (error) {
    if (!isTransientWriteError(error)) throw error;

    await retryFileOperation(() => fs.copyFile(tmpFile, STATE_FILE));
    await fs.unlink(tmpFile).catch(() => {});
  }

  await writeExportFiles(state);

  return state;
}

export async function resetState() {
  const state = createEmptyState();
  await writeState(state);
  return state;
}

async function preserveCurrentState() {
  try {
    await retryFileOperation(() => fs.copyFile(STATE_FILE, STATE_BACKUP_FILE));
  } catch {
    // A backup is useful, but it should not block saving fresh state.
  }
}

async function writeExportFiles(state) {
  const username = sanitizeFilePart(state.username);
  if (!username) return;

  const accountExportDir = path.join(EXPORT_DIR, username);
  await fs.mkdir(accountExportDir, { recursive: true });

  const results = Array.isArray(state.results) ? state.results : [];
  const errors = Array.isArray(state.errors) ? state.errors : [];

  await Promise.all([
    writeTextExport(
      path.join(accountExportDir, "brilliants.txt"),
      formatBrilliantsText(state, results)
    ),
    writeTextExport(
      path.join(accountExportDir, "errors.txt"),
      formatErrorsText(state, errors)
    ),
    writeTextExport(
      path.join(accountExportDir, "brilliants.jsonl"),
      formatJsonLines(results)
    ),
    writeTextExport(
      path.join(accountExportDir, "brilliant-moves.jsonl"),
      formatJsonLines(expandBrilliantMoves(results))
    ),
    writeTextExport(
      path.join(accountExportDir, "errors.jsonl"),
      formatJsonLines(errors)
    ),
    writeTextExport(
      path.join(accountExportDir, "progress.json"),
      `${JSON.stringify(formatProgress(state), null, 2)}\n`
    )
  ]);
}

async function writeTextExport(filePath, content) {
  const tmpFile = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmpFile, content, "utf8");

  try {
    await retryFileOperation(() => fs.rename(tmpFile, filePath));
  } catch (error) {
    if (!isTransientWriteError(error)) throw error;
    await retryFileOperation(() => fs.copyFile(tmpFile, filePath));
    await fs.unlink(tmpFile).catch(() => {});
  }
}

function formatBrilliantsText(state, results) {
  const lines = [
    `Brilliant games for ${state.username}`,
    `Updated: ${state.updatedAt}`,
    `Progress: ${state.scanned}/${state.totalGames} scanned, ${state.found} found, ${state.failed} errors`,
    ""
  ];

  if (results.length === 0) {
    lines.push("No brilliant games found yet.");
  } else {
    for (const [index, item] of results.entries()) {
      lines.push(
        `${index + 1}. ${item.white} vs ${item.black}`,
        `   Brilliant: ${item.brilliantCount}`,
        `   Color: ${item.userColor}`,
        `   Checked: ${item.checkedAt}`,
        `   Game: ${item.url}`,
        `   Review: ${item.reviewUrl}`,
        ...formatBrilliantMoveLines(item.brilliantMoves),
        ""
      );
    }
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

function formatErrorsText(state, errors) {
  const lines = [
    `Review errors for ${state.username}`,
    `Updated: ${state.updatedAt}`,
    `Progress: ${state.scanned}/${state.totalGames} scanned, ${state.found} found, ${state.failed} errors`,
    ""
  ];

  if (errors.length === 0) {
    lines.push("No errors yet.");
  } else {
    for (const item of errors) {
      lines.push(
        `Game ${item.index}`,
        `   Checked: ${item.checkedAt}`,
        `   Error: ${item.message}`,
        `   Game: ${item.url}`,
        `   Review: ${item.reviewUrl}`,
        ""
      );
    }
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

function formatJsonLines(items) {
  return `${items.map((item) => JSON.stringify(item)).join("\n")}\n`;
}

function expandBrilliantMoves(results) {
  return results.flatMap((item) => {
    const moves = Array.isArray(item.brilliantMoves) ? item.brilliantMoves : [];
    return moves.map((move) => ({
      url: item.url,
      reviewUrl: item.reviewUrl,
      white: item.white,
      black: item.black,
      userColor: item.userColor,
      checkedAt: item.checkedAt,
      ...move
    }));
  });
}

function formatBrilliantMoveLines(moves) {
  if (!Array.isArray(moves) || moves.length === 0) {
    return ["   Moves: not found in DOM"];
  }

  return [
    "   Moves:",
    ...moves.map((move) => {
      const number = move.moveNumber ? `${move.moveNumber}. ` : "";
      const context = move.contextText ? ` (${move.contextText})` : "";
      return `      - ${number}${move.san || "unknown"}${context}`;
    })
  ];
}

function formatProgress(state) {
  return {
    username: state.username,
    status: state.status,
    message: state.message,
    updatedAt: state.updatedAt,
    currentIndex: state.currentIndex,
    currentGameNumber: Number.isFinite(state.currentIndex) ? state.currentIndex + 1 : null,
    totalGames: state.totalGames,
    scanned: state.scanned,
    found: state.found,
    failed: state.failed,
    skipped: state.skipped,
    currentGame: state.currentGame
  };
}

function sanitizeFilePart(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

async function retryFileOperation(operation) {
  let lastError = null;

  for (let attempt = 0; attempt <= WRITE_RETRY_COUNT; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (!isTransientWriteError(error) || attempt === WRITE_RETRY_COUNT) break;
      await sleep(WRITE_RETRY_BASE_MS * (attempt + 1));
    }
  }

  throw lastError;
}

function isTransientWriteError(error) {
  return TRANSIENT_WRITE_ERRORS.has(error?.code);
}
