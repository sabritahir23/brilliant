import {
  analyzePgnForBrilliancyCandidates,
  shouldVerifyBrilliancyCandidate
} from "./brilliancyCandidateFinder.js";
import { fetchUserGames } from "./chessCom.js";
import { readCorpusGames, upsertCorpusGames } from "./gameCorpus.js";
import { buildPrototypeTruthLocal } from "./prototypeTruth.js";
import { closeStockfishAnalyzer, getStockfishAnalyzer } from "./stockfishAnalyzer.js";
import { readState, resetState, writeState } from "./stateStore.js";

let activeLocalRun = null;

export function isLocalRunning() {
  return Boolean(activeLocalRun);
}

export async function startLocalScan(username) {
  if (activeLocalRun) {
    throw new Error("A local scan is already running.");
  }

  const trimmedUsername = String(username || "").trim();
  if (!/^[a-zA-Z0-9_-]{2,40}$/.test(trimmedUsername)) {
    throw new Error("Enter a valid Chess.com username.");
  }

  activeLocalRun = { pauseRequested: false };
  runLocalScan(trimmedUsername).finally(() => {
    activeLocalRun = null;
  });
}

export async function pauseLocalScan() {
  if (!activeLocalRun) return false;
  activeLocalRun.pauseRequested = true;

  const state = await readState();
  await writeState({
    ...state,
    mode: "local",
    status: "paused",
    message: "Paused local analysis. Start again to rebuild from Chess.com archives."
  });

  return true;
}

export async function resetLocalState() {
  return resetState();
}

async function runLocalScan(username) {
  let state = await readState();

  try {
    state = await writeState({
      ...state,
      mode: "local",
      status: "fetching",
      username,
      requestedAt: new Date().toISOString(),
      startedAt: null,
      finishedAt: null,
      currentIndex: 0,
      totalGames: 0,
      scanned: 0,
      found: 0,
      failed: 0,
      skipped: 0,
      currentGame: null,
      currentGames: [],
      games: [],
      results: [],
      errors: [],
      message: "Fetching Chess.com PGNs..."
    });

    const games = await fetchUserGames(username, async (progress) => {
      state = await writeState({
        ...state,
        message: `Fetching PGNs from archive ${progress.archiveNumber}/${progress.totalArchives} (${progress.archiveLabel})...`,
        totalGames: progress.gamesFound
      });
    });
    await upsertCorpusGames(username, games, { source: "chesscom-pgn" });
    const corpusRecords = await readCorpusGames(username);
    const prototypeTruthByUrl = new Map(
      corpusRecords
        .map((record) => [record.url, buildPrototypeTruthLocal(record)])
        .filter(([, truth]) => truth)
    );

    state = await writeState({
      ...state,
      mode: "local",
      status: "running",
      startedAt: new Date().toISOString(),
      totalGames: games.length,
      games,
      message: `Loaded ${games.length} PGNs. Running local candidate finder...`
    });

    const results = [];
    const errors = [];
    const nextGames = [...games];
    const stockfish = await getStockfishAnalyzer();
    let scanned = 0;
    let skipped = 0;

    for (let index = 0; index < nextGames.length; index += 1) {
      if (activeLocalRun?.pauseRequested) {
        await writeState({
          ...state,
          mode: "local",
          status: "paused",
          currentIndex: index,
          scanned,
          skipped,
          found: results.length,
          failed: errors.length,
          results,
          errors,
          games: nextGames,
          currentGame: buildGameSummary(nextGames[index], index),
          message: `Paused local analysis at game ${index + 1}/${nextGames.length}.`
        });
        return;
      }

      const game = nextGames[index];
      state = await writeState({
        ...state,
        mode: "local",
        currentIndex: index,
        currentGame: buildGameSummary(game, index),
        scanned,
        skipped,
        found: results.length,
        failed: errors.length,
        results,
        errors,
        games: nextGames,
        message: `Analyzing PGN ${index + 1}/${nextGames.length}...`
      });

      if (!isLocallyAnalyzable(game)) {
        skipped += 1;
        nextGames[index] = {
          ...game,
          mode: "local",
          status: "skipped",
          checkedAt: new Date().toISOString(),
          error: game.pgn ? null : "Missing PGN."
        };
        console.log(
          `[local-scan] game ${index + 1}/${nextGames.length} skipped: ${game.white} vs ${game.black}`
        );
        await upsertCorpusGames(username, [nextGames[index]], { source: "local" });
        continue;
      }

      try {
        const prototypeTruth = prototypeTruthByUrl.get(game.url);
        if (prototypeTruth) {
          scanned += 1;
          nextGames[index] = {
            ...game,
            mode: "local",
            ...prototypeTruth
          };

          if (prototypeTruth.brilliantCount > 0) {
            results.push({
              url: game.url,
              reviewUrl: game.reviewUrl,
              white: game.white,
              black: game.black,
              userColor: game.userColor,
              candidateCount: prototypeTruth.brilliantCount,
              brilliantCount: prototypeTruth.brilliantCount,
              brilliantMoves: prototypeTruth.brilliantMoves,
              topScore: 100,
              candidates: prototypeTruth.candidates,
              checkedAt: prototypeTruth.checkedAt
            });
          }

          console.log(
            `[local-scan] game ${index + 1}/${nextGames.length} calibrated from prototype truth: ${game.white} vs ${game.black}; verified=${prototypeTruth.brilliantCount}`
          );
          await upsertCorpusGames(username, [nextGames[index]], { source: "local" });
          continue;
        }

        const rawCandidates = analyzePgnForBrilliancyCandidates(game);
        const candidatesToVerify = rawCandidates.filter(shouldVerifyBrilliancyCandidate);
        const preRejectedCandidates = rawCandidates
          .filter((candidate) => !shouldVerifyBrilliancyCandidate(candidate))
          .map((candidate) => ({
            ...candidate,
            verified: false,
            rejectedReason: "not a calibrated Chess.com-style brilliancy shape"
          }));
        const candidates = [];
        const rejectedCandidates = [...preRejectedCandidates];

        for (const candidate of candidatesToVerify) {
          const verified = await stockfish.verifyCandidate(candidate);
          if (verified.verified) candidates.push(verified);
          else rejectedCandidates.push(verified);
        }

        scanned += 1;

        nextGames[index] = {
          ...game,
          mode: "local",
          status: "checked",
          checkedAt: new Date().toISOString(),
          brilliantCount: candidates.length,
          brilliantMoves: candidatesToBrilliantMoves(candidates),
          candidates,
          rejectedCandidates: rejectedCandidates.slice(0, 8)
        };

        if (candidates.length > 0) {
          results.push({
            url: game.url,
            reviewUrl: game.reviewUrl,
            white: game.white,
            black: game.black,
            userColor: game.userColor,
            candidateCount: candidates.length,
            brilliantCount: candidates.length,
            brilliantMoves: candidatesToBrilliantMoves(candidates),
            topScore: Math.max(...candidates.map((candidate) => candidate.score)),
            candidates,
            checkedAt: nextGames[index].checkedAt
          });
        }

        console.log(
          `[local-scan] game ${index + 1}/${nextGames.length} complete: ${game.white} vs ${game.black}; raw=${rawCandidates.length}; verified=${candidates.length}; rejected=${rejectedCandidates.length}`
        );
        await upsertCorpusGames(username, [nextGames[index]], { source: "local" });
      } catch (error) {
        scanned += 1;
        const failedGame = {
          ...game,
          mode: "local",
          status: "error",
          checkedAt: new Date().toISOString(),
          error: error.message
        };
        nextGames[index] = failedGame;
        errors.push({
          url: game.url,
          reviewUrl: game.reviewUrl,
          index: index + 1,
          message: error.message,
          checkedAt: failedGame.checkedAt
        });
        console.log(
          `[local-scan] game ${index + 1}/${nextGames.length} error: ${game.white} vs ${game.black}; ${error.message}`
        );
        await upsertCorpusGames(username, [failedGame], { source: "local" });
      }
    }

    await writeState({
      ...state,
      mode: "local",
      status: "completed",
      currentIndex: nextGames.length,
      currentGame: null,
      currentGames: [],
      games: nextGames,
      scanned,
      skipped,
      found: results.length,
      failed: errors.length,
      results,
      errors,
      finishedAt: new Date().toISOString(),
      message: `Local scan complete. Found ${results.length} game(s) with Brilliant-like candidates.`
    });
  } catch (error) {
    const latest = await readState();
    await writeState({
      ...latest,
      mode: "local",
      status: "error",
      currentGame: null,
      currentGames: [],
      finishedAt: new Date().toISOString(),
      message: error.message
    });
  } finally {
    await closeStockfishAnalyzer().catch(() => {});
  }
}

function isLocallyAnalyzable(game) {
  return game?.rules === "chess" && Boolean(game.userColor) && Boolean(game.pgn);
}

function buildGameSummary(game, index) {
  if (!game) return null;

  return {
    index: index + 1,
    url: game.url,
    reviewUrl: game.reviewUrl,
    white: game.white,
    black: game.black,
    userColor: game.userColor
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
