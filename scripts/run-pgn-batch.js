import { promises as fs } from "node:fs";
import path from "node:path";
import {
  analyzePgnForBrilliancyCandidates,
  shouldVerifyBrilliancyCandidate
} from "../src/brilliancyCandidateFinder.js";
import { toReviewUrl } from "../src/chessCom.js";
import { getCorpusPaths, readCorpusGames, upsertCorpusGames } from "../src/gameCorpus.js";
import { buildPrototypeTruthLocal } from "../src/prototypeTruth.js";
import { closeStockfishAnalyzer, getStockfishAnalyzer } from "../src/stockfishAnalyzer.js";

const API_BASE = "https://api.chess.com/pub";
const USER_AGENT = "brilliant-scanner personal-use";
const DEFAULT_LIMIT = 1000;
const DEFAULT_EXCLUDE_TIME_CLASSES = ["bullet"];
const REPORTS_DIR = path.resolve(process.cwd(), "data", "reports");

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});

async function main() {
  const cli = parseArgs(process.argv.slice(2));
  if (cli.help) {
    printHelp();
    return;
  }

  const username = validateUsername(cli.username);
  const corpusPaths = getCorpusPaths(username);
  const statePath = path.join(corpusPaths.dir, "batch-state.json");
  const state = await readJsonIfExists(statePath);
  const options = resolveOptions(cli, state);

  console.log(
    `[pgn-batch] selecting up to ${options.limit} game(s) for ${username} from ${options.fromLabel}` +
      `${options.untilLabel ? ` until ${options.untilLabel} (exclusive)` : ""}`
  );

  const selection = await fetchBoundedGames(username, options);

  if (cli.dryRun) {
    printDryRun(username, options, selection);
    return;
  }

  if (selection.games.length === 0) {
    throw new Error("No eligible games were found for that batch window.");
  }

  const startedAt = new Date().toISOString();
  const batchId = createBatchId(startedAt);
  const reportPath = path.join(REPORTS_DIR, `pgn-batch-${sanitizeName(username)}-${batchId}.json`);
  const jsonlReportPath = path.join(
    REPORTS_DIR,
    `pgn-batch-${sanitizeName(username)}-${batchId}.jsonl`
  );
  const batch = {
    batchId,
    from: options.fromLabel,
    until: options.untilLabel,
    limit: options.limit,
    excludeTimeClasses: options.excludeTimeClasses,
    includeTimeClasses: options.includeTimeClasses,
    selectedGames: selection.games.length,
    analyzedGames: 0,
    skippedGames: selection.skippedGames,
    firstEndTime: selection.games[0]?.endTime || null,
    lastEndTime: selection.games.at(-1)?.endTime || null,
    firstGameUrl: selection.games[0]?.url || null,
    lastGameUrl: selection.games.at(-1)?.url || null,
    startedAt,
    finishedAt: null,
    status: "running",
    reportPath: path.relative(process.cwd(), reportPath),
    jsonlReportPath: path.relative(process.cwd(), jsonlReportPath),
    continuedAfterBatchId: options.continuedAfterBatchId,
    error: null
  };
  const nextState = appendBatchState(state, username, batch);
  const reportItems = [];

  try {
    await writeJson(statePath, nextState);
    await upsertCorpusGames(username, selection.games, { source: "chesscom-pgn" });
    const corpusByUrl = new Map(
      (await readCorpusGames(username)).map((record) => [record.url, record])
    );

    for (let index = 0; index < selection.games.length; index += 1) {
      const game = selection.games[index];
      const record = corpusByUrl.get(game.url) || game;
      console.log(
        `[pgn-batch] analyzing ${index + 1}/${selection.games.length}: ${game.white} vs ${game.black}`
      );

      const local = await analyzeGame(game, record);
      const analyzedGame = {
        ...game,
        mode: "local",
        ...local,
        rejectedCandidates: (local.rejectedCandidates || []).slice(0, 8)
      };

      await upsertCorpusGames(username, [analyzedGame], { source: "local" });
      reportItems.push(buildReportGame(game, local));
      batch.analyzedGames = countAnalyzed(reportItems);
      batch.skippedGames =
        selection.skippedGames +
        reportItems.filter((item) => item.localStatus === "skipped").length;
      await writeOutputs({
        username,
        options,
        selection,
        batch,
        state: nextState,
        statePath,
        reportPath,
        jsonlReportPath,
        reportItems
      });
    }

    batch.status = "completed";
    batch.finishedAt = new Date().toISOString();
    await writeOutputs({
      username,
      options,
      selection,
      batch,
      state: nextState,
      statePath,
      reportPath,
      jsonlReportPath,
      reportItems
    });

    const summary = buildSummary(selection, reportItems, options);
    console.log(
      `[pgn-batch] completed ${batchId}: analyzed=${summary.analyzedGames}, ` +
        `candidateGames=${summary.gamesWithLocalCandidates}, errors=${summary.errors}`
    );
    console.log(`[pgn-batch] report: ${batch.reportPath}`);
  } catch (error) {
    batch.status = "failed";
    batch.finishedAt = new Date().toISOString();
    batch.error = error.message;
    await writeOutputs({
      username,
      options,
      selection,
      batch,
      state: nextState,
      statePath,
      reportPath,
      jsonlReportPath,
      reportItems
    });
    throw error;
  } finally {
    await closeStockfishAnalyzer().catch(() => {});
  }
}

async function analyzeGame(game, record) {
  const prototypeTruth = buildPrototypeTruthLocal(record);
  if (prototypeTruth) return prototypeTruth;

  if (!isLocallyAnalyzable(game)) {
    return {
      status: "skipped",
      checkedAt: new Date().toISOString(),
      brilliantCount: 0,
      brilliantMoves: [],
      candidates: [],
      rejectedCandidates: [],
      error: game.pgn ? "Game is not locally analyzable." : "Missing PGN."
    };
  }

  try {
    const rawCandidates = analyzePgnForBrilliancyCandidates(game);
    const candidatesToVerify = rawCandidates.filter(shouldVerifyBrilliancyCandidate);
    const rejectedCandidates = rawCandidates
      .filter((candidate) => !shouldVerifyBrilliancyCandidate(candidate))
      .map((candidate) => ({
        ...candidate,
        verified: false,
        rejectedReason: "not a calibrated Chess.com-style brilliancy shape"
      }));
    const candidates = [];

    if (candidatesToVerify.length > 0) {
      const stockfish = await getStockfishAnalyzer();
      for (const candidate of candidatesToVerify) {
        const verified = await stockfish.verifyCandidate(candidate);
        if (verified.verified) candidates.push(verified);
        else rejectedCandidates.push(verified);
      }
    }

    return {
      status: "checked",
      checkedAt: new Date().toISOString(),
      brilliantCount: candidates.length,
      brilliantMoves: candidatesToBrilliantMoves(candidates),
      candidates,
      rejectedCandidates,
      error: null
    };
  } catch (error) {
    return {
      status: "error",
      checkedAt: new Date().toISOString(),
      brilliantCount: 0,
      brilliantMoves: [],
      candidates: [],
      rejectedCandidates: [],
      error: error.message
    };
  }
}

async function fetchBoundedGames(username, options) {
  const archiveIndex = await fetchJson(
    `${API_BASE}/player/${encodeURIComponent(username.toLowerCase())}/games/archives`
  );
  const archiveUrls = (archiveIndex.archives || [])
    .filter((archiveUrl) => archiveOverlapsWindow(archiveUrl, options))
    .sort(compareArchiveUrls);
  const games = [];
  let skippedGames = 0;

  for (let index = 0; index < archiveUrls.length && games.length < options.limit; index += 1) {
    const archiveUrl = archiveUrls[index];
    console.log(
      `[pgn-batch] fetching archive ${index + 1}/${archiveUrls.length}: ` +
        `${archiveUrl.split("/").slice(-2).join("/")}`
    );
    const archive = await fetchJson(archiveUrl);
    const archiveGames = (archive.games || [])
      .map((game) => normalizeGame(game, username))
      .filter((game) => game.endTime != null)
      .sort(compareGames);

    for (const game of archiveGames) {
      if (!isInsideWindow(game, options)) continue;
      if (!isAfterCursor(game, options.cursor)) continue;

      if (!isEligibleGame(game, options)) {
        skippedGames += 1;
        continue;
      }

      games.push(game);
      if (games.length >= options.limit) break;
    }
  }

  return { games, skippedGames };
}

function normalizeGame(game, username) {
  const normalizedUsername = username.toLowerCase();
  const white = game.white?.username || "";
  const black = game.black?.username || "";
  const userColor =
    white.toLowerCase() === normalizedUsername
      ? "white"
      : black.toLowerCase() === normalizedUsername
        ? "black"
        : null;
  const reviewUrl = toReviewUrl(game.url);

  return {
    id: game.uuid || game.url,
    url: game.url || null,
    reviewUrl,
    white,
    black,
    whiteRating: game.white?.rating ?? null,
    blackRating: game.black?.rating ?? null,
    userColor,
    rules: game.rules || "unknown",
    timeClass: game.time_class || "unknown",
    endTime: Number.isFinite(Number(game.end_time)) ? Number(game.end_time) : null,
    pgn: game.pgn || "",
    rated: Boolean(game.rated),
    status: "selected",
    brilliantCount: null,
    checkedAt: null,
    error: null
  };
}

function isEligibleGame(game, options) {
  if (game.rules !== "chess" || !game.userColor || !game.pgn || !game.reviewUrl) return false;

  const timeClass = String(game.timeClass || "unknown").toLowerCase();
  if (options.includeTimeClasses.length > 0 && !options.includeTimeClasses.includes(timeClass)) {
    return false;
  }

  return !options.excludeTimeClasses.includes(timeClass);
}

function isInsideWindow(game, options) {
  const endTime = Number(game.endTime);
  if (!Number.isFinite(endTime) || endTime < options.fromTimestamp) return false;
  return options.untilTimestamp == null || endTime < options.untilTimestamp;
}

function isAfterCursor(game, cursor) {
  if (!cursor) return true;
  if (game.endTime !== cursor.endTime) return game.endTime > cursor.endTime;
  return String(game.url || "").localeCompare(String(cursor.url || "")) > 0;
}

function archiveOverlapsWindow(archiveUrl, options) {
  const range = parseArchiveRange(archiveUrl);
  if (!range) return true;
  if (range.endTimestamp < options.fromTimestamp) return false;
  return options.untilTimestamp == null || range.startTimestamp < options.untilTimestamp;
}

function parseArchiveRange(archiveUrl) {
  const match = String(archiveUrl).match(/\/games\/(\d{4})\/(\d{1,2})$/);
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  if (!Number.isInteger(year) || !Number.isInteger(month)) return null;

  return {
    startTimestamp: Date.UTC(year, month - 1, 1) / 1000,
    endTimestamp: Date.UTC(year, month, 1) / 1000 - 1
  };
}

function compareArchiveUrls(a, b) {
  const aRange = parseArchiveRange(a);
  const bRange = parseArchiveRange(b);
  return Number(aRange?.startTimestamp || 0) - Number(bRange?.startTimestamp || 0);
}

function compareGames(a, b) {
  return Number(a.endTime || 0) - Number(b.endTime || 0) ||
    String(a.url || "").localeCompare(String(b.url || ""));
}

function resolveOptions(cli, state) {
  const previousBatch = cli.continue ? findLastCompletedBatch(state) : null;
  if (cli.continue && !previousBatch) {
    throw new Error("No completed batch exists for this username. Start with --from YYYY-MM-DD.");
  }

  const fromTimestamp = cli.continue
    ? Number(previousBatch.lastEndTime)
    : parseDate(cli.from, "--from");
  const inheritedUntil = cli.continue ? previousBatch.until : null;
  const untilLabel = cli.until || inheritedUntil || null;
  const untilTimestamp = untilLabel ? parseDate(untilLabel, "--until") : null;
  const excludeTimeClasses = cli.excludeWasSet
    ? cli.excludeTimeClasses
    : cli.continue && Array.isArray(previousBatch.excludeTimeClasses)
      ? normalizeTimeClasses(previousBatch.excludeTimeClasses)
      : DEFAULT_EXCLUDE_TIME_CLASSES;
  const includeTimeClasses = cli.includeWasSet
    ? cli.includeTimeClasses
    : cli.continue && Array.isArray(previousBatch.includeTimeClasses)
      ? normalizeTimeClasses(previousBatch.includeTimeClasses)
      : [];

  if (untilTimestamp != null && untilTimestamp <= fromTimestamp) {
    throw new Error("--until must be later than the batch starting point.");
  }

  return {
    fromTimestamp,
    fromLabel: cli.continue
      ? new Date(fromTimestamp * 1000).toISOString()
      : cli.from,
    untilTimestamp,
    untilLabel,
    limit: cli.limit,
    excludeTimeClasses,
    includeTimeClasses,
    cursor: previousBatch
      ? {
          endTime: Number(previousBatch.lastEndTime),
          url: previousBatch.lastGameUrl || ""
        }
      : null,
    continuedAfterBatchId: previousBatch?.batchId || null
  };
}

function parseArgs(args) {
  const options = {
    username: null,
    from: null,
    until: null,
    limit: DEFAULT_LIMIT,
    continue: false,
    dryRun: false,
    help: false,
    excludeTimeClasses: [],
    includeTimeClasses: [],
    excludeWasSet: false,
    includeWasSet: false
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg.startsWith("--")) {
      if (options.username) throw new Error(`Unexpected positional argument: ${arg}`);
      options.username = arg;
      continue;
    }

    const [name, inlineValue] = arg.split("=", 2);
    if (name === "--continue") {
      options.continue = true;
      continue;
    }
    if (name === "--dry-run") {
      options.dryRun = true;
      continue;
    }
    if (name === "--help") {
      options.help = true;
      continue;
    }

    const value = inlineValue ?? args[++index];
    if (!value || value.startsWith("--")) throw new Error(`${name} requires a value.`);

    if (name === "--from") options.from = value;
    else if (name === "--until") options.until = value;
    else if (name === "--limit") options.limit = parsePositiveInteger(value, "--limit");
    else if (name === "--exclude-time-class") {
      options.excludeWasSet = true;
      options.excludeTimeClasses.push(...splitTimeClasses(value));
    } else if (name === "--include-time-class") {
      options.includeWasSet = true;
      options.includeTimeClasses.push(...splitTimeClasses(value));
    } else {
      throw new Error(`Unknown option: ${name}`);
    }
  }

  options.excludeTimeClasses = normalizeTimeClasses(options.excludeTimeClasses);
  options.includeTimeClasses = normalizeTimeClasses(options.includeTimeClasses);

  if (!options.help && !options.username) throw new Error("A Chess.com username is required.");
  if (options.from && options.continue) throw new Error("Use either --from or --continue, not both.");
  if (!options.help && !options.from && !options.continue) {
    throw new Error("--from YYYY-MM-DD is required unless --continue is used.");
  }

  return options;
}

function buildReportGame(game, local) {
  const candidates = Array.isArray(local.candidates) ? local.candidates : [];
  const candidateMoves = (local.brilliantMoves || []).map((move) => ({
    moveNumber: move.moveNumber ?? null,
    ply: move.ply ?? null,
    san: move.san || null,
    lan: move.lan || null,
    score: Number.isFinite(Number(move.score)) ? Number(move.score) : null,
    source: move.source || "local",
    reasons: Array.isArray(move.reasons) ? move.reasons.slice(0, 5) : []
  }));

  return {
    url: game.url,
    reviewUrl: game.reviewUrl,
    white: game.white,
    black: game.black,
    userColor: game.userColor,
    endTime: game.endTime,
    timeClass: game.timeClass,
    rated: game.rated,
    status: game.status,
    localStatus: local.status,
    localCandidateCount: Number(local.brilliantCount) || 0,
    topLocalScore: candidates.length
      ? Math.max(...candidates.map((candidate) => Number(candidate.score) || 0))
      : null,
    candidateMoves,
    error: local.error || null
  };
}

function candidatesToBrilliantMoves(candidates) {
  return candidates.map((candidate) => ({
    moveNumber: candidate.moveNumber,
    ply: candidate.ply,
    san: candidate.san,
    lan: candidate.lan,
    color: candidate.userColor,
    source: "local",
    score: candidate.score,
    reasons: candidate.reasons || [],
    engine: candidate.engine || null
  }));
}

function buildSummary(selection, items, options) {
  return {
    selectedGames: selection.games.length,
    analyzedGames: countAnalyzed(items),
    gamesWithLocalCandidates: items.filter((item) => item.localCandidateCount > 0).length,
    localCandidateMoves: items.reduce(
      (total, item) => total + (Number(item.localCandidateCount) || 0),
      0
    ),
    skippedGames: selection.skippedGames + items.filter((item) => item.localStatus === "skipped").length,
    errors: items.filter((item) => item.localStatus === "error").length,
    firstEndTime: selection.games[0]?.endTime || null,
    lastEndTime: selection.games.at(-1)?.endTime || null,
    from: options.fromLabel,
    until: options.untilLabel
  };
}

async function writeOutputs({
  username,
  options,
  selection,
  batch,
  state,
  statePath,
  reportPath,
  jsonlReportPath,
  reportItems
}) {
  state.updatedAt = new Date().toISOString();
  Object.assign(
    state.batches.find((item) => item.batchId === batch.batchId),
    batch
  );
  await writeJson(statePath, state);
  await writeJson(reportPath, {
    username,
    batchId: batch.batchId,
    generatedAt: new Date().toISOString(),
    options: {
      from: options.fromLabel,
      until: options.untilLabel,
      untilBoundary: "exclusive",
      limit: options.limit,
      excludeTimeClasses: options.excludeTimeClasses,
      includeTimeClasses: options.includeTimeClasses,
      continuedAfterBatchId: options.continuedAfterBatchId
    },
    summary: buildSummary(selection, reportItems, options),
    games: reportItems
  });
  await writeJsonl(jsonlReportPath, reportItems);
}

function appendBatchState(state, username, batch) {
  const previous = state && typeof state === "object" ? state : {};
  return {
    username,
    updatedAt: new Date().toISOString(),
    defaultExcludeTimeClasses: DEFAULT_EXCLUDE_TIME_CLASSES,
    batches: [...(Array.isArray(previous.batches) ? previous.batches : []), batch]
  };
}

function findLastCompletedBatch(state) {
  const batches = Array.isArray(state?.batches) ? state.batches : [];
  for (let index = batches.length - 1; index >= 0; index -= 1) {
    const batch = batches[index];
    if (
      batch?.status === "completed" &&
      Number.isFinite(Number(batch.lastEndTime)) &&
      batch.lastGameUrl
    ) {
      return batch;
    }
  }
  return null;
}

function countAnalyzed(items) {
  return items.filter((item) => item.localStatus === "checked" || item.localStatus === "error").length;
}

function isLocallyAnalyzable(game) {
  return game?.rules === "chess" && Boolean(game.userColor) && Boolean(game.pgn);
}

async function fetchJson(url, attempts = 4) {
  let lastError;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: {
          "User-Agent": USER_AGENT,
          Accept: "application/json"
        }
      });

      if (response.status === 404) throw new Error("Chess.com user or archive not found.");
      if (response.status === 429) {
        const retryAfter = Number(response.headers.get("retry-after")) || attempt * 10;
        await sleep(retryAfter * 1000);
        continue;
      }
      if (!response.ok) throw new Error(`Chess.com API returned HTTP ${response.status}`);
      return response.json();
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await sleep(attempt * 1500);
    }
  }

  throw lastError;
}

async function readJsonIfExists(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function writeJson(filePath, value) {
  await writeAtomic(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function writeJsonl(filePath, values) {
  const content = values.length ? `${values.map((value) => JSON.stringify(value)).join("\n")}\n` : "";
  await writeAtomic(filePath, content);
}

async function writeAtomic(filePath, content) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temporaryPath, content, "utf8");
  await fs.rename(temporaryPath, filePath);
}

function parseDate(value, optionName) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ""))) {
    throw new Error(`${optionName} must use YYYY-MM-DD.`);
  }

  const timestamp = Date.parse(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString().slice(0, 10) !== value) {
    throw new Error(`${optionName} is not a valid calendar date.`);
  }
  return timestamp / 1000;
}

function parsePositiveInteger(value, optionName) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${optionName} must be a positive integer.`);
  }
  return parsed;
}

function splitTimeClasses(value) {
  return String(value)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeTimeClasses(values) {
  return [...new Set(values.map((value) => String(value).trim().toLowerCase()).filter(Boolean))];
}

function validateUsername(value) {
  const username = String(value || "").trim();
  if (!/^[a-zA-Z0-9_-]{2,40}$/.test(username)) {
    throw new Error("Enter a valid Chess.com username.");
  }
  return username;
}

function sanitizeName(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
}

function createBatchId(isoTimestamp) {
  return isoTimestamp.replace(/[-:.]/g, "");
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function printDryRun(username, options, selection) {
  console.log(
    JSON.stringify(
      {
        dryRun: true,
        username,
        options: {
          from: options.fromLabel,
          until: options.untilLabel,
          untilBoundary: "exclusive",
          limit: options.limit,
          excludeTimeClasses: options.excludeTimeClasses,
          includeTimeClasses: options.includeTimeClasses,
          continuedAfterBatchId: options.continuedAfterBatchId
        },
        selectedGames: selection.games.length,
        skippedGames: selection.skippedGames,
        games: selection.games.map((game) => ({
          url: game.url,
          white: game.white,
          black: game.black,
          endTime: game.endTime,
          timeClass: game.timeClass
        }))
      },
      null,
      2
    )
  );
}

function printHelp() {
  console.log(`Usage:
  node scripts/run-pgn-batch.js <username> --from YYYY-MM-DD [options]
  node scripts/run-pgn-batch.js <username> --continue [options]

Options:
  --from YYYY-MM-DD                 Inclusive UTC start date
  --until YYYY-MM-DD                Exclusive UTC end date
  --limit N                         Eligible game limit (default: 1000)
  --continue                        Continue after the last completed batch
  --exclude-time-class value        Repeatable or comma-separated (default: bullet)
  --include-time-class value        Optional repeatable or comma-separated allowlist
  --dry-run                         Select and print games without analysis or writes
  --help                            Show this help`);
}
