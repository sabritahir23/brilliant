import { promises as fs } from "node:fs";
import path from "node:path";
import { createReviewBrowserContext } from "./browserProvider.js";
import { fetchUserGames } from "./chessCom.js";
import { readCorpusGames, upsertCorpusGames } from "./gameCorpus.js";
import { checkGameReview } from "./reviewScraper.js";
import { readState, writeState } from "./stateStore.js";

const DEFAULT_DELAY_MS = 1000;
const DEFAULT_CONCURRENCY = 5;
const MAX_CONCURRENCY = 10;
const DEFAULT_REFERENCE_DIR = path.resolve(process.cwd(), "data", "reference");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let activeRun = null;

function getRuntimeConfig() {
  return {
    delayMs: Number(process.env.BRILLIANT_DELAY_MS) || DEFAULT_DELAY_MS,
    concurrency: clamp(
      Number(process.env.BRILLIANT_CONCURRENCY) || DEFAULT_CONCURRENCY,
      1,
      MAX_CONCURRENCY
    ),
    headless: process.env.BRILLIANT_HEADLESS === "true"
  };
}

export function isRunning() {
  return Boolean(activeRun);
}

export async function startScan(username, options = {}) {
  if (activeRun) {
    throw new Error("A scan is already running.");
  }

  const trimmedUsername = String(username || "").trim();
  if (!/^[a-zA-Z0-9_-]{2,40}$/.test(trimmedUsername)) {
    throw new Error("Enter a valid Chess.com username.");
  }

  activeRun = {
    pauseRequested: false,
    currentPages: new Map()
  };

  runScan(trimmedUsername, options).finally(() => {
    activeRun = null;
  });
}

export async function startKnownBrilliantMoveScan() {
  if (activeRun) {
    throw new Error("A scan is already running.");
  }

  const state = await readState();
  const username = String(state.username || "").trim();
  const games = Array.isArray(state.games) ? state.games : [];
  const targetGames = games.filter((game) => Number(game?.brilliantCount) > 0 && game.reviewUrl);

  if (!username) {
    throw new Error("No saved username found. Run the prototype scanner once first.");
  }

  if (targetGames.length === 0) {
    throw new Error("No saved Brilliant games found. Run the prototype scanner once first.");
  }

  activeRun = {
    pauseRequested: false,
    currentPages: new Map()
  };

  runKnownBrilliantMoveScan(username, targetGames).finally(() => {
    activeRun = null;
  });
}

export async function startCorpusPrototypeMoveScan(username) {
  if (activeRun) {
    throw new Error("A scan is already running.");
  }

  const trimmedUsername = String(username || "").trim();
  if (!/^[a-zA-Z0-9_-]{2,40}$/.test(trimmedUsername)) {
    throw new Error("Enter a valid Chess.com username.");
  }

  const records = await readCorpusGames(trimmedUsername);
  const targetGames = records
    .filter((record) => {
      const brilliantCount = Number(record.prototype?.brilliantCount);
      const brilliantMoves = Array.isArray(record.prototype?.brilliantMoves)
        ? record.prototype.brilliantMoves
        : [];
      return brilliantCount > 0 && brilliantMoves.length === 0 && record.reviewUrl;
    })
    .map(corpusRecordToGame);

  if (targetGames.length === 0) {
    throw new Error("No corpus prototype Brilliant games need move labels.");
  }

  activeRun = {
    pauseRequested: false,
    currentPages: new Map()
  };

  runKnownBrilliantMoveScan(trimmedUsername, targetGames).finally(() => {
    activeRun = null;
  });
}

export async function startCorpusPrototypeErrorRetryScan(username) {
  if (activeRun) {
    throw new Error("A scan is already running.");
  }

  const trimmedUsername = String(username || "").trim();
  if (!/^[a-zA-Z0-9_-]{2,40}$/.test(trimmedUsername)) {
    throw new Error("Enter a valid Chess.com username.");
  }

  const records = await readCorpusGames(trimmedUsername);
  const targetGames = records
    .filter((record) => {
      const status = record.prototype?.status;
      return (status === "error" || Boolean(record.prototype?.error)) && record.reviewUrl;
    })
    .sort((a, b) => Number(a.endTime || 0) - Number(b.endTime || 0))
    .map(corpusRecordToGame);

  if (targetGames.length === 0) {
    throw new Error("No saved official review errors to retry.");
  }

  activeRun = {
    pauseRequested: false,
    currentPages: new Map()
  };

  runPrototypeErrorRetryScan(trimmedUsername, targetGames).finally(() => {
    activeRun = null;
  });
}

export async function startCorpusPrototypeWindowScan(username, options = {}) {
  if (activeRun) {
    throw new Error("A scan is already running.");
  }

  const trimmedUsername = String(username || "").trim();
  if (!/^[a-zA-Z0-9_-]{2,40}$/.test(trimmedUsername)) {
    throw new Error("Enter a valid Chess.com username.");
  }

  const windowOptions = normalizeWindowOptions(options);
  const records = await readCorpusGames(trimmedUsername);
  const window = resolveCorpusWindow(records, windowOptions);
  const windowRecords = window.records;

  if (windowRecords.length === 0) {
    throw new Error("No corpus games found for that official review window.");
  }

  activeRun = {
    pauseRequested: false,
    currentPages: new Map()
  };

  runPrototypeWindowScan(trimmedUsername, windowRecords, windowRecords, {
    ...window.options,
    mode: "prototype-window",
    retryErrors: false
  }).finally(() => {
    activeRun = null;
  });
}

export async function startCorpusPrototypeWindowErrorRetryScan(username, options = {}) {
  if (activeRun) {
    throw new Error("A scan is already running.");
  }

  const trimmedUsername = String(username || "").trim();
  if (!/^[a-zA-Z0-9_-]{2,40}$/.test(trimmedUsername)) {
    throw new Error("Enter a valid Chess.com username.");
  }

  const windowOptions = normalizeWindowOptions(options);
  const records = await readCorpusGames(trimmedUsername);
  const window = resolveCorpusWindow(records, windowOptions);
  const windowRecords = window.records;
  const errorRecords = windowRecords.filter((record) => {
    return (record.prototype?.status === "error" || Boolean(record.prototype?.error)) && record.reviewUrl;
  });

  if (errorRecords.length === 0) {
    throw new Error("No saved official review errors in that window.");
  }

  activeRun = {
    pauseRequested: false,
    currentPages: new Map()
  };

  runPrototypeWindowScan(trimmedUsername, windowRecords, errorRecords, {
    ...window.options,
    mode: "prototype-window-retry-errors",
    retryErrors: true
  }).finally(() => {
    activeRun = null;
  });
}

export async function startPrototypeSinceReference(username, options = {}) {
  if (activeRun) {
    throw new Error("A scan is already running.");
  }

  const trimmedUsername = String(username || "").trim();
  if (!/^[a-zA-Z0-9_-]{2,40}$/.test(trimmedUsername)) {
    throw new Error("Enter a valid Chess.com username.");
  }

  activeRun = {
    pauseRequested: false,
    currentPages: new Map()
  };

  runPrototypeSinceReference(trimmedUsername, options).finally(() => {
    activeRun = null;
  });
}

async function runPrototypeSinceReference(username, options = {}) {
  const config = getRuntimeConfig();
  let state = await readState();

  try {
    const reference = await loadReferenceState(username, options.referencePath);
    await upsertCorpusGames(username, reference.games || [], { source: "prototype-reference" });
    const corpusRecords = await readCorpusGames(username);
    const baseline = summarizePrototypeCorpus(username, corpusRecords, reference);

    state = await writeState({
      ...state,
      status: "fetching",
      mode: "prototype-incremental",
      username,
      requestedAt: new Date().toISOString(),
      startedAt: null,
      finishedAt: null,
      message: `Fetching games after prototype baseline ${formatUtcTimestamp(baseline.latestEndTime)}...`,
      currentIndex: 0,
      totalGames: 0,
      scanned: 0,
      found: baseline.results.length,
      failed: 0,
      skipped: 0,
      currentGame: null,
      currentGames: [],
      games: [],
      results: baseline.results,
      errors: [],
      baseline: baseline.state
    });

    const games = await fetchUserGames(
      username,
      async (progress) => {
        state = await writeState({
          ...state,
          message: `Fetching archive ${progress.archiveNumber}/${progress.totalArchives} since prototype baseline...`,
          totalGames: progress.gamesFound
        });
      },
      { sinceEndTime: baseline.latestEndTime }
    );
    const alreadyPrototypeChecked = new Set(baseline.checkedUrls);
    const targetGames = games
      .filter((game) => {
        const endTime = Number(game.endTime);
        return Number.isFinite(endTime) && endTime > baseline.latestEndTime && !alreadyPrototypeChecked.has(game.url);
      })
      .sort((a, b) => Number(a.endTime || 0) - Number(b.endTime || 0));
    await upsertCorpusGames(username, targetGames, { source: "chesscom-pgn" });

    state = await writeState({
      ...state,
      status: targetGames.length > 0 ? "running" : "completed",
      startedAt: targetGames.length > 0 ? new Date().toISOString() : null,
      finishedAt: targetGames.length > 0 ? null : new Date().toISOString(),
      message:
        targetGames.length > 0
          ? `Loaded ${targetGames.length} new game(s). Starting prototype review scan from the corpus baseline...`
          : `No new games found after prototype baseline ${formatUtcTimestamp(baseline.latestEndTime)}.`,
      totalGames: targetGames.length,
      skipped: 0,
      games: targetGames,
      results: baseline.results,
      errors: [],
      baseline: {
        ...baseline.state,
        newGamesFound: targetGames.length
      }
    });

    if (targetGames.length === 0) return;

    const browserSession = await createReviewBrowserContext(config);
    const { context } = browserSession;

    state = await writeState({
      ...state,
      message: `Using ${browserSession.mode}. Checking ${targetGames.length} new game(s) after ${formatUtcTimestamp(baseline.latestEndTime)}...`
    });

    try {
      const result = await scanWithWorkers(context, username, config, state);
      state = result.state;

      if (result.paused) return;
    } finally {
      await browserSession.cleanup();
    }

    await writeState({
      ...state,
      status: "completed",
      currentGame: null,
      currentGames: [],
      finishedAt: new Date().toISOString(),
      message: `Prototype incremental scan complete. Checked ${targetGames.length} new game(s); total prototype Brilliant games now ${state.results.length}.`
    });
  } catch (error) {
    const latest = await readState();
    await writeState({
      ...latest,
      status: "error",
      currentGame: null,
      currentGames: [],
      finishedAt: new Date().toISOString(),
      message: error.message
    });
  }
}

async function runPrototypeWindowScan(username, windowRecords, targetRecords, options = {}) {
  const config = getRuntimeConfig();
  let state = await readState();
  const mode = options.mode || "prototype-window";
  const targetGames = targetRecords.map((record) => corpusRecordToGame(record, {
    forcePending: Boolean(options.retryErrors),
    preservePrototypeStatus: !options.retryErrors
  }));
  const initialResults = buildPrototypeResults(windowRecords);
  const initialErrors = buildPrototypeErrors(targetGames);
  const initiallyFinished = targetGames.filter(isFinishedGame).length;
  const pendingCount = targetGames.length - initiallyFinished;

  try {
    state = await writeState({
      ...state,
      status: pendingCount > 0 ? "running" : "completed",
      mode,
      username,
      requestedAt: new Date().toISOString(),
      startedAt: pendingCount > 0 ? new Date().toISOString() : null,
      finishedAt: pendingCount > 0 ? null : new Date().toISOString(),
      currentIndex: 0,
      totalGames: targetGames.length,
      scanned: initiallyFinished,
      found: initialResults.length,
      failed: initialErrors.length,
      skipped: targetGames.filter((game) => game.status === "skipped" && game.checkedAt).length,
      currentGame: targetGames[0] ? buildGameSummary(targetGames[0], 0) : null,
      currentGames: [],
      games: targetGames,
      results: initialResults,
      errors: initialErrors,
      baseline: buildPrototypeWindowState(username, windowRecords, options),
      message:
        pendingCount > 0
          ? `Checking ${pendingCount} official review game(s) in ${formatWindowLabel(options)}...`
          : `${formatWindowLabel(options)} already has no pending official review games.`
    });

    if (pendingCount === 0) return;

    const browserSession = await createReviewBrowserContext(config);
    const { context } = browserSession;

    state = await writeState({
      ...state,
      message: `Using ${browserSession.mode}. Checking ${pendingCount} official review game(s) in ${formatWindowLabel(options)}...`
    });

    try {
      const result = await scanWithWorkers(context, username, config, state);
      state = result.state;

      if (result.paused) return;
    } finally {
      await browserSession.cleanup();
    }

    await writeState({
      ...state,
      status: "completed",
      currentGame: null,
      currentGames: [],
      finishedAt: new Date().toISOString(),
      message: `Official review window complete. Checked ${targetGames.length} game(s); found ${state.results.length} Brilliant game(s), ${state.failed} error(s).`
    });
  } catch (error) {
    const latest = await readState();
    await writeState({
      ...latest,
      status: "error",
      currentGame: null,
      currentGames: [],
      finishedAt: new Date().toISOString(),
      message: error.message
    });
  }
}

async function runPrototypeErrorRetryScan(username, targetGames) {
  const config = getRuntimeConfig();
  let state = await readState();

  try {
    const corpusRecords = await readCorpusGames(username);
    const baseline = summarizePrototypeCorpus(username, corpusRecords, {
      referencePath: null,
      games: [],
      results: [],
      errors: []
    });
    const seededErrors = targetGames.map((game, index) => ({
      url: game.url,
      reviewUrl: game.reviewUrl,
      index: index + 1,
      message: game.error || "Previous official review error.",
      checkedAt: game.checkedAt || null
    }));

    state = await writeState({
      ...state,
      status: "running",
      mode: "prototype-retry-errors",
      username,
      requestedAt: new Date().toISOString(),
      startedAt: new Date().toISOString(),
      finishedAt: null,
      currentIndex: 0,
      totalGames: targetGames.length,
      scanned: 0,
      found: baseline.results.length,
      failed: seededErrors.length,
      skipped: 0,
      currentGame: targetGames[0] ? buildGameSummary(targetGames[0], 0) : null,
      currentGames: [],
      games: targetGames,
      results: baseline.results,
      errors: seededErrors,
      baseline: baseline.state,
      message: `Retrying ${targetGames.length} saved official review error(s)...`
    });

    const browserSession = await createReviewBrowserContext(config);
    const { context } = browserSession;

    state = await writeState({
      ...state,
      message: `Using ${browserSession.mode}. Retrying ${targetGames.length} saved official review error(s)...`
    });

    try {
      const result = await scanWithWorkers(context, username, config, state);
      state = result.state;

      if (result.paused) return;
    } finally {
      await browserSession.cleanup();
    }

    await writeState({
      ...state,
      status: "completed",
      currentGame: null,
      currentGames: [],
      finishedAt: new Date().toISOString(),
      message: `Official review error retry complete. Retried ${targetGames.length} game(s); ${state.failed} error(s) remain in this retry run.`
    });
  } catch (error) {
    const latest = await readState();
    await writeState({
      ...latest,
      status: "error",
      currentGame: null,
      currentGames: [],
      finishedAt: new Date().toISOString(),
      message: error.message
    });
  }
}

async function runKnownBrilliantMoveScan(username, targetGames) {
  const config = {
    ...getRuntimeConfig(),
    concurrency: 1
  };
  let state = await readState();

  try {
    const browserSession = await createReviewBrowserContext(config);
    const { context } = browserSession;

    state = await writeState({
      ...state,
      status: "running",
      mode: "prototype-move-labels",
      currentIndex: 0,
      totalGames: targetGames.length,
      scanned: 0,
      found: state.results?.length || 0,
      failed: 0,
      errors: [],
      message: `Scanning ${targetGames.length} saved Brilliant game(s) for exact move labels...`
    });

    try {
      const results = [];
      const errors = [];

      for (let index = 0; index < targetGames.length; index += 1) {
        if (activeRun?.pauseRequested) break;

        const game = targetGames[index];
        state = await writeState({
          ...state,
          currentIndex: index,
          currentGame: buildGameSummary(game, index),
          scanned: index,
          results,
          errors,
          failed: errors.length,
          message: `Checking Brilliant move labels ${index + 1}/${targetGames.length}...`
        });

        try {
          const review = await checkGameReview(context, game, username, {
            shouldPause: () => Boolean(activeRun?.pauseRequested),
            onPage: (page) => {
              if (!activeRun) return;
              if (page) activeRun.currentPages.set(index, page);
              else activeRun.currentPages.delete(index);
            }
          });

          const checkedAt = new Date().toISOString();
          const checkedGame = {
            ...game,
            status: "checked",
            brilliantCount: review.brilliantCount,
            brilliantMoves: review.brilliantMoves || [],
            checkedAt,
            scrapeMethod: review.method,
            error: null
          };

          results.push(upsertMoveLabelResult(checkedGame));
          await upsertCorpusGames(username, [checkedGame], { source: "prototype" });
          console.log(
            `[prototype-moves] game ${index + 1}/${targetGames.length} complete: ${game.white} vs ${game.black}; moves=${checkedGame.brilliantMoves.length}`
          );
        } catch (error) {
          const failedGame = {
            ...game,
            status: "error",
            checkedAt: new Date().toISOString(),
            error: error.message
          };
          await upsertCorpusGames(username, [failedGame], { source: "prototype" });
          errors.push({
            url: game.url,
            reviewUrl: game.reviewUrl,
            index: index + 1,
            message: error.message,
            checkedAt: new Date().toISOString()
          });
          console.log(
            `[prototype-moves] game ${index + 1}/${targetGames.length} error: ${game.white} vs ${game.black}; ${error.message}`
          );
        }

        state = await writeState({
          ...state,
          scanned: index + 1,
          results,
          errors,
          found: results.length,
          failed: errors.length
        });
      }
    } finally {
      await browserSession.cleanup();
    }

    const latest = await readState();
    await writeState({
      ...latest,
      status: "completed",
      currentIndex: targetGames.length,
      currentGame: null,
      currentGames: [],
      finishedAt: new Date().toISOString(),
      message: `Move-label scan complete. Checked ${targetGames.length} saved Brilliant game(s).`
    });
  } catch (error) {
    const latest = await readState();
    await writeState({
      ...latest,
      status: "error",
      currentGame: null,
      currentGames: [],
      finishedAt: new Date().toISOString(),
      message: error.message
    });
  }
}

export async function pauseScan() {
  if (!activeRun) return false;

  activeRun.pauseRequested = true;
  await closeActivePages(activeRun);

  const state = await readState();
  const pauseIndex = findEarliestUnfinishedIndex(state.games, state.currentIndex || 0);
  const pausedState = buildPausedState(state, pauseIndex);

  await writeState({
    ...pausedState,
    currentGames: [],
    message: `Paused at game ${Math.min(pauseIndex + 1, state.totalGames || 0)}/${state.totalGames}. Resume will retry unfinished games.`
  });

  return true;
}

function buildPausedState(state, index) {
  const game = state.games?.[index] || state.currentGame;

  return {
    ...state,
    status: "paused",
    currentIndex: index,
    currentGame: game ? buildGameSummary(game, index) : null
  };
}

async function runScan(username, { resume = false } = {}) {
  const config = getRuntimeConfig();
  let state = await readState();

  try {
    const canResume =
      resume &&
      state.username.toLowerCase() === username.toLowerCase() &&
      Array.isArray(state.games) &&
      state.games.length > 0;

    if (!canResume) {
      state = await writeState({
        ...state,
        status: "fetching",
        username,
        requestedAt: new Date().toISOString(),
        startedAt: null,
        finishedAt: null,
        message: "Fetching Chess.com archives...",
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
        errors: []
      });

      const games = await fetchUserGames(username, async (progress) => {
        state = await writeState({
          ...state,
          message: `Fetching archive ${progress.archiveNumber}/${progress.totalArchives}...`,
          totalGames: progress.gamesFound
        });
      });
      await upsertCorpusGames(username, games, { source: "chesscom-pgn" });

      state = await writeState({
        ...state,
        status: "running",
        startedAt: new Date().toISOString(),
        message: `Loaded ${games.length} games. Starting scan...`,
        totalGames: games.length,
        skipped: 0,
        games
      });
    } else {
      const resumeIndex = findEarliestUnfinishedIndex(state.games, state.currentIndex || 0);
      state = await writeState({
        ...state,
        status: "running",
        currentIndex: resumeIndex,
        currentGame: state.games?.[resumeIndex]
          ? buildGameSummary(state.games[resumeIndex], resumeIndex)
          : null,
        currentGames: [],
        startedAt: state.startedAt || new Date().toISOString(),
        finishedAt: null,
        message: "Resuming previous scan..."
      });
    }

    const browserSession = await createReviewBrowserContext(config);
    const { context } = browserSession;

    state = await writeState({
      ...state,
      message: `Using ${browserSession.mode}. Starting up to ${config.concurrency} review tabs...`
    });

    try {
      const result = await scanWithWorkers(context, username, config, state);
      state = result.state;

      if (result.paused) return;
    } finally {
      await browserSession.cleanup();
    }

    await writeState({
      ...state,
      status: "completed",
      currentGame: null,
      currentGames: [],
      finishedAt: new Date().toISOString(),
      message: `Scan complete. Found ${state.results.length} game(s) with brilliant moves.`
    });
  } catch (error) {
    const latest = await readState();

    if (error.pauseRequested || activeRun?.pauseRequested) {
      const pauseIndex = findEarliestUnfinishedIndex(latest.games, latest.currentIndex || 0);
      await writeState({
        ...buildPausedState(latest, pauseIndex),
        currentGames: [],
        message: `Paused at game ${Math.min(pauseIndex + 1, latest.totalGames || 0)}/${latest.totalGames}. Resume will retry unfinished games.`
      });
      return;
    }

    await writeState({
      ...latest,
      status: "error",
      currentGame: null,
      currentGames: [],
      finishedAt: new Date().toISOString(),
      message: error.message
    });
  }
}

async function scanWithWorkers(context, username, config, initialState) {
  let state = initialState;
  let nextIndex = findEarliestUnfinishedIndex(state.games, state.currentIndex || 0);
  const activeIndexes = new Set();
  const withStateLock = createMutex();

  if (nextIndex >= state.games.length) {
    return { state, paused: false };
  }

  async function reserveJob() {
    return withStateLock(async () => {
      if (activeRun?.pauseRequested) return null;

      while (nextIndex < state.games.length) {
        const index = nextIndex;
        nextIndex += 1;

        const game = state.games[index];
        if (!game || isFinishedGame(game)) continue;

        activeIndexes.add(index);
        state = await writeRunningState(
          state,
          activeIndexes,
          `Checking games ${formatActiveIndexes(activeIndexes)}/${state.games.length}...`
        );

        return { index, game };
      }

      return null;
    });
  }

  async function finishSkipped(index, game) {
    return withStateLock(async () => {
      activeIndexes.delete(index);

      const nextGames = [...state.games];
      nextGames[index] = {
        ...game,
        status: "skipped",
        checkedAt: new Date().toISOString(),
        error: null
      };

      state = await writeProgressState({
        ...state,
        games: nextGames,
        skipped: state.skipped + 1,
        message: `Skipped unsupported game ${index + 1}/${state.games.length}.`
      }, activeIndexes);
      await upsertCorpusGames(username, [nextGames[index]], { source: "prototype" });
    });
  }

  async function finishChecked(index, game, review) {
    return withStateLock(async () => {
      activeIndexes.delete(index);

      const checkedGame = {
        ...game,
        status: "checked",
        brilliantCount: review.brilliantCount,
        brilliantMoves: review.brilliantMoves || [],
        checkedAt: new Date().toISOString(),
        scrapeMethod: review.method,
        leftCount: review.leftCount,
        rightCount: review.rightCount,
        playerNameSeen: review.playerNameSeen,
        leftAccuracy: review.leftAccuracy,
        rightAccuracy: review.rightAccuracy,
        classificationTotal: review.classificationTotal,
        reviewAborted: review.reviewAborted,
        error: null
      };

      const nextGames = [...state.games];
      nextGames[index] = checkedGame;

      const nextErrors = removeErrorsForIndex(state.errors, index);
      const results =
        review.brilliantCount > 0 ? upsertResult(state.results, checkedGame) : state.results;

      state = await writeProgressState({
        ...state,
        games: nextGames,
        errors: nextErrors,
        results,
        found: results.length,
        failed: nextErrors.length,
        scanned: state.scanned + 1,
        message:
          review.brilliantCount > 0
            ? `Found ${review.brilliantCount} brilliant move(s) in game ${index + 1}/${state.games.length}.`
            : `No brilliant moves in game ${index + 1}/${state.games.length}.`
      }, activeIndexes);
      await upsertCorpusGames(username, [checkedGame], { source: "prototype" });
    });
  }

  async function finishError(index, game, error) {
    return withStateLock(async () => {
      activeIndexes.delete(index);

      const failedGame = {
        ...game,
        status: "error",
        checkedAt: new Date().toISOString(),
        error: error.message
      };
      const nextGames = [...state.games];
      nextGames[index] = failedGame;
      const nextError = {
        url: game.url,
        reviewUrl: game.reviewUrl,
        index: index + 1,
        message: error.message,
        checkedAt: failedGame.checkedAt
      };
      const nextErrors = [...removeErrorsForIndex(state.errors, index), nextError];

      state = await writeProgressState({
        ...state,
        games: nextGames,
        errors: nextErrors,
        failed: nextErrors.length,
        scanned: state.scanned + 1,
        message: `Game ${index + 1}/${state.games.length} failed: ${error.message}`
      }, activeIndexes);
      await upsertCorpusGames(username, [failedGame], { source: "prototype" });
    });
  }

  async function pauseAt(index, message) {
    if (activeRun) activeRun.pauseRequested = true;
    await closeActivePages(activeRun);

    return withStateLock(async () => {
      activeIndexes.delete(index);
      const pauseIndex = findEarliestUnfinishedIndex(state.games, state.currentIndex || index);
      state = await writeState({
        ...buildPausedState(state, pauseIndex),
        currentGames: [],
        message:
          message ||
          `Paused at game ${Math.min(pauseIndex + 1, state.totalGames || 0)}/${state.totalGames}. Resume will retry unfinished games.`
      });
    });
  }

  async function pauseForAccessProblem(index, game, error) {
    if (activeRun) activeRun.pauseRequested = true;
    await closeActivePages(activeRun);

    return withStateLock(async () => {
      activeIndexes.delete(index);

      const nextErrors = [
        ...removeErrorsForIndex(state.errors, index),
        {
          url: game.url,
          reviewUrl: game.reviewUrl,
          index: index + 1,
          message: error.message,
          checkedAt: new Date().toISOString()
        }
      ];

      const nextState = {
        ...state,
        errors: nextErrors,
        failed: nextErrors.length
      };
      const pauseIndex = findEarliestUnfinishedIndex(nextState.games, nextState.currentIndex || index);

      state = await writeState({
        ...buildPausedState(nextState, pauseIndex),
        currentGames: [],
        message: `${error.message} After logging in, click Start with resume checked.`
      });
    });
  }

  async function worker() {
    while (!activeRun?.pauseRequested) {
      const job = await reserveJob();
      if (!job) return;

      const { index, game } = job;

      try {
        if (game.status === "skipped") {
          await finishSkipped(index, game);
        } else {
          const review = await checkGameReview(context, game, username, {
            shouldPause: () => Boolean(activeRun?.pauseRequested),
            onPage: (page) => {
              if (!activeRun) return;
              if (page) activeRun.currentPages.set(index, page);
              else activeRun.currentPages.delete(index);
            }
          });

          if (activeRun?.pauseRequested) {
            await pauseAt(index);
            return;
          }

          await finishChecked(index, game, review);
        }
      } catch (error) {
        if (activeRun?.pauseRequested || error.pauseRequested) {
          await pauseAt(index);
          return;
        }

        if (shouldPauseForAccessProblem(error)) {
          await pauseForAccessProblem(index, game, error);
          return;
        }

        await finishError(index, game, error);
      }

      if (config.delayMs > 0 && !activeRun?.pauseRequested) {
        await sleep(config.delayMs);
      }
    }
  }

  const workerCount = Math.min(config.concurrency, Math.max(1, state.games.length - nextIndex));
  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  return {
    state,
    paused: Boolean(activeRun?.pauseRequested)
  };
}

async function writeRunningState(state, activeIndexes, message) {
  const currentIndex = findEarliestUnfinishedIndex(state.games, state.currentIndex || 0);

  return writeState({
    ...state,
    status: "running",
    currentIndex,
    currentGame: state.games?.[currentIndex] ? buildGameSummary(state.games[currentIndex], currentIndex) : null,
    currentGames: buildActiveGames(state.games, activeIndexes),
    message
  });
}

async function writeProgressState(nextState, activeIndexes) {
  const currentIndex = findEarliestUnfinishedIndex(nextState.games, nextState.currentIndex || 0);

  return writeState({
    ...nextState,
    status: "running",
    currentIndex,
    currentGame: nextState.games?.[currentIndex]
      ? buildGameSummary(nextState.games[currentIndex], currentIndex)
      : null,
    currentGames: buildActiveGames(nextState.games, activeIndexes)
  });
}

function createMutex() {
  let current = Promise.resolve();

  return async (operation) => {
    const run = current.then(operation, operation);
    current = run.catch(() => {});
    return run;
  };
}

async function closeActivePages(run) {
  if (!run?.currentPages) return;

  const pages = [...new Set(run.currentPages.values())];
  run.currentPages.clear();

  await Promise.all(
    pages.map((page) => page.close({ runBeforeUnload: false }).catch(() => {}))
  );
}

function buildActiveGames(games, activeIndexes) {
  return [...activeIndexes]
    .sort((a, b) => a - b)
    .map((index) => buildGameSummary(games[index], index))
    .filter(Boolean);
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

function corpusRecordToGame(record, options = {}) {
  const prototypeStatus = record.prototype?.status || null;
  const defaultStatus =
    record.reviewUrl && record.userColor && (record.rules || "chess") === "chess"
      ? "pending"
      : "skipped";

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
    pgn: record.pgn || "",
    status: options.forcePending
      ? "pending"
      : options.preservePrototypeStatus
        ? prototypeStatus || defaultStatus
        : defaultStatus,
    brilliantCount: record.prototype?.brilliantCount ?? null,
    brilliantMoves: Array.isArray(record.prototype?.brilliantMoves)
      ? record.prototype.brilliantMoves
      : [],
    checkedAt: record.prototype?.checkedAt || null,
    scrapeMethod: record.prototype?.scrapeMethod || null,
    error: record.prototype?.error || null
  };
}

function normalizeWindowOptions(options = {}) {
  const first = normalizePositiveInteger(options.first, 500);
  const offset = normalizeNonNegativeInteger(options.offset, 0);
  const order = options.order === "newest" ? "newest" : "oldest";
  const afterUrl = typeof options.afterUrl === "string" && options.afterUrl.trim()
    ? options.afterUrl.trim()
    : null;
  const afterLastPrototypeChecked = options.afterLastPrototypeChecked === true ||
    options.afterLastPrototypeChecked === "true";

  return { first, offset, order, afterUrl, afterLastPrototypeChecked };
}

function selectCorpusWindow(records, options = {}) {
  return resolveCorpusWindow(records, options).records;
}

function resolveCorpusWindow(records, options = {}) {
  const items = Array.isArray(records) ? records : [];
  const direction = options.order === "newest" ? -1 : 1;
  const sorted = items
    .slice()
    .filter((record) => record?.url)
    .sort((a, b) => {
      return direction * (Number(a.endTime || 0) - Number(b.endTime || 0)) ||
        String(a.url).localeCompare(String(b.url));
    });
  let anchorRecord = null;
  let anchorIndex = -1;
  let selectionOffset = options.offset;

  if (options.afterUrl) {
    anchorIndex = sorted.findIndex((record) => record.url === options.afterUrl);
    if (anchorIndex < 0) {
      throw new Error(`Anchor game is not in the saved corpus: ${options.afterUrl}`);
    }
  } else if (options.afterLastPrototypeChecked) {
    anchorIndex = findLastPrototypeCheckedIndex(sorted);
    if (anchorIndex < 0) {
      throw new Error("No prototype-checked corpus game exists to anchor this official review window.");
    }
  }

  if (anchorIndex >= 0) {
    anchorRecord = sorted[anchorIndex];
    selectionOffset = anchorIndex + 1 + options.offset;
  }

  return {
    records: sorted.slice(selectionOffset, selectionOffset + options.first),
    options: {
      ...options,
      afterUrl: anchorRecord?.url || options.afterUrl || null,
      afterLastPrototypeChecked: Boolean(options.afterLastPrototypeChecked),
      selectionOffset,
      anchorGame: anchorRecord ? buildAnchorGame(anchorRecord) : null
    }
  };
}

function findLastPrototypeCheckedIndex(records) {
  for (let index = records.length - 1; index >= 0; index -= 1) {
    if (records[index]?.prototype?.checkedAt) return index;
  }

  return -1;
}

function buildAnchorGame(record) {
  return {
    url: record.url,
    reviewUrl: record.reviewUrl,
    white: record.white,
    black: record.black,
    userColor: record.userColor,
    endTime: record.endTime,
    endTimeUtc: formatUtcTimestamp(record.endTime)
  };
}

function buildPrototypeResults(records) {
  return records
    .filter((record) => Number(record.prototype?.brilliantCount) > 0)
    .map((record) => ({
      url: record.url,
      reviewUrl: record.reviewUrl,
      white: record.white,
      black: record.black,
      userColor: record.userColor,
      endTime: record.endTime,
      brilliantCount: record.prototype.brilliantCount,
      brilliantMoves: Array.isArray(record.prototype.brilliantMoves) ? record.prototype.brilliantMoves : [],
      checkedAt: record.prototype.checkedAt
    }))
    .sort((a, b) => Number(a.endTime || 0) - Number(b.endTime || 0));
}

function buildPrototypeErrors(games) {
  return games
    .map((game, index) => ({ game, index }))
    .filter(({ game }) => game.status === "error" || Boolean(game.error))
    .map(({ game, index }) => ({
      url: game.url,
      reviewUrl: game.reviewUrl,
      index: index + 1,
      message: game.error || "Previous official review error.",
      checkedAt: game.checkedAt || null
    }));
}

function buildPrototypeWindowState(username, records, options) {
  const latest = records
    .filter((record) => Number.isFinite(Number(record.endTime)))
    .sort((a, b) => Number(b.endTime) - Number(a.endTime))[0];
  const checked = records.filter((record) => record.prototype?.checkedAt);
  const results = buildPrototypeResults(records);
  const errors = records.filter((record) => record.prototype?.status === "error" || record.prototype?.error);

  return {
    source: "prototype-window",
    username,
    order: options.order,
    offset: options.offset,
    selectionOffset: options.selectionOffset ?? options.offset,
    first: options.first,
    afterUrl: options.afterUrl || null,
    afterLastPrototypeChecked: Boolean(options.afterLastPrototypeChecked),
    anchorGame: options.anchorGame || null,
    totalGames: records.length,
    prototypeChecked: checked.length,
    found: results.length,
    failed: errors.length,
    latestGame: latest
      ? {
          url: latest.url,
          reviewUrl: latest.reviewUrl,
          white: latest.white,
          black: latest.black,
          userColor: latest.userColor,
          endTime: latest.endTime,
          endTimeUtc: formatUtcTimestamp(latest.endTime)
        }
      : null
  };
}

function formatWindowLabel(options = {}) {
  const orderText = options.order === "newest" ? "newest" : "oldest";
  const selectionOffset = Number.isInteger(options.selectionOffset)
    ? options.selectionOffset
    : options.offset;
  const start = selectionOffset + 1;
  const end = selectionOffset + options.first;

  if (options.anchorGame?.url) {
    return `${orderText} games ${start}-${end} after ${options.anchorGame.white} vs ${options.anchorGame.black}`;
  }

  return `${orderText} games ${start}-${end}`;
}

function normalizePositiveInteger(value, fallback) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) return fallback;
  return parsed;
}

function normalizeNonNegativeInteger(value, fallback) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) return fallback;
  return parsed;
}

async function loadReferenceState(username, referencePath) {
  const filePath = referencePath
    ? path.resolve(process.cwd(), referencePath)
    : path.join(DEFAULT_REFERENCE_DIR, `${sanitizeReferenceName(username)}-chesscom-review-state.json`);

  try {
    const raw = await fs.readFile(filePath, "utf8");
    return {
      ...JSON.parse(raw),
      referencePath: filePath
    };
  } catch (error) {
    if (error.code === "ENOENT") {
      throw new Error(`No prototype reference file found for ${username} at ${filePath}.`);
    }
    throw error;
  }
}

function summarizeReferenceState(reference) {
  const games = Array.isArray(reference.games) ? reference.games : [];
  const results = Array.isArray(reference.results) ? reference.results : [];
  const errors = Array.isArray(reference.errors) ? reference.errors : [];
  const latestEntry = games
    .map((game, index) => ({ game, index, endTime: Number(game?.endTime) }))
    .filter((entry) => Number.isFinite(entry.endTime))
    .sort((a, b) => b.endTime - a.endTime)[0];

  if (!latestEntry) {
    throw new Error("Prototype reference has no game endTime values to resume from.");
  }

  return {
    latestEndTime: latestEntry.endTime,
    gameUrls: games.map((game) => game?.url).filter(Boolean),
    checkedUrls: games.filter((game) => game?.checkedAt).map((game) => game?.url).filter(Boolean),
    results: results.map((result) => ({
      url: result.url,
      reviewUrl: result.reviewUrl,
      white: result.white,
      black: result.black,
      userColor: result.userColor,
      brilliantCount: result.brilliantCount,
      brilliantMoves: Array.isArray(result.brilliantMoves) ? result.brilliantMoves : [],
      checkedAt: result.checkedAt
    })),
    state: {
      source: "prototype-reference",
      referencePath: reference.referencePath,
      username: reference.username,
      status: reference.status,
      totalGames: Number(reference.totalGames) || games.length,
      scanned: Number(reference.scanned) || 0,
      found: results.length,
      failed: errors.length,
      finishedAt: reference.finishedAt || null,
      latestEndTime: latestEntry.endTime,
      latestEndTimeUtc: formatUtcTimestamp(latestEntry.endTime),
      latestGame: {
        ...buildGameSummary(latestEntry.game, latestEntry.index),
        endTime: latestEntry.endTime,
        endTimeUtc: formatUtcTimestamp(latestEntry.endTime)
      }
    }
  };
}

function summarizePrototypeCorpus(username, records, reference) {
  const items = Array.isArray(records) ? records : [];
  const prototypeChecked = items.filter((record) => {
    return record.prototype?.checkedAt || record.prototype?.status === "checked";
  });
  const latestEntry = prototypeChecked
    .map((record) => ({ record, endTime: Number(record?.endTime) }))
    .filter((entry) => Number.isFinite(entry.endTime))
    .sort((a, b) => b.endTime - a.endTime)[0];

  if (!latestEntry) {
    return summarizeReferenceState(reference);
  }

  const results = items
    .filter((record) => Number(record.prototype?.brilliantCount) > 0)
    .map((record) => ({
      url: record.url,
      reviewUrl: record.reviewUrl,
      white: record.white,
      black: record.black,
      userColor: record.userColor,
      brilliantCount: record.prototype.brilliantCount,
      brilliantMoves: Array.isArray(record.prototype.brilliantMoves) ? record.prototype.brilliantMoves : [],
      checkedAt: record.prototype.checkedAt
    }))
    .sort((a, b) => {
      const aRecord = items.find((record) => record.url === a.url);
      const bRecord = items.find((record) => record.url === b.url);
      return Number(aRecord?.endTime || 0) - Number(bRecord?.endTime || 0);
    });
  const failed = items.filter((record) => record.prototype?.status === "error").length;

  return {
    latestEndTime: latestEntry.endTime,
    checkedUrls: prototypeChecked.map((record) => record.url).filter(Boolean),
    results,
    state: {
      source: "prototype-corpus",
      referencePath: reference.referencePath,
      username,
      totalGames: items.length,
      prototypeChecked: prototypeChecked.length,
      found: results.length,
      failed,
      latestEndTime: latestEntry.endTime,
      latestEndTimeUtc: formatUtcTimestamp(latestEntry.endTime),
      latestGame: {
        url: latestEntry.record.url,
        reviewUrl: latestEntry.record.reviewUrl,
        white: latestEntry.record.white,
        black: latestEntry.record.black,
        userColor: latestEntry.record.userColor,
        endTime: latestEntry.endTime,
        endTimeUtc: formatUtcTimestamp(latestEntry.endTime)
      }
    }
  };
}

function formatActiveIndexes(activeIndexes) {
  return [...activeIndexes]
    .sort((a, b) => a - b)
    .map((index) => index + 1)
    .join(", ");
}

function findEarliestUnfinishedIndex(games, startIndex = 0) {
  if (!Array.isArray(games) || games.length === 0) return 0;

  for (let index = Math.max(0, startIndex); index < games.length; index += 1) {
    if (!isFinishedGame(games[index])) return index;
  }

  return games.length;
}

function isFinishedGame(game) {
  return (
    game?.status === "checked" ||
    game?.status === "error" ||
    (game?.status === "skipped" && Boolean(game.checkedAt))
  );
}

function upsertResult(results, game) {
  const result = {
    url: game.url,
    reviewUrl: game.reviewUrl,
    white: game.white,
    black: game.black,
    userColor: game.userColor,
    brilliantCount: game.brilliantCount,
    brilliantMoves: game.brilliantMoves || [],
    checkedAt: game.checkedAt
  };

  if (results.some((item) => item.url === game.url)) {
    return results.map((item) => (item.url === game.url ? result : item));
  }

  return [...results, result];
}

function upsertMoveLabelResult(game) {
  return {
    url: game.url,
    reviewUrl: game.reviewUrl,
    white: game.white,
    black: game.black,
    userColor: game.userColor,
    brilliantCount: game.brilliantCount,
    brilliantMoves: game.brilliantMoves || [],
    checkedAt: game.checkedAt
  };
}

function removeErrorsForIndex(errors, gameIndex) {
  if (!Array.isArray(errors)) return [];
  return errors.filter((error) => Number(error.index) !== gameIndex + 1);
}

function shouldPauseForAccessProblem(error) {
  return (
    error.accessPause ||
    /login required|captcha|rate.?limit|too many requests|access denied|blocked/i.test(
      error.message || ""
    )
  );
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function sanitizeReferenceName(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function formatUtcTimestamp(timestamp) {
  if (!Number.isFinite(Number(timestamp))) return "unknown time";
  return new Date(Number(timestamp) * 1000).toISOString().replace("T", " ").replace(".000Z", "Z");
}
