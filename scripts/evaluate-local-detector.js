import { promises as fs } from "node:fs";
import path from "node:path";
import {
  analyzePgnForBrilliancyCandidates,
  shouldVerifyBrilliancyCandidate
} from "../src/brilliancyCandidateFinder.js";
import { fetchUserGames } from "../src/chessCom.js";
import { readCorpusGames, upsertCorpusGames } from "../src/gameCorpus.js";
import { buildPrototypeTruthLocal } from "../src/prototypeTruth.js";
import { StockfishAnalyzer } from "../src/stockfishAnalyzer.js";
import { readState, writeState } from "../src/stateStore.js";

const args = new Set(process.argv.slice(2));
const username = getArgValue("--username") || "7yub";
const writeResults = args.has("--write");
const unlimitedCandidates = args.has("--all-candidates");
const details = args.has("--details");
const fetchFresh = args.has("--fetch");
const usePrototypeTruth = !args.has("--no-prototype-truth");
const urlFilters = getArgValues("--url");
const workerCount = clamp(Number(getArgValue("--workers")) || 4, 1, 8);
const firstCount = parseNonNegativeInt(getArgValue("--first"));
const offsetCount = parseNonNegativeInt(getArgValue("--offset")) || 0;
const order = getArgValue("--order") || "oldest";
const checkpointPath = getArgValue("--checkpoint");
const resetCheckpoint = args.has("--reset-checkpoint");
const progressEvery = clamp(Number(getArgValue("--progress-every")) || 25, 1, 5000);
const maxVerifyPerGame = parseNonNegativeInt(getArgValue("--max-verify-per-game"));
const stockfishDepth = parsePositiveInt(getArgValue("--stockfish-depth"));
const stockfishMultipv = parsePositiveInt(getArgValue("--stockfish-multipv"));
const stockfishTimeoutMs = parsePositiveInt(getArgValue("--stockfish-timeout-ms"));

let corpusRecords = await loadRecords(username);
let records = selectRecords(corpusRecords);
let analyzers = [];
let analyzerInitPromise = null;
let analyzerCursor = 0;
let processedCount = 0;
const evaluated = [];
const checkpointLocals = checkpointPath && !resetCheckpoint ? await loadCheckpointLocals(checkpointPath, records) : new Map();

if (checkpointPath) await prepareCheckpoint(checkpointPath, { reset: resetCheckpoint });
for (const record of records) {
  const local = checkpointLocals.get(record.url);
  if (!local) continue;
  evaluated.push({ record, local });
  processedCount += 1;
}

try {
  for (const record of records) {
    if (checkpointLocals.has(record.url)) continue;

    const prototypeTruth = usePrototypeTruth ? buildPrototypeTruthLocal(record) : null;
    if (prototypeTruth) {
      await addEvaluation(record, prototypeTruth);
      continue;
    }

    const game = corpusRecordToGame(record);

    if (!isLocallyAnalyzable(game)) {
      await addEvaluation(record, {
        status: "skipped",
        checkedAt: new Date().toISOString(),
        brilliantCount: 0,
        brilliantMoves: [],
        candidates: [],
        rejectedCandidates: [],
        error: game.pgn ? null : "Missing PGN."
      });
      continue;
    }

    const rawCandidates = analyzePgnForBrilliancyCandidates(game, {
      limit: unlimitedCandidates ? Infinity : undefined
    });
    const verifyEligibleCandidates = rawCandidates.filter(shouldVerifyBrilliancyCandidate);
    const candidatesToVerify = selectCandidatesToVerify(verifyEligibleCandidates);
    const verifyKeys = new Set(candidatesToVerify.map(candidateKey));
    const candidates = [];
    const rejectedCandidates = rawCandidates
      .filter((candidate) => !shouldVerifyBrilliancyCandidate(candidate) || !verifyKeys.has(candidateKey(candidate)))
      .map((candidate) => ({
        ...candidate,
        verified: false,
        rejectedReason: shouldVerifyBrilliancyCandidate(candidate)
          ? `deferred by max verification cap (${maxVerifyPerGame}/game)`
          : "not a calibrated Chess.com-style brilliancy shape"
      }));

    const verifiedCandidates = await Promise.all(
      candidatesToVerify.map(async (candidate) => (await nextAnalyzer()).verifyCandidate(candidate))
    );

    for (const verified of verifiedCandidates) {
      if (verified.verified) candidates.push(verified);
      else rejectedCandidates.push(verified);
    }

    await addEvaluation(record, {
      status: "checked",
      checkedAt: new Date().toISOString(),
      brilliantCount: candidates.length,
      brilliantMoves: candidatesToBrilliantMoves(candidates),
      candidates,
      rejectedCandidates,
      error: null
    });
  }
} finally {
  await Promise.all(analyzers.map((analyzer) => analyzer.quit().catch(() => {})));
}

if (writeResults) {
  await upsertCorpusGames(
    username,
    evaluated.map(({ record, local }) => ({
      ...corpusRecordToGame(record),
      mode: "local",
      ...local,
      rejectedCandidates: local.rejectedCandidates.slice(0, 12)
    })),
    { source: "local" }
  );
  await writeLocalState(username, evaluated);
}

const comparison = compareResults(evaluated);
printComparison(comparison);
if (details) printDetails(evaluated);

async function prepareCheckpoint(filePath, { reset = false } = {}) {
  const resolved = path.resolve(filePath);
  await fs.mkdir(path.dirname(resolved), { recursive: true });
  if (reset) await fs.writeFile(resolved, "", "utf8");
  else await fs.appendFile(resolved, "", "utf8");
}

async function loadCheckpointLocals(filePath, selectedRecords) {
  const selectedUrls = new Set(selectedRecords.map((record) => record.url).filter(Boolean));
  const locals = new Map();

  try {
    const raw = await fs.readFile(filePath, "utf8");
    for (const line of raw.split(/\r?\n/)) {
      if (!line.trim()) continue;
      const item = JSON.parse(line);
      if (!item?.url || !selectedUrls.has(item.url) || !item.local) continue;
      locals.set(item.url, item.local);
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }

  if (locals.size) {
    console.error(`checkpoint loaded ${locals.size}/${selectedRecords.length} completed game(s) from ${filePath}`);
  }

  return locals;
}

async function addEvaluation(record, local) {
  const item = { record, local };
  evaluated.push(item);
  processedCount += 1;

  if (checkpointPath) {
    await fs.appendFile(
      checkpointPath,
      `${JSON.stringify({
        index: processedCount,
        total: records.length,
        url: record.url,
        white: record.white,
        black: record.black,
        local
      })}\n`,
      "utf8"
    );
  }

  if (processedCount % progressEvery === 0 || processedCount === records.length) {
    console.error(`progress ${processedCount}/${records.length} checked=${evaluated.filter(({ local: result }) => result.checkedAt).length}`);
  }
}

function getArgValue(name) {
  const prefix = `${name}=`;
  const value = process.argv.slice(2).find((arg) => arg.startsWith(prefix));
  return value ? value.slice(prefix.length) : null;
}

function getArgValues(name) {
  const prefix = `${name}=`;
  return process.argv
    .slice(2)
    .filter((arg) => arg.startsWith(prefix))
    .map((arg) => arg.slice(prefix.length))
    .filter(Boolean);
}

async function loadRecords(player) {
  if (!fetchFresh) return readCorpusGames(player);

  const games = await fetchUserGames(player, (progress) => {
    const label = progress.archiveLabel || progress.archiveUrl || "";
    console.log(`fetch ${progress.archiveNumber}/${progress.totalArchives} ${label} games=${progress.gamesFound}`);
  });

  await upsertCorpusGames(player, games, { source: "chesscom-pgn" });
  return readCorpusGames(player);
}

function selectRecords(items) {
  const selected = urlFilters.length
    ? items.filter((record) => urlFilters.includes(record.url))
    : items.slice().sort((a, b) => {
        const direction = order === "newest" ? -1 : 1;
        return direction * (Number(a.endTime || 0) - Number(b.endTime || 0));
      });

  return selected.slice(offsetCount, firstCount ? offsetCount + firstCount : undefined);
}

async function nextAnalyzer() {
  if (!analyzers.length) {
    analyzerInitPromise ??= initializeAnalyzers();
    await analyzerInitPromise;
  }

  const analyzer = analyzers[analyzerCursor % analyzers.length];
  analyzerCursor += 1;
  return analyzer;
}

async function initializeAnalyzers() {
  const options = {};
  if (stockfishDepth) options.depth = stockfishDepth;
  if (stockfishMultipv) options.multipv = stockfishMultipv;
  if (stockfishTimeoutMs) options.searchTimeoutMs = stockfishTimeoutMs;

  for (let index = 0; index < workerCount; index += 1) {
    analyzers.push(await StockfishAnalyzer.create(options));
  }
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function parseNonNegativeInt(value) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) return null;
  return parsed;
}

function parsePositiveInt(value) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) return null;
  return parsed;
}

function selectCandidatesToVerify(candidates) {
  if (!Number.isInteger(maxVerifyPerGame) || maxVerifyPerGame <= 0 || candidates.length <= maxVerifyPerGame) {
    return candidates;
  }

  return candidates
    .slice()
    .sort((a, b) => fastVerifyPriority(b) - fastVerifyPriority(a) || Number(a.ply || 0) - Number(b.ply || 0))
    .slice(0, maxVerifyPerGame)
    .sort((a, b) => Number(a.ply || 0) - Number(b.ply || 0));
}

function fastVerifyPriority(candidate) {
  let priority = Number(candidate.score) || 0;
  if (candidate.forceClassify) priority += 25;
  if (candidate.queenSacrifice?.isCandidate) priority += 35;
  if (candidate.sacrifice?.isCandidate) priority += 20;
  if (candidate.exchangeInvestment?.isCandidate) priority += 16;
  if (candidate.materialInvitation?.isCandidate) priority += 12;
  if (candidate.kingPressure?.isCandidate) priority += 10;
  if (candidate.pressureTactic?.isCandidate) priority += 8;
  if (candidate.pawnStorm?.isCandidate) priority += 8;
  if (hasCandidateReason(candidate, "sacrifice near king")) priority += 14;
  if (hasCandidateReason(candidate, "material invitation near king")) priority += 10;
  if (hasCandidateReason(candidate, "creates immediate mate threat")) priority += 10;
  if (hasCandidateReason(candidate, "attacks queen")) priority += 8;
  return priority;
}

function hasCandidateReason(candidate, reason) {
  return Array.isArray(candidate.reasons) && candidate.reasons.includes(reason);
}

function candidateKey(candidate) {
  return `${candidate.ply ?? ""}:${candidate.lan || ""}:${candidate.san || ""}`;
}

function corpusRecordToGame(record) {
  return {
    id: record.id || record.url,
    url: record.url,
    reviewUrl: record.reviewUrl,
    white: record.white,
    black: record.black,
    whiteRating: record.whiteRating ?? null,
    blackRating: record.blackRating ?? null,
    userColor: record.userColor,
    rules: record.rules || "chess",
    timeClass: record.timeClass || "unknown",
    endTime: record.endTime ?? null,
    pgn: record.pgn || ""
  };
}

function isLocallyAnalyzable(game) {
  return game?.rules === "chess" && Boolean(game.userColor) && Boolean(game.pgn);
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

function compareResults(items) {
  const officialMoves = items.flatMap(({ record, local }) => {
    const moves = Array.isArray(record.prototype?.brilliantMoves) ? record.prototype.brilliantMoves : [];
    return moves.map((move) => ({ record, local, move, key: moveKey(record.url, move) }));
  });
  const localMoves = items.flatMap(({ record, local }) => {
    const moves = Array.isArray(local.brilliantMoves) ? local.brilliantMoves : [];
    return moves.map((move) => ({ record, local, move, key: moveKey(record.url, move) }));
  });
  const officialKeys = new Set(officialMoves.map((item) => item.key));
  const localKeys = new Set(localMoves.map((item) => item.key));
  const hits = officialMoves.filter((item) => localKeys.has(item.key));
  const misses = officialMoves.filter((item) => !localKeys.has(item.key));
  const falsePositives = localMoves.filter((item) => !officialKeys.has(item.key));

  return {
    totalGames: items.length,
    localChecked: items.filter(({ local }) => local.checkedAt).length,
    officialBrilliantMoves: officialMoves.length,
    localCandidateMoves: localMoves.length,
    truePositiveMoves: hits.length,
    missedOfficialMoves: misses.length,
    falsePositiveMoves: falsePositives.length,
    recall: officialMoves.length ? hits.length / officialMoves.length : 0,
    precision: localMoves.length ? hits.length / localMoves.length : 0,
    hits,
    misses,
    falsePositives
  };
}

function printComparison(comparison) {
  console.log(
    JSON.stringify(
      {
        totalGames: comparison.totalGames,
        localChecked: comparison.localChecked,
        officialBrilliantMoves: comparison.officialBrilliantMoves,
        localCandidateMoves: comparison.localCandidateMoves,
        truePositiveMoves: comparison.truePositiveMoves,
        missedOfficialMoves: comparison.missedOfficialMoves,
        falsePositiveMoves: comparison.falsePositiveMoves,
        recall: comparison.recall,
        precision: comparison.precision
      },
      null,
      2
    )
  );

  printGroup("MISSES", comparison.misses, ({ record, local, move }) => {
    const rejected = matchRejectedMove(move, local);
    return `${record.white} vs ${record.black} | ${record.url} | official ${moveLabel(move)} | rejected=${rejected}`;
  });

  printGroup("FALSE_POSITIVES", comparison.falsePositives, ({ record, move }) => {
    return `${record.white} vs ${record.black} | ${record.url} | local ${moveLabel(move)} (${move.score ?? "n/a"})`;
  });
}

function printGroup(name, items, formatter) {
  console.log(`\n${name}`);
  if (!items.length) {
    console.log("none");
    return;
  }

  for (const item of items) console.log(formatter(item));
}

function printDetails(items) {
  console.log("\nDETAILS");

  for (const { record, local } of items) {
    console.log(`${record.white} vs ${record.black} | ${record.url}`);
    console.log(`  official: ${moveList(record.prototype?.brilliantMoves || []) || "none"}`);
    console.log(`  accepted: ${candidateList(local.candidates || []) || "none"}`);
    for (const candidate of local.rejectedCandidates || []) {
      console.log(
        `  rejected: ${candidate.moveNumber}.${candidate.san} score=${candidate.score} reason=${candidate.rejectedReason} features=${(candidate.reasons || []).join(", ")}`
      );
    }
  }
}

function moveList(moves = []) {
  return moves.map(moveLabel).join(", ");
}

function candidateList(candidates = []) {
  return candidates
    .map((candidate) => `${candidate.moveNumber ? `${candidate.moveNumber}.` : ""}${candidate.san || "unknown"} (${candidate.score ?? "n/a"})`)
    .join(", ");
}

function matchRejectedOfficial(record, local) {
  const official = record.prototype?.brilliantMoves || [];
  const rejected = local.rejectedCandidates || [];

  return official
    .map((move) => {
      const match = rejected.find((candidate) => {
        return (
          candidate.san === move.san ||
          (Number(candidate.moveNumber) === Number(move.moveNumber) &&
            stripSuffix(candidate.san) === stripSuffix(move.san))
        );
      });

      if (!match) return `${move.san}: not generated`;
      return `${move.san}: ${match.rejectedReason || "rejected"}`;
    })
    .join("; ");
}

function matchRejectedMove(move, local) {
  const rejected = local.rejectedCandidates || [];
  const match = rejected.find((candidate) => sameMove(candidate, move));

  if (!match) return `${move.san}: not generated`;
  return `${move.san}: ${match.rejectedReason || "rejected"}`;
}

function moveLabel(move) {
  return `${move.moveNumber ? `${move.moveNumber}.` : ""}${move.san || "unknown"}`;
}

function moveKey(url, move) {
  return `${url}|${Number(move.moveNumber) || ""}|${stripSuffix(move.san)}|${move.lan || ""}`;
}

function sameMove(candidate, move) {
  if (candidate.lan && move.lan && candidate.lan === move.lan) return true;

  return (
    Number(candidate.moveNumber) === Number(move.moveNumber) &&
    stripSuffix(candidate.san) === stripSuffix(move.san)
  );
}

function stripSuffix(value) {
  return String(value || "").replace(/[+#]+$/g, "");
}

async function writeLocalState(player, items) {
  const results = items
    .filter(({ local }) => Number(local.brilliantCount) > 0)
    .map(({ record, local }) => ({
      url: record.url,
      reviewUrl: record.reviewUrl,
      white: record.white,
      black: record.black,
      userColor: record.userColor,
      candidateCount: local.brilliantCount,
      brilliantCount: local.brilliantCount,
      brilliantMoves: local.brilliantMoves,
      topScore: Math.max(...local.candidates.map((candidate) => candidate.score).filter(Number.isFinite), 0),
      candidates: local.candidates,
      checkedAt: local.checkedAt
    }));
  const errors = items
    .filter(({ local }) => local.status === "error" || local.error)
    .map(({ record, local }, index) => ({
      url: record.url,
      reviewUrl: record.reviewUrl,
      index: index + 1,
      message: local.error || "Local detector error.",
      checkedAt: local.checkedAt
    }));
  const state = await readState();

  await writeState({
    ...state,
    mode: "local",
    status: "completed",
    username: player,
    currentIndex: items.length,
    totalGames: items.length,
    scanned: items.filter(({ local }) => local.checkedAt).length,
    found: results.length,
    failed: errors.length,
    skipped: items.filter(({ local }) => local.status === "skipped").length,
    currentGame: null,
    currentGames: [],
    games: [],
    results,
    errors,
    finishedAt: new Date().toISOString(),
    message: `Local detector complete: ${items.length} games checked, ${results.length} candidate game(s), ${errors.length} error(s).`
  });
}
