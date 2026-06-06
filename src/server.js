import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isLocalRunning, pauseLocalScan, startLocalScan } from "./localScanner.js";
import {
  startCorpusPrototypeErrorRetryScan,
  startCorpusPrototypeMoveScan,
  startCorpusPrototypeWindowErrorRetryScan,
  startCorpusPrototypeWindowScan,
  isRunning as isPrototypeRunning,
  pauseScan,
  startPrototypeSinceReference
} from "./scanner.js";
import { upsertCorpusGames } from "./gameCorpus.js";
import { readState, resetState, writeState } from "./stateStore.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PORT = Number(process.env.PORT) || 5050;

const app = express();

app.use(express.json());
app.use(express.static(path.resolve(__dirname, "..", "public")));

app.get("/api/status", async (_request, response) => {
  const state = await readState();
  response.json({
    ...state,
    isRunning: isAnyScanRunning()
  });
});

app.post(["/api/scan/start", "/api/local/start"], async (request, response) => {
  try {
    assertNoRunningScan();
    await startLocalScan(request.body?.username);
    response.status(202).json({ ok: true });
  } catch (error) {
    response.status(400).json({ ok: false, error: error.message });
  }
});

app.post("/api/prototype/since-reference", async (request, response) => {
  try {
    assertNoRunningScan();
    await startPrototypeSinceReference(request.body?.username, {
      referencePath: request.body?.referencePath
    });
    response.status(202).json({ ok: true });
  } catch (error) {
    response.status(400).json({ ok: false, error: error.message });
  }
});

app.post("/api/prototype/move-labels", async (request, response) => {
  try {
    assertNoRunningScan();
    await startCorpusPrototypeMoveScan(request.body?.username);
    response.status(202).json({ ok: true });
  } catch (error) {
    response.status(400).json({ ok: false, error: error.message });
  }
});

app.post("/api/prototype/retry-errors", async (request, response) => {
  try {
    assertNoRunningScan();
    await startCorpusPrototypeErrorRetryScan(request.body?.username);
    response.status(202).json({ ok: true });
  } catch (error) {
    response.status(400).json({ ok: false, error: error.message });
  }
});

app.post("/api/prototype/window", async (request, response) => {
  try {
    assertNoRunningScan();
    await startCorpusPrototypeWindowScan(request.body?.username, {
      first: request.body?.first,
      offset: request.body?.offset,
      order: request.body?.order,
      afterUrl: request.body?.afterUrl,
      afterLastPrototypeChecked: request.body?.afterLastPrototypeChecked
    });
    response.status(202).json({ ok: true });
  } catch (error) {
    response.status(400).json({ ok: false, error: error.message });
  }
});

app.post("/api/prototype/window/retry-errors", async (request, response) => {
  try {
    assertNoRunningScan();
    await startCorpusPrototypeWindowErrorRetryScan(request.body?.username, {
      first: request.body?.first,
      offset: request.body?.offset,
      order: request.body?.order,
      afterUrl: request.body?.afterUrl,
      afterLastPrototypeChecked: request.body?.afterLastPrototypeChecked
    });
    response.status(202).json({ ok: true });
  } catch (error) {
    response.status(400).json({ ok: false, error: error.message });
  }
});

app.post("/api/prototype/window/resume-current", async (_request, response) => {
  try {
    assertNoRunningScan();

    const state = await readState();
    const baseline = state.baseline || {};
    const username = String(state.username || "").trim();
    const options = {
      first: baseline.first,
      offset: baseline.offset,
      order: baseline.order,
      afterUrl: baseline.afterUrl,
      afterLastPrototypeChecked: baseline.afterLastPrototypeChecked
    };

    if (!username || baseline.source !== "prototype-window") {
      throw new Error("No current official review window is saved.");
    }

    const games = Array.isArray(state.games) ? state.games : [];
    const hasPending = games.some((game) => !isFinishedWindowGame(game));
    const hasErrors = games.some((game) => game?.status === "error" || Boolean(game?.error));

    if (hasPending) {
      await startCorpusPrototypeWindowScan(username, options);
      response.status(202).json({ ok: true, action: "resume" });
      return;
    }

    if (hasErrors) {
      await startCorpusPrototypeWindowErrorRetryScan(username, options);
      response.status(202).json({ ok: true, action: "retry-errors" });
      return;
    }

    throw new Error("Current official review window has no pending games or errors.");
  } catch (error) {
    response.status(400).json({ ok: false, error: error.message });
  }
});

app.post("/api/pause", async (_request, response) => {
  const paused = (await pauseLocalScan()) || (await pauseScan());
  response.json({ ok: true, paused });
});

app.post("/api/errors/dismiss", async (request, response) => {
  if (isAnyScanRunning()) {
    response.status(409).json({ ok: false, error: "Pause the scan before removing errors." });
    return;
  }

  try {
    const state = await readState();
    const { state: nextState, removed, updatedGame } = dismissError(state, request.body || {});

    if (!removed) {
      response.status(404).json({ ok: false, error: "Could not find that error." });
      return;
    }

    const savedState = await writeState(nextState);
    if (updatedGame && savedState.username) {
      await upsertCorpusGames(savedState.username, [updatedGame], { source: "prototype" });
    }
    response.json({ ok: true, state: savedState });
  } catch (error) {
    response.status(400).json({ ok: false, error: error.message });
  }
});

app.post("/api/reset", async (_request, response) => {
  if (isAnyScanRunning()) {
    response.status(409).json({ ok: false, error: "Pause the scan before resetting." });
    return;
  }

  const state = await resetState();
  response.json({ ok: true, state });
});

app.listen(PORT, () => {
  console.log(`Brilliant Scanner running at http://localhost:${PORT}`);
});

function isAnyScanRunning() {
  return isLocalRunning() || isPrototypeRunning();
}

function assertNoRunningScan() {
  if (isAnyScanRunning()) {
    throw new Error("A scan is already running.");
  }
}

function isFinishedWindowGame(game) {
  return (
    game?.status === "checked" ||
    game?.status === "error" ||
    (game?.status === "skipped" && Boolean(game.checkedAt))
  );
}

function dismissError(state, target) {
  const errors = Array.isArray(state.errors) ? state.errors : [];
  const targetIndex = Number(target.index);
  const targetCheckedAt = String(target.checkedAt || "");
  const targetReviewUrl = String(target.reviewUrl || "");

  const removeAt = errors.findIndex((error) => {
    if (Number(error.index) !== targetIndex) return false;
    if (targetCheckedAt && error.checkedAt !== targetCheckedAt) return false;
    if (targetReviewUrl && error.reviewUrl !== targetReviewUrl) return false;
    return true;
  });

  if (removeAt === -1) return { state, removed: false };

  const nextErrors = errors.filter((_error, index) => index !== removeAt);
  const gameIndex = targetIndex - 1;
  const games = Array.isArray(state.games) ? [...state.games] : [];

  let updatedGame = null;
  if (games[gameIndex]) {
    const checkedAt = new Date().toISOString();
    games[gameIndex] = {
      ...games[gameIndex],
      status: "checked",
      brilliantCount: 0,
      brilliantMoves: [],
      checkedAt,
      error: null,
      errorDismissed: true,
      errorDismissedAt: checkedAt,
      manuallyClearedError: true
    };
    updatedGame = games[gameIndex];
  }

  return {
    state: recountState({
      ...state,
      games,
      errors: nextErrors,
      message: `Removed error for game ${targetIndex}.`
    }),
    removed: true,
    updatedGame
  };
}

function recountState(state) {
  const games = Array.isArray(state.games) ? state.games : [];
  const results = Array.isArray(state.results) ? state.results : [];
  const errors = Array.isArray(state.errors) ? state.errors : [];

  return {
    ...state,
    found: results.length,
    failed: errors.length,
    scanned: games.filter((game) => game?.status === "checked" || game?.status === "error").length,
    skipped: games.filter((game) => game?.status === "skipped" && game.checkedAt).length
  };
}
