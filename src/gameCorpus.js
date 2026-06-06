import { promises as fs } from "node:fs";
import path from "node:path";

const DATA_DIR = path.resolve(process.cwd(), "data");
const CORPUS_DIR = path.join(DATA_DIR, "corpus");

export function getCorpusPaths(username) {
  const player = sanitizePlayerName(username);
  const dir = path.join(CORPUS_DIR, player);

  return {
    dir,
    gamesJsonl: path.join(dir, "games.jsonl"),
    summaryJson: path.join(dir, "summary.json"),
    prototypeBrilliantsJsonl: path.join(dir, "prototype-brilliants.jsonl")
  };
}

export async function upsertCorpusGames(username, games, options = {}) {
  const items = Array.isArray(games) ? games : [];
  if (!items.length) return [];

  const paths = getCorpusPaths(username);
  await fs.mkdir(paths.dir, { recursive: true });

  const records = await readCorpusRecords(paths.gamesJsonl);
  const byKey = new Map(records.map((record) => [record.url || record.id, record]));

  for (const game of items) {
    const key = game?.url || game?.id;
    if (!key) continue;

    const previous = byKey.get(key) || {};
    byKey.set(key, mergeCorpusGame(previous, game, options));
  }

  const nextRecords = [...byKey.values()].sort((a, b) => {
    return Number(a.endTime || 0) - Number(b.endTime || 0) || String(a.url).localeCompare(String(b.url));
  });

  await writeJsonl(paths.gamesJsonl, nextRecords);
  await writeJson(paths.summaryJson, buildSummary(username, nextRecords));
  await writeJsonl(
    paths.prototypeBrilliantsJsonl,
    nextRecords.filter((record) => Number(record.prototype?.brilliantCount) > 0)
  );

  return nextRecords;
}

export async function readCorpusGames(username) {
  return readCorpusRecords(getCorpusPaths(username).gamesJsonl);
}

function mergeCorpusGame(previous, game, options) {
  const next = {
    ...previous,
    id: game.id || previous.id || game.url,
    url: game.url || previous.url || null,
    reviewUrl: game.reviewUrl || previous.reviewUrl || null,
    white: game.white || previous.white || "",
    black: game.black || previous.black || "",
    whiteRating: game.whiteRating ?? previous.whiteRating ?? null,
    blackRating: game.blackRating ?? previous.blackRating ?? null,
    userColor: game.userColor || previous.userColor || null,
    rules: game.rules || previous.rules || "unknown",
    timeClass: game.timeClass || previous.timeClass || "unknown",
    endTime: Number.isFinite(Number(game.endTime)) ? Number(game.endTime) : previous.endTime ?? null,
    pgn: game.pgn || previous.pgn || "",
    updatedAt: new Date().toISOString()
  };

  if (isPrototypeGame(game, options)) {
    next.prototype = {
      ...(previous.prototype || {}),
      source: options.source || previous.prototype?.source || "prototype",
      status: game.status || previous.prototype?.status || null,
      brilliantCount: Number.isFinite(Number(game.brilliantCount))
        ? Number(game.brilliantCount)
        : previous.prototype?.brilliantCount ?? null,
      brilliantMoves: Array.isArray(game.brilliantMoves)
        ? game.brilliantMoves
        : previous.prototype?.brilliantMoves || [],
      checkedAt: game.checkedAt || previous.prototype?.checkedAt || null,
      scrapeMethod: game.scrapeMethod || previous.prototype?.scrapeMethod || null,
      leftCount: game.leftCount ?? previous.prototype?.leftCount ?? null,
      rightCount: game.rightCount ?? previous.prototype?.rightCount ?? null,
      classificationTotal: game.classificationTotal ?? previous.prototype?.classificationTotal ?? null,
      error: game.status === "checked" || game.status === "skipped"
        ? game.error || null
        : game.error || previous.prototype?.error || null
    };
  }

  if (isLocalGame(game, options)) {
    next.local = {
      ...(previous.local || {}),
      source: "local",
      status: game.status || previous.local?.status || null,
      brilliantCount: Number.isFinite(Number(game.brilliantCount))
        ? Number(game.brilliantCount)
        : previous.local?.brilliantCount ?? null,
      brilliantMoves: Array.isArray(game.brilliantMoves)
        ? game.brilliantMoves
        : previous.local?.brilliantMoves || [],
      candidates: Array.isArray(game.candidates) ? game.candidates : previous.local?.candidates || [],
      rejectedCandidates: Array.isArray(game.rejectedCandidates)
        ? game.rejectedCandidates
        : previous.local?.rejectedCandidates || [],
      checkedAt: game.checkedAt || previous.local?.checkedAt || null,
      error: game.status === "checked" || game.status === "skipped"
        ? game.error || null
        : game.error || previous.local?.error || null
    };
  }

  return next;
}

function isPrototypeGame(game, options) {
  return (
    String(options.source || "").startsWith("prototype") ||
    Boolean(game.scrapeMethod) ||
    Number.isFinite(Number(game.leftCount)) ||
    Number.isFinite(Number(game.rightCount)) ||
    options.mode === "prototype"
  );
}

function isLocalGame(game, options) {
  return options.source === "local" || game.mode === "local";
}

async function readCorpusRecords(filePath) {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

async function writeJsonl(filePath, records) {
  const content = `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
  await writeAtomic(filePath, content);
}

async function writeJson(filePath, value) {
  await writeAtomic(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function writeAtomic(filePath, content) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmpFile = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmpFile, content, "utf8");
  await fs.rename(tmpFile, filePath);
}

function buildSummary(username, records) {
  const latest = records
    .filter((record) => Number.isFinite(Number(record.endTime)))
    .sort((a, b) => Number(b.endTime) - Number(a.endTime))[0];
  const prototypeBrilliants = records.filter((record) => Number(record.prototype?.brilliantCount) > 0);
  const localBrilliants = records.filter((record) => Number(record.local?.brilliantCount) > 0);
  const prototypeBrilliantMoveLabels = prototypeBrilliants.filter((record) => {
    return Array.isArray(record.prototype?.brilliantMoves) && record.prototype.brilliantMoves.length > 0;
  });

  return {
    username,
    updatedAt: new Date().toISOString(),
    totalGames: records.length,
    gamesWithPgn: records.filter((record) => Boolean(record.pgn)).length,
    prototypeChecked: records.filter((record) => record.prototype?.checkedAt).length,
    prototypeBrilliantGames: prototypeBrilliants.length,
    prototypeBrilliantMoves: prototypeBrilliants.reduce(
      (total, record) => total + (Number(record.prototype?.brilliantCount) || 0),
      0
    ),
    prototypeBrilliantMoveLabelGames: prototypeBrilliantMoveLabels.length,
    localChecked: records.filter((record) => record.local?.checkedAt).length,
    localCandidateGames: localBrilliants.length,
    localCandidateMoves: localBrilliants.reduce(
      (total, record) => total + (Number(record.local?.brilliantCount) || 0),
      0
    ),
    latestGame: latest
      ? {
          url: latest.url,
          white: latest.white,
          black: latest.black,
          endTime: latest.endTime,
          endTimeUtc: formatUtcTimestamp(latest.endTime)
        }
      : null
  };
}

function sanitizePlayerName(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function formatUtcTimestamp(timestamp) {
  if (!Number.isFinite(Number(timestamp))) return null;
  return new Date(Number(timestamp) * 1000).toISOString();
}
