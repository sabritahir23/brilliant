import { spawn } from "node:child_process";
import path from "node:path";
import { createRequire } from "node:module";
import { Chess } from "chess.js";

const require = createRequire(import.meta.url);
const STOCKFISH_ROOT = path.dirname(require.resolve("stockfish/package.json"));

const DEFAULT_DEPTH = Number(process.env.BRILLIANT_STOCKFISH_DEPTH) || 14;
const DEFAULT_MULTIPV = Number(process.env.BRILLIANT_STOCKFISH_MULTIPV) || 8;
const DEFAULT_ENGINE = process.env.BRILLIANT_STOCKFISH_ENGINE || "full";
const DEFAULT_SEARCH_TIMEOUT_MS = Number(process.env.BRILLIANT_STOCKFISH_TIMEOUT_MS) || 30_000;
const MATE_SCORE = 100_000;
const PIECE_VALUES = {
  p: 1,
  n: 3,
  b: 3,
  r: 5,
  q: 9,
  k: 0
};

let sharedEngine = null;

export async function getStockfishAnalyzer() {
  if (!sharedEngine) {
    sharedEngine = await StockfishAnalyzer.create({
      engine: DEFAULT_ENGINE,
      depth: DEFAULT_DEPTH,
      multipv: DEFAULT_MULTIPV,
      searchTimeoutMs: DEFAULT_SEARCH_TIMEOUT_MS
    });
  }

  return sharedEngine;
}

export async function closeStockfishAnalyzer() {
  if (!sharedEngine) return;
  await sharedEngine.quit();
  sharedEngine = null;
}

export class StockfishAnalyzer {
  static async create(options = {}) {
    const analyzer = new StockfishAnalyzer(options);
    await analyzer.init();
    return analyzer;
  }

  constructor({
    engine = DEFAULT_ENGINE,
    depth = DEFAULT_DEPTH,
    multipv = DEFAULT_MULTIPV,
    searchTimeoutMs = DEFAULT_SEARCH_TIMEOUT_MS
  } = {}) {
    this.engineName = engine;
    this.depth = depth;
    this.multipv = multipv;
    this.searchTimeoutMs = searchTimeoutMs;
    this.child = null;
    this.buffer = "";
    this.lines = [];
    this.pending = [];
    this.queue = Promise.resolve();
  }

  async init() {
    await this.startProcess();
    await this.commandUntil("uci", "uciok", 20_000);
    await this.command(`setoption name MultiPV value ${this.multipv}`);
    await this.commandUntil("isready", "readyok", 20_000);
  }

  async verifyCandidate(candidate) {
    try {
      const before = await this.analyzeFen(candidate.fenBefore, { multipv: this.multipv });
      let playedLine = before.lines.find((line) => line.bestMove === candidate.lan);
      const bestLine = before.lines[0] || null;

      if (!bestLine) {
        return reject(candidate, "Stockfish returned no usable top line", { before });
      }

      const missingFromTopLines = !playedLine;
      if (!playedLine && !candidate.forceClassify) {
        return reject(candidate, "not in Stockfish top lines", { before });
      }

      const bestScore = scoreForSideToMove(bestLine);
      let playedScore = playedLine ? scoreForSideToMove(playedLine) : bestScore;
      let scoreLoss = bestScore - playedScore;

      const scoreLossLimit = candidate.forceClassify && candidate.materialInvitation?.isCandidate ? 380 : candidate.forceClassify ? 190 : 140;
      if (scoreLoss > scoreLossLimit) {
        return reject(candidate, "too far below best engine move", { before, scoreLoss });
      }

      const after = await this.analyzeFen(candidate.fenAfter, { multipv: 1 });
      const afterScoreForOpponent = scoreForSideToMove(after.lines[0]);
      const afterScoreForPlayer = -afterScoreForOpponent;
      if (missingFromTopLines) {
        playedLine = {
          multipv: null,
          bestMove: candidate.lan,
          pv: [candidate.lan]
        };
        playedScore = Math.max(bestScore, afterScoreForPlayer);
        scoreLoss = Math.max(0, bestScore - afterScoreForPlayer);
      }
      const competitivenessLimit = getCompetitivenessLimit(candidate);
      const competitiveBefore = Math.abs(bestScore) <= competitivenessLimit || candidate.forceClassify;
      const soundAfterMove = afterScoreForPlayer >= -180 || isMateForPlayer(after.lines[0]);

      if (!competitiveBefore) {
        return reject(candidate, "position was already too one-sided", {
          before,
          bestScore,
          competitivenessLimit,
          after,
          afterScoreForPlayer
        });
      }

      if (!soundAfterMove) {
        return reject(candidate, "sacrifice is not sound after best reply", {
          before,
          after,
          afterScoreForPlayer
        });
      }

      let brilliancyProfile = classifyBrilliancyProfile(candidate, {
        playedRank: playedLine.multipv,
        bestScore,
        scoreLoss,
        afterScoreForPlayer,
        afterLine: after.lines[0]
      });
      const delayedCompensation = brilliancyProfile.accepted
        ? notAnalyzedDelayedCompensation("existing brilliancy profile accepted the move")
        : await analyzeEngineLineDelayedCompensation(this, candidate, {
            playedRank: playedLine.multipv,
            bestScore,
            scoreLoss,
            afterScoreForPlayer
          });

      if (!brilliancyProfile.accepted && delayedCompensation.accepted) {
        brilliancyProfile = acceptProfile("engine-line delayed compensation");
      }

      if (!brilliancyProfile.accepted) {
        return reject(candidate, brilliancyProfile.reason, {
          before,
          bestScore,
          scoreLoss,
          after,
          afterScoreForPlayer,
          brilliancyProfile,
          delayedCompensation
        });
      }

      const uniqueness = calculateUniqueness(before.lines);
      const engineBonus = Math.max(0, 35 - Math.max(0, scoreLoss));
      const uniquenessBonus = Math.min(18, Math.round(uniqueness / 12));
      const verifiedScore = Math.min(100, candidate.score + engineBonus + uniquenessBonus);

      return {
        ...candidate,
        score: verifiedScore,
        verified: true,
        engine: {
          engine: this.engineName,
          depth: before.depth,
          multipv: this.multipv,
          bestMove: bestLine.bestMove,
          playedRank: playedLine.multipv,
          bestScore,
          playedScore,
          scoreLoss,
          competitivenessLimit,
          afterBestMove: after.lines[0]?.bestMove || null,
          afterScoreForPlayer,
          uniqueness,
          brilliancyProfile,
          delayedCompensation
        },
        reasons: [
          ...candidate.reasons,
          getStockfishReason(playedLine),
          "sound after best reply",
          ...(delayedCompensation.accepted ? ["engine-line delayed compensation"] : [])
        ]
      };
    } catch (error) {
      return reject(candidate, `Stockfish verification failed: ${error.message}`);
    }
  }

  async analyzeFen(fen, { multipv = this.multipv, depth = this.depth } = {}) {
    return this.enqueue(async () => {
      this.lines = [];
      await this.command("ucinewgame");
      await this.command(`setoption name MultiPV value ${multipv}`);
      await this.commandUntil("isready", "readyok", 20_000);
      await this.command(`position fen ${fen}`);

      const bestMoveLine = await this.commandUntil(
        `go depth ${depth}`,
        "bestmove ",
        this.searchTimeoutMs,
        { restartOnTimeout: true }
      );
      const bestMove = bestMoveLine.split(/\s+/)[1] || null;
      const lines = normalizePvLines(this.lines, bestMove);

      return {
        fen,
        depth,
        bestMove,
        lines
      };
    });
  }

  async quit() {
    this.rejectPending(new Error("Stockfish engine closed."));
    if (!this.child) return;

    const child = this.child;
    this.child = null;
    child.stdin.write("quit\n");
    await waitForExit(child, 1_000).catch(() => {
      child.kill("SIGKILL");
    });
  }

  enqueue(operation) {
    const next = this.queue.then(operation, operation);
    this.queue = next.catch(() => {});
    return next;
  }

  async startProcess() {
    const enginePath = getEnginePath(this.engineName);
    this.buffer = "";
    this.lines = [];
    this.rejectPending(new Error("Stockfish engine restarted."));

    this.child = spawn(process.execPath, [enginePath], {
      cwd: process.cwd(),
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true
    });

    this.child.stdout.setEncoding("utf8");
    this.child.stderr.setEncoding("utf8");
    this.child.stdout.on("data", (chunk) => this.handleChunk(chunk));
    this.child.stderr.on("data", (chunk) => {
      const text = String(chunk).trim();
      if (text) console.warn(`[stockfish:${this.engineName}:stderr] ${text}`);
    });
    this.child.on("exit", (code, signal) => {
      this.rejectPending(new Error(`Stockfish exited (${code ?? signal}).`));
    });
  }

  async restartProcess() {
    const oldChild = this.child;
    this.child = null;
    if (oldChild) {
      oldChild.kill("SIGKILL");
      await waitForExit(oldChild, 1_000).catch(() => {});
    }

    await this.init();
  }

  handleChunk(chunk) {
    this.buffer += chunk;
    const parts = this.buffer.split(/\r?\n/);
    this.buffer = parts.pop() || "";

    for (const rawLine of parts) {
      this.handleLine(rawLine.trim());
    }
  }

  handleLine(line) {
    if (!line) return;
    if (line.startsWith("info ")) this.captureInfoLine(line);

    for (const pending of [...this.pending]) {
      if (pending.matcher(line)) {
        pending.resolve(line);
        this.pending = this.pending.filter((item) => item !== pending);
      }
    }
  }

  captureInfoLine(line) {
    const multipv = readNumber(line, /\bmultipv\s+(\d+)/) || 1;
    const depth = readNumber(line, /\bdepth\s+(\d+)/) || 0;
    const cp = readNumber(line, /\bscore cp\s+(-?\d+)/);
    const mate = readNumber(line, /\bscore mate\s+(-?\d+)/);
    const pvMatch = line.match(/\bpv\s+(.+)$/);
    const pv = pvMatch ? pvMatch[1].trim().split(/\s+/) : [];

    if (!pv.length || (!Number.isFinite(cp) && !Number.isFinite(mate))) return;

    const existing = this.lines.find((item) => item.multipv === multipv);
    const next = {
      multipv,
      depth,
      cp,
      mate,
      bestMove: pv[0],
      pv
    };

    if (!existing) {
      this.lines.push(next);
      return;
    }

    if (depth >= existing.depth) Object.assign(existing, next);
  }

  command(command) {
    if (!this.child?.stdin.writable) {
      return Promise.reject(new Error("Stockfish process is not writable."));
    }

    this.child.stdin.write(`${command}\n`);
    return Promise.resolve("");
  }

  commandUntil(command, expectedPrefix, timeoutMs, { restartOnTimeout = false } = {}) {
    if (!this.child?.stdin.writable) {
      return Promise.reject(new Error("Stockfish process is not writable."));
    }

    return new Promise((resolve, reject) => {
      const pending = {
        matcher: (line) => line.startsWith(expectedPrefix),
        resolve: (line) => {
          clearTimeout(timeout);
          resolve(line);
        },
        reject: (error) => {
          clearTimeout(timeout);
          reject(error);
        }
      };

      const timeout = setTimeout(async () => {
        this.pending = this.pending.filter((item) => item !== pending);
        const error = new Error(
          `Stockfish timed out after ${timeoutMs}ms waiting for ${expectedPrefix.trim() || "response"} from ${command}.`
        );

        if (restartOnTimeout) {
          await this.restartProcess().catch(() => {});
        }

        reject(error);
      }, timeoutMs);

      this.pending.push(pending);
      this.child.stdin.write(`${command}\n`);
    });
  }

  rejectPending(error) {
    for (const pending of this.pending) pending.reject?.(error);
    this.pending = [];
  }
}

function getEnginePath(engineName) {
  const version = require("stockfish/package.json").buildVersion;
  const names = {
    full: `stockfish-${version}.js`,
    single: `stockfish-${version}-single.js`,
    lite: `stockfish-${version}-lite.js`,
    "lite-single": `stockfish-${version}-lite-single.js`,
    asm: `stockfish-${version}-asm.js`
  };
  const filename = names[String(engineName).toLowerCase()] || engineName;

  if (path.isAbsolute(filename)) return filename;
  return path.join(STOCKFISH_ROOT, "bin", filename);
}

function normalizePvLines(lines, fallbackBestMove) {
  const sorted = lines
    .slice()
    .sort((a, b) => a.multipv - b.multipv)
    .map((line) => ({
      ...line,
      score: scoreForSideToMove(line)
    }));

  if (!sorted.length && fallbackBestMove) {
    return [
      { multipv: 1, depth: 0, cp: 0, mate: null, bestMove: fallbackBestMove, pv: [fallbackBestMove], score: 0 }
    ];
  }

  return sorted;
}

function scoreForSideToMove(line) {
  if (!line) return 0;
  if (Number.isFinite(line.mate)) {
    return line.mate > 0 ? MATE_SCORE - line.mate : -MATE_SCORE - line.mate;
  }

  return Number.isFinite(line.cp) ? line.cp : 0;
}

async function analyzeEngineLineDelayedCompensation(analyzer, candidate, metrics) {
  const playedRank = metricNumber(metrics.playedRank);
  const scoreLoss = metricNumber(metrics.scoreLoss);
  const bestScore = metricNumber(metrics.bestScore);
  const afterScoreForPlayer = metricNumber(metrics.afterScoreForPlayer);
  const materialBalanceBefore = metricNumber(candidate.materialBalanceBefore);
  const engineSupported =
    (
      Number.isFinite(playedRank) &&
      playedRank <= 3 &&
      Number.isFinite(scoreLoss) &&
      scoreLoss <= 90
    ) ||
    (Number.isFinite(scoreLoss) && scoreLoss <= 35);

  if (candidate.piece === "k") {
    return notAnalyzedDelayedCompensation("king moves are excluded from the delayed-compensation path");
  }
  if (!candidate.materialInvitation?.isCandidate) {
    return notAnalyzedDelayedCompensation("no material invitation was detected");
  }
  if ((PIECE_VALUES[candidate.captured] || 0) > 1) {
    return notAnalyzedDelayedCompensation("the move directly wins high-value material");
  }
  if (!engineSupported) {
    return notAnalyzedDelayedCompensation("the move is not top-three or low-loss enough");
  }
  if (
    !Number.isFinite(bestScore) ||
    bestScore < -80 ||
    bestScore > 600 ||
    !Number.isFinite(afterScoreForPlayer) ||
    afterScoreForPlayer < -80 ||
    afterScoreForPlayer > 600
  ) {
    return notAnalyzedDelayedCompensation("the position is not competitive and sound enough");
  }
  if (
    !Number.isFinite(materialBalanceBefore) ||
    materialBalanceBefore < -3 ||
    materialBalanceBefore > 3
  ) {
    return notAnalyzedDelayedCompensation("the starting material balance is outside the focused window");
  }

  const boardAfterMove = new Chess(candidate.fenAfter);
  const playerColor = boardAfterMove.turn() === "w" ? "b" : "w";
  if (movedPieceAttacksHighValueTarget(boardAfterMove, candidate, playerColor)) {
    return notAnalyzedDelayedCompensation("the move directly attacks high-value material");
  }

  const offers = findMeaningfulAcceptanceCaptures(boardAfterMove);
  if (!offers.length) {
    return notAnalyzedDelayedCompensation("no legal meaningful material acceptance was found");
  }

  const balanceAfterMove = materialBalanceForColor(boardAfterMove, playerColor);
  const offer = offers[0];
  const acceptedBoard = new Chess(candidate.fenAfter);
  const acceptedMove = acceptedBoard.move({
    from: offer.from,
    to: offer.to,
    promotion: offer.promotion
  });
  const acceptance = await analyzer.analyzeFen(acceptedBoard.fen(), { multipv: 1 });
  const acceptanceLine = acceptance.lines[0] || null;
  const acceptanceScoreForPlayer = scoreForSideToMove(acceptanceLine);
  const replyBoard = new Chess(acceptedBoard.fen());
  const firstReply = applyLan(replyBoard, acceptanceLine?.bestMove);
  const materialConcessionAfterReply = firstReply
    ? balanceAfterMove - materialBalanceForColor(replyBoard, playerColor)
    : null;
  const directRecapture = Boolean(
    firstReply?.captured &&
    firstReply.to === acceptedMove.to
  );
  const acceptanceIsPlausible =
    acceptanceScoreForPlayer >= -80 &&
    acceptanceScoreForPlayer <= afterScoreForPlayer + 160;
  const compensationIsDelayed =
    Boolean(firstReply) &&
    Number.isFinite(materialConcessionAfterReply) &&
    materialConcessionAfterReply >= 1;
  const accepted = acceptanceIsPlausible && compensationIsDelayed;

  return {
    analyzed: true,
    accepted,
    reason: accepted
      ? "engine-supported move remains sound after a meaningful material acceptance"
      : !acceptanceIsPlausible
        ? "the material acceptance is unsound or too implausible for the opponent"
        : "the engine reply does not preserve a meaningful material concession",
    offer: {
      san: acceptedMove.san,
      lan: offer.lan,
      attacker: offer.attacker,
      captured: offer.captured,
      targetValue: offer.targetValue,
      attackerValue: offer.attackerValue,
      materialGain: offer.materialGain
    },
    acceptanceScoreForPlayer,
    acceptanceBestMove: acceptanceLine?.bestMove || null,
    acceptancePv: acceptanceLine?.pv || [],
    directRecapture,
    materialConcessionAfterReply
  };
}

function findMeaningfulAcceptanceCaptures(board) {
  return board
    .moves({ verbose: true })
    .filter((move) => move.captured)
    .map((move) => {
      const targetValue = PIECE_VALUES[move.captured] || 0;
      const attackerValue = PIECE_VALUES[move.piece] || 0;
      return {
        from: move.from,
        to: move.to,
        promotion: move.promotion,
        lan: `${move.from}${move.to}${move.promotion || ""}`,
        attacker: move.piece,
        captured: move.captured,
        targetValue,
        attackerValue,
        materialGain: targetValue - attackerValue
      };
    })
    .filter((offer) => offer.targetValue >= 3 && offer.materialGain >= 2)
    .sort((a, b) => b.targetValue - a.targetValue || b.materialGain - a.materialGain);
}

function movedPieceAttacksHighValueTarget(board, candidate, playerColor) {
  const movedSquare = candidate.lan?.slice(2, 4);
  if (!movedSquare) return false;
  const opponentColor = playerColor === "w" ? "b" : "w";

  for (const row of board.board()) {
    for (const piece of row) {
      if (!piece || piece.color !== opponentColor || piece.type === "k") continue;
      if ((PIECE_VALUES[piece.type] || 0) < 3) continue;
      if (board.attackers(piece.square, playerColor).includes(movedSquare)) return true;
    }
  }

  return false;
}

function materialBalanceForColor(board, color) {
  let balance = 0;

  for (const row of board.board()) {
    for (const piece of row) {
      if (!piece) continue;
      const value = PIECE_VALUES[piece.type] || 0;
      balance += piece.color === color ? value : -value;
    }
  }

  return balance;
}

function applyLan(board, lan) {
  const match = String(lan || "").match(/^([a-h][1-8])([a-h][1-8])([qrbn])?$/);
  if (!match) return null;

  try {
    return board.move({
      from: match[1],
      to: match[2],
      promotion: match[3]
    });
  } catch {
    return null;
  }
}

function notAnalyzedDelayedCompensation(reason) {
  return {
    analyzed: false,
    accepted: false,
    reason
  };
}

function isMateForPlayer(line) {
  return Number.isFinite(line?.mate) && line.mate < 0;
}

function calculateUniqueness(lines) {
  if (lines.length < 2) return 0;
  return Math.max(0, scoreForSideToMove(lines[0]) - scoreForSideToMove(lines[1]));
}

function getStockfishReason(playedLine) {
  if (playedLine.multipv === 1) return "Stockfish top move";
  if (Number.isFinite(playedLine.multipv)) return `Stockfish top ${playedLine.multipv}`;
  return "Stockfish sound sacrifice";
}

function readNumber(line, pattern) {
  const match = line.match(pattern);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : null;
}

function reject(candidate, reason, engine = {}) {
  return {
    ...candidate,
    verified: false,
    rejectedReason: reason,
    engine
  };
}

function getCompetitivenessLimit(candidate) {
  const rating = Number(candidate.userRating);
  const base = 900;

  if (!Number.isFinite(rating)) return base;
  if (rating < 600) return 2600;
  if (rating < 900) return 2200;
  if (rating < 1200) return 1800;
  if (rating < 1600) return 1400;
  return base;
}

export function classifyBrilliancyProfile(candidate, metrics) {
  const playedRank = metricNumber(metrics.playedRank);
  const scoreLoss = metricNumber(metrics.scoreLoss);
  const bestScore = metricNumber(metrics.bestScore);
  const afterScoreForPlayer = metricNumber(metrics.afterScoreForPlayer);
  const givesCheck = /[+#]/.test(candidate.san || "");
  const hasSacrifice = Boolean(candidate.sacrifice?.isCandidate);
  const hasPawnStorm = Boolean(candidate.pawnStorm?.isCandidate);
  const hasPromotionPressure = Boolean(candidate.promotionPressure?.isCandidate);
  const hasQueenSacrifice = Boolean(candidate.queenSacrifice?.isCandidate);
  const hasExchangeInvestment = Boolean(candidate.exchangeInvestment?.isCandidate);
  const hasPressureTactic = Boolean(candidate.pressureTactic?.isCandidate);
  const hasMaterialInvitation = Boolean(candidate.materialInvitation?.isCandidate);
  const bestInvitedCapture = candidate.materialInvitation?.bestCapture || null;
  const materialBalanceBefore = Number(candidate.materialBalanceBefore);
  const movedPieceValue = PIECE_VALUES[candidate.piece] || 0;
  const capturedPieceValue = PIECE_VALUES[candidate.captured] || 0;
  const centralPawnBreak = hasReason(candidate, "central pawn break");
  const quietPieceSacrifice = hasSacrifice && !givesCheck && !candidate.captured;
  const mateInOneThreat = hasReason(candidate, "creates mate-in-one threat");
  const isPawnBreakthrough =
    candidate.piece === "p" &&
    hasSacrifice &&
    hasReason(candidate, "pawn breakthrough near king");
  const quietMateThreat =
    hasReason(candidate, "creates immediate mate threat") &&
    !givesCheck &&
    !candidate.captured;
  const promotionOnly = hasPromotionPressure && !isPawnBreakthrough && !hasPawnStorm;
  const afterMateForPlayer = isMateForPlayer(metrics.afterLine);

  if (hasQueenSacrifice) {
    if (Number.isFinite(materialBalanceBefore) && materialBalanceBefore > 8) {
      return rejectProfile("queen sacrifice starts from too much material");
    }

    if (candidate.captured === "q") {
      return rejectProfile("queen-for-queen capture is not a queen lure");
    }

    if (
      !givesCheck &&
      candidate.captured === "r" &&
      Number.isFinite(materialBalanceBefore) &&
      materialBalanceBefore < 0
    ) {
      return rejectProfile("queen-for-rook capture from deficit is too direct");
    }

    const quietQueenOffer =
      Number.isFinite(scoreLoss) &&
      scoreLoss <= 90 &&
      Number.isFinite(bestScore) &&
      bestScore >= 100 &&
      bestScore <= 260 &&
      Number.isFinite(afterScoreForPlayer) &&
      afterScoreForPlayer >= 100 &&
      afterScoreForPlayer <= 260;
    const soundQueenSacrifice =
      Number.isFinite(scoreLoss) &&
      scoreLoss <= 80 &&
      Number.isFinite(bestScore) &&
      bestScore >= 100 &&
      bestScore <= 700 &&
      Number.isFinite(afterScoreForPlayer) &&
      afterScoreForPlayer >= 100 &&
      afterScoreForPlayer <= 700;

    const acceptedQueenLure =
      candidate.materialInvitation?.isCandidate &&
      candidate.materialInvitation?.bestCapture?.targetValue >= 9 &&
      Number.isFinite(scoreLoss) &&
      scoreLoss <= 190 &&
      Number.isFinite(afterScoreForPlayer) &&
      afterScoreForPlayer >= 100;

    if (quietQueenOffer) return acceptProfile("quiet queen sacrifice into forced mate");
    if (soundQueenSacrifice) return acceptProfile("queen sacrifice into forced mate");
    if (
      givesCheck &&
      candidate.captured &&
      (acceptedQueenLure || afterMateForPlayer)
    ) {
      const checkingQueenCaptureLure =
        acceptedQueenLure &&
        hasReason(candidate, "sacrifice near king") &&
        Number.isFinite(materialBalanceBefore) &&
        materialBalanceBefore <= 3 &&
        Number.isFinite(scoreLoss) &&
        scoreLoss <= 50 &&
        Number.isFinite(bestScore) &&
        bestScore >= 350 &&
        bestScore <= 800 &&
        Number.isFinite(afterScoreForPlayer) &&
        afterScoreForPlayer >= 350 &&
        afterScoreForPlayer <= 800;

      if (checkingQueenCaptureLure) return acceptProfile("checking queen capture lure");
      return rejectProfile("checking queen lure capture is not selective enough");
    }
    if (
      givesCheck &&
      Number.isFinite(materialBalanceBefore) &&
      materialBalanceBefore > 2 &&
      (acceptedQueenLure || afterMateForPlayer)
    ) {
      return rejectProfile("checking queen lure starts from too much material");
    }
    if (acceptedQueenLure || afterMateForPlayer) return acceptProfile("queen lure into forced mate");
    return rejectProfile("queen sacrifice is not sound enough after best reply");
  }

  if (
    Number.isFinite(materialBalanceBefore) &&
    materialBalanceBefore > 8 &&
    !(quietMateThreat && afterMateForPlayer)
  ) {
    return rejectProfile("side was already materially winning");
  }

  if (centralPawnBreak) {
    const centralInvitedCapture = candidate.materialInvitation?.bestCapture || null;
    if (
      !candidate.captured &&
      !hasReason(candidate, "material invitation near king") &&
      (!centralInvitedCapture ||
        Number(centralInvitedCapture.attackerValue) <= 3 ||
        centralInvitedCapture.piece === "k") &&
      Number.isFinite(bestScore) &&
      bestScore >= 300 &&
      bestScore <= 560 &&
      Number.isFinite(afterScoreForPlayer) &&
      afterScoreForPlayer >= 300 &&
      afterScoreForPlayer <= 460 &&
      Number.isFinite(scoreLoss) &&
      scoreLoss <= 190 &&
      Number.isFinite(materialBalanceBefore) &&
      materialBalanceBefore >= 0 &&
      materialBalanceBefore <= 2
    ) {
      return acceptProfile("central pawn break");
    }

    return rejectProfile("central pawn break is outside the calibrated window");
  }

  if (hasMaterialInvitation) {
    const invitedValue = Number(bestInvitedCapture?.targetValue) || 0;
    const attackerValue = Number(bestInvitedCapture?.attackerValue) || 0;
    const directInvitation = Boolean(bestInvitedCapture?.isMovedPiece || bestInvitedCapture?.newlyAvailable);
    const latentInvitation = Boolean(bestInvitedCapture?.latent);
    const acceptsWithLowValuePiece = attackerValue <= 3 || bestInvitedCapture?.piece === "k";
    const acceptsWithHighValuePiece = attackerValue >= 5 && bestInvitedCapture?.piece !== "k";
    const moveIsEngineSupported =
      (Number.isFinite(playedRank) && playedRank <= 7 && Number.isFinite(scoreLoss) && scoreLoss <= 180) ||
      (candidate.forceClassify && Number.isFinite(scoreLoss) && scoreLoss <= 380);
    const remainsPlayable =
      Number.isFinite(afterScoreForPlayer) &&
      (afterScoreForPlayer >= -80 || (hasSacrifice && afterScoreForPlayer >= -140));
    const isMeaningfulInvitation = invitedValue >= 3 && (acceptsWithLowValuePiece || invitedValue >= 5);
    const kingMotif =
      givesCheck ||
      hasReason(candidate, "sacrifice near king") ||
      hasReason(candidate, "opens king line") ||
      hasReason(candidate, "aims line piece at king") ||
      hasReason(candidate, "creates immediate mate threat") ||
      hasReason(candidate, "material invitation near king");
    const mateThreat = hasReason(candidate, "creates immediate mate threat");
    const directLowValueInvitation = directInvitation && invitedValue >= 3 && acceptsWithLowValuePiece;
    const latentLowValueInvitation = latentInvitation && invitedValue >= 3 && acceptsWithLowValuePiece;
    const directSoundMaterialMotif =
      directInvitation &&
      candidate.piece !== "q" &&
      !(candidate.piece === "r" && !candidate.captured && !givesCheck) &&
      !(candidate.piece === "b" && !hasSacrifice) &&
      !(candidate.piece === "b" && candidate.captured && candidate.captured !== "p") &&
      !(candidate.piece === "b" && afterScoreForPlayer < 0) &&
      !(
        candidate.piece === "b" &&
        candidate.captured === "p" &&
        !givesCheck &&
        Number.isFinite(materialBalanceBefore) &&
        materialBalanceBefore < 0 &&
        !hasReason(candidate, "opens king line") &&
        !hasReason(candidate, "attacks queen") &&
        !hasReason(candidate, "creates immediate mate threat") &&
        !hasReason(candidate, "sacrifice near king")
      ) &&
      !(
        candidate.piece === "b" &&
        candidate.captured === "p" &&
        !givesCheck &&
        !hasReason(candidate, "opens king line") &&
        !hasReason(candidate, "attacks queen") &&
        !hasReason(candidate, "creates immediate mate threat") &&
        !hasReason(candidate, "sacrifice near king") &&
        (!Number.isFinite(scoreLoss) || scoreLoss < 40 || afterScoreForPlayer < 150)
      ) &&
      !(
        candidate.piece === "b" &&
        candidate.captured === "p" &&
        hasReason(candidate, "material invitation near king") &&
        !givesCheck &&
        !hasReason(candidate, "opens king line") &&
        !hasReason(candidate, "attacks queen") &&
        !hasReason(candidate, "creates immediate mate threat") &&
        !hasReason(candidate, "sacrifice near king")
      ) &&
      !(
        candidate.piece === "b" &&
        candidate.captured === "p" &&
        hasReason(candidate, "opens king line") &&
        hasReason(candidate, "creates immediate mate threat") &&
        !hasReason(candidate, "apparently undefended sacrifice") &&
        !hasReason(candidate, "sacrifice near king")
      ) &&
      !(
        candidate.piece === "b" &&
        !candidate.captured &&
        !givesCheck &&
        !hasReason(candidate, "apparently undefended sacrifice") &&
        !hasReason(candidate, "attacks queen") &&
        !hasReason(candidate, "opens king line") &&
        !hasReason(candidate, "creates immediate mate threat") &&
        !hasReason(candidate, "sacrifice near king")
      ) &&
      !(
        candidate.piece === "b" &&
        !candidate.captured &&
        !givesCheck &&
        hasReason(candidate, "attacks queen") &&
        Number.isFinite(afterScoreForPlayer) &&
        afterScoreForPlayer < 330
      ) &&
      !(
        candidate.piece === "b" &&
        !candidate.captured &&
        !givesCheck &&
        Number.isFinite(afterScoreForPlayer) &&
        afterScoreForPlayer < 300
      ) &&
      !(
        candidate.piece === "b" &&
        !candidate.captured &&
        givesCheck &&
        Number.isFinite(materialBalanceBefore) &&
        materialBalanceBefore > 0 &&
        !hasReason(candidate, "apparently undefended sacrifice") &&
        !hasReason(candidate, "creates immediate mate threat")
      ) &&
      !(
        candidate.piece === "b" &&
        !candidate.captured &&
        givesCheck &&
        Number.isFinite(materialBalanceBefore) &&
        materialBalanceBefore > 1
      ) &&
      !(
        candidate.piece === "p" &&
        hasReason(candidate, "pawn breakthrough near king")
      ) &&
      !(
        candidate.piece === "n" &&
        candidate.captured === "p" &&
        !givesCheck &&
        !hasReason(candidate, "apparently undefended sacrifice") &&
        !hasReason(candidate, "attacks queen") &&
        !hasReason(candidate, "creates immediate mate threat") &&
        !hasReason(candidate, "sacrifice near king") &&
        (!Number.isFinite(scoreLoss) || scoreLoss < 40)
      ) &&
      !(
        candidate.piece === "n" &&
        !candidate.captured &&
        !givesCheck &&
        !kingMotif
      ) &&
      !(
        candidate.piece === "n" &&
        !candidate.captured &&
        !hasSacrifice &&
        (!givesCheck || materialBalanceBefore < 0)
      ) &&
      !(
        candidate.piece === "n" &&
        candidate.captured === "p" &&
        !givesCheck &&
        hasReason(candidate, "attacks queen") &&
        Number.isFinite(bestScore) &&
        bestScore < 200
      ) &&
      !(candidate.piece === "n" && candidate.captured === "p" && !givesCheck && afterScoreForPlayer > 500) &&
      !(
        candidate.piece === "r" &&
        candidate.captured === "p" &&
        !givesCheck &&
        Number.isFinite(afterScoreForPlayer) &&
        afterScoreForPlayer < 0 &&
        Number.isFinite(materialBalanceBefore) &&
        materialBalanceBefore < -1
      ) &&
      !(
        candidate.piece === "r" &&
        candidate.captured &&
        !givesCheck &&
        Number.isFinite(bestScore) &&
        bestScore > 650
      ) &&
      !(
        candidate.piece === "r" &&
        givesCheck &&
        candidate.captured &&
        ["b", "n"].includes(candidate.captured) &&
        !hasReason(candidate, "exchange-sacrifice shape")
      ) &&
      !(
        candidate.piece === "r" &&
        ["b", "n"].includes(candidate.captured) &&
        Number.isFinite(playedRank) &&
        playedRank > 3
      ) &&
      !(
        candidate.piece === "b" &&
        candidate.captured === "p" &&
        Number.isFinite(materialBalanceBefore) &&
        materialBalanceBefore < 0
      ) &&
      !(
        candidate.piece === "b" &&
        candidate.captured === "p" &&
        Number.isFinite(materialBalanceBefore) &&
        materialBalanceBefore > 1
      ) &&
      !(
        candidate.piece === "b" &&
        candidate.captured === "p" &&
        givesCheck &&
        Number.isFinite(afterScoreForPlayer) &&
        afterScoreForPlayer < 200
      ) &&
      !(
        candidate.piece === "b" &&
        candidate.captured === "p" &&
        !givesCheck &&
        Number.isFinite(materialBalanceBefore) &&
        materialBalanceBefore > 0 &&
        !hasReason(candidate, "sacrifice near king") &&
        !hasReason(candidate, "opens king line")
      ) &&
      !(
        candidate.piece === "r" &&
        givesCheck &&
        !candidate.captured &&
        Number.isFinite(materialBalanceBefore) &&
        materialBalanceBefore < -6
      ) &&
      !(
        candidate.piece === "r" &&
        givesCheck &&
        !candidate.captured &&
        Number.isFinite(materialBalanceBefore) &&
        materialBalanceBefore < 0 &&
        Number.isFinite(afterScoreForPlayer) &&
        afterScoreForPlayer > 450
      ) &&
      !(candidate.piece === "r" && ["q", "r"].includes(candidate.captured)) &&
      !(
        candidate.piece === "r" &&
        candidate.captured === "p" &&
        !hasSacrifice
      ) &&
      !(
        candidate.piece === "r" &&
        ["b", "n"].includes(candidate.captured) &&
        !givesCheck &&
        !hasSacrifice
      ) &&
      !(
        candidate.piece === "r" &&
        ["b", "n"].includes(candidate.captured) &&
        !givesCheck &&
        Number.isFinite(materialBalanceBefore) &&
        materialBalanceBefore >= 0 &&
        Number.isFinite(afterScoreForPlayer) &&
        afterScoreForPlayer < 100 &&
        !hasReason(candidate, "apparently undefended sacrifice")
      ) &&
      !(
        candidate.piece === "r" &&
        givesCheck &&
        candidate.captured === "p" &&
        Number.isFinite(materialBalanceBefore) &&
        materialBalanceBefore < -1 &&
        !hasReason(candidate, "exchange-sacrifice shape") &&
        !hasReason(candidate, "material can be accepted by low-value piece")
      ) &&
      !(
        candidate.piece === "r" &&
        givesCheck &&
        !candidate.captured &&
        !hasReason(candidate, "apparently undefended sacrifice")
      ) &&
      !(
        candidate.piece === "n" &&
        !candidate.captured &&
        !givesCheck &&
        !hasReason(candidate, "apparently undefended sacrifice") &&
        !hasReason(candidate, "sacrifice near king") &&
        !hasReason(candidate, "creates immediate mate threat")
      ) &&
      !(
        candidate.piece === "n" &&
        !candidate.captured &&
        !givesCheck &&
        Number.isFinite(bestScore) &&
        bestScore < 100
      ) &&
      !(
        candidate.piece === "n" &&
        !candidate.captured &&
        !givesCheck &&
        Number.isFinite(afterScoreForPlayer) &&
        afterScoreForPlayer < 150
      ) &&
      !(
        candidate.piece === "n" &&
        !candidate.captured &&
        !givesCheck &&
        hasReason(candidate, "creates immediate mate threat") &&
        bestInvitedCapture?.targetValue === 3 &&
        Number.isFinite(afterScoreForPlayer) &&
        afterScoreForPlayer <= 160 &&
        !hasReason(candidate, "apparently undefended sacrifice") &&
        !hasReason(candidate, "sacrifice near king") &&
        !hasReason(candidate, "material invitation near king")
      ) &&
      !(
        candidate.piece === "n" &&
        !candidate.captured &&
        !givesCheck &&
        Number.isFinite(playedRank) &&
        playedRank > 3
      ) &&
      !(
        candidate.piece === "n" &&
        !candidate.captured &&
        givesCheck &&
        bestInvitedCapture?.targetValue === 3 &&
        hasSacrifice &&
        Number.isFinite(materialBalanceBefore) &&
        materialBalanceBefore > 0
      ) &&
      !(
        candidate.piece === "n" &&
        !candidate.captured &&
        givesCheck &&
        bestInvitedCapture?.targetValue === 3 &&
        Number.isFinite(materialBalanceBefore) &&
        materialBalanceBefore === 0 &&
        Number.isFinite(afterScoreForPlayer) &&
        afterScoreForPlayer <= 160
      ) &&
      !(
        candidate.piece === "n" &&
        !candidate.captured &&
        givesCheck &&
        bestInvitedCapture?.targetValue >= 9 &&
        !hasSacrifice
      ) &&
      !(
        candidate.piece === "n" &&
        !candidate.captured &&
        givesCheck &&
        Number.isFinite(scoreLoss) &&
        scoreLoss > 80
      ) &&
      !(
        candidate.piece === "n" &&
        !candidate.captured &&
        givesCheck &&
        bestInvitedCapture?.targetValue === 3 &&
        !hasReason(candidate, "creates immediate mate threat") &&
        Number.isFinite(materialBalanceBefore) &&
        materialBalanceBefore <= 1
      ) &&
      !(
        candidate.piece === "n" &&
        !candidate.captured &&
        givesCheck &&
        Number.isFinite(afterScoreForPlayer) &&
        afterScoreForPlayer < 150
      ) &&
      !(
        candidate.piece === "n" &&
        candidate.captured === "p" &&
        givesCheck &&
        Number.isFinite(afterScoreForPlayer) &&
        afterScoreForPlayer < 100 &&
        bestInvitedCapture?.targetValue < 9
      ) &&
      !(
        candidate.piece === "n" &&
        candidate.captured === "p" &&
        !givesCheck &&
        hasReason(candidate, "creates immediate mate threat") &&
        Number.isFinite(afterScoreForPlayer) &&
        afterScoreForPlayer < 130 &&
        !hasReason(candidate, "apparently undefended sacrifice")
      ) &&
      !(
        candidate.piece === "n" &&
        candidate.captured === "p" &&
        !hasSacrifice &&
        bestInvitedCapture?.targetValue === 3
      ) &&
      !(
        candidate.piece === "n" &&
        candidate.captured === "p" &&
        !givesCheck &&
        hasReason(candidate, "attacks queen") &&
        Number.isFinite(materialBalanceBefore) &&
        materialBalanceBefore >= 0 &&
        Number.isFinite(bestScore) &&
        bestScore > 350 &&
        !hasReason(candidate, "apparently undefended sacrifice") &&
        !hasReason(candidate, "sacrifice near king") &&
        !hasReason(candidate, "creates immediate mate threat")
      ) &&
      !(
        candidate.piece === "n" &&
        candidate.captured === "p" &&
        !givesCheck &&
        hasReason(candidate, "attacks high-value target") &&
        bestInvitedCapture?.targetValue === 3 &&
        Number.isFinite(materialBalanceBefore) &&
        materialBalanceBefore === 0 &&
        Number.isFinite(bestScore) &&
        bestScore > 350 &&
        !hasReason(candidate, "material invitation near king") &&
        !hasReason(candidate, "apparently undefended sacrifice")
      ) &&
      !(
        candidate.piece === "n" &&
        candidate.captured === "p" &&
        !givesCheck &&
        hasReason(candidate, "attacks high-value target") &&
        Number.isFinite(materialBalanceBefore) &&
        materialBalanceBefore >= 0 &&
        Number.isFinite(bestScore) &&
        bestScore > 180 &&
        !hasReason(candidate, "sacrifice near king") &&
        !hasReason(candidate, "creates immediate mate threat") &&
        !hasReason(candidate, "material invitation near king")
      ) &&
      !(
        candidate.piece === "n" &&
        candidate.captured === "p" &&
        Number.isFinite(scoreLoss) &&
        scoreLoss > 80
      ) &&
      !(
        candidate.piece === "n" &&
        candidate.captured === "p" &&
        Number.isFinite(afterScoreForPlayer) &&
        afterScoreForPlayer < 100 &&
        !(hasReason(candidate, "apparently undefended sacrifice") && hasReason(candidate, "sacrifice near king"))
      ) &&
      !(
        candidate.piece === "n" &&
        candidate.captured === "p" &&
        Number.isFinite(materialBalanceBefore) &&
        materialBalanceBefore >= 2 &&
        Number.isFinite(afterScoreForPlayer) &&
        afterScoreForPlayer > 300
      ) &&
      (hasSacrifice ||
        kingMotif ||
        hasExchangeInvestment ||
        hasPawnStorm ||
        hasReason(candidate, "pawn breakthrough near king") ||
        hasReason(candidate, "attacks queen"));
    const boundedMaterialEval =
      Number.isFinite(bestScore) &&
      bestScore >= -120 &&
      bestScore <= 900 &&
      Number.isFinite(afterScoreForPlayer) &&
      afterScoreForPlayer >= -140 &&
      afterScoreForPlayer <= 1000;

    if (
      hasPawnStorm &&
      !candidate.captured &&
      hasReason(candidate, "same-file pawn lever") &&
      Number.isFinite(materialBalanceBefore) &&
      materialBalanceBefore >= 1 &&
      materialBalanceBefore <= 2 &&
      Number.isFinite(afterScoreForPlayer) &&
      afterScoreForPlayer <= 450
    ) {
      return acceptProfile("pawn-storm material invitation");
    }

    if (
      candidate.piece === "r" &&
      !candidate.captured &&
      !givesCheck &&
      hasReason(candidate, "exchange-sacrifice shape") &&
      Number.isFinite(materialBalanceBefore) &&
      materialBalanceBefore >= 3 &&
      materialBalanceBefore <= 4 &&
      Number.isFinite(scoreLoss) &&
      scoreLoss <= 190 &&
      Number.isFinite(bestScore) &&
      bestScore >= 500 &&
      bestScore <= 650 &&
      Number.isFinite(afterScoreForPlayer) &&
      afterScoreForPlayer >= 350 &&
      afterScoreForPlayer <= 450
    ) {
      return acceptProfile("advanced rook material invitation");
    }

    if (
      candidate.piece === "b" &&
      candidate.captured === "p" &&
      hasReason(candidate, "sacrifice near king") &&
      hasReason(candidate, "attacks high-value target") &&
      Number.isFinite(materialBalanceBefore) &&
      materialBalanceBefore >= 5 &&
      materialBalanceBefore <= 7 &&
      Number.isFinite(scoreLoss) &&
      scoreLoss <= 60 &&
      Number.isFinite(bestScore) &&
      bestScore >= 200 &&
      bestScore <= 330 &&
      Number.isFinite(afterScoreForPlayer) &&
      afterScoreForPlayer >= 150 &&
      afterScoreForPlayer <= 300
    ) {
      return acceptProfile("high-material bishop sacrifice");
    }

    if (
      candidate.piece === "n" &&
      !candidate.captured &&
      !givesCheck &&
      hasSacrifice &&
      directLowValueInvitation &&
      Number.isFinite(materialBalanceBefore) &&
      materialBalanceBefore === 1 &&
      candidate.sacrifice?.acceptingCaptures?.some((reply) => ["q", "r"].includes(reply.piece)) &&
      Number.isFinite(playedRank) &&
      playedRank <= 5 &&
      Number.isFinite(scoreLoss) &&
      scoreLoss >= 40 &&
      scoreLoss <= 70 &&
      Number.isFinite(bestScore) &&
      bestScore >= 280 &&
      bestScore <= 350 &&
      Number.isFinite(afterScoreForPlayer) &&
      afterScoreForPlayer >= 220 &&
      afterScoreForPlayer <= 300
    ) {
      return acceptProfile("quiet knight high-value backup sacrifice");
    }

    if (
      candidate.piece === "n" &&
      !candidate.captured &&
      !givesCheck &&
      hasSacrifice &&
      directLowValueInvitation &&
      Number.isFinite(materialBalanceBefore) &&
      materialBalanceBefore >= -2 &&
      materialBalanceBefore <= 0 &&
      Number.isFinite(scoreLoss) &&
      scoreLoss <= 20 &&
      Number.isFinite(bestScore) &&
      bestScore >= 20 &&
      bestScore <= 330 &&
      Number.isFinite(afterScoreForPlayer) &&
      afterScoreForPlayer >= 40 &&
      afterScoreForPlayer <= 350
    ) {
      const hasHighValueBackupAcceptance = candidate.sacrifice?.acceptingCaptures?.some((reply) =>
        ["q", "r"].includes(reply.piece)
      );
      const pawnAcceptedKnightSacrifice =
        bestInvitedCapture?.piece === "p" &&
        (bestInvitedCapture?.recapturable ||
          (hasReason(candidate, "sacrifice near king") && hasReason(candidate, "material invitation near king"))) &&
        (materialBalanceBefore < 0 || bestScore >= 100);
      const highValueBackedMinorAcceptance =
        hasHighValueBackupAcceptance &&
        bestScore <= 80 &&
        afterScoreForPlayer <= 80;

      if (!pawnAcceptedKnightSacrifice && !highValueBackedMinorAcceptance) {
        return rejectProfile("quiet knight sacrifice is not selective enough");
      }

      return acceptProfile("quiet knight low-value sacrifice");
    }

    if (
      candidate.piece === "n" &&
      !candidate.captured &&
      givesCheck &&
      hasSacrifice &&
      hasReason(candidate, "sacrifice near king") &&
      directLowValueInvitation &&
      Number.isFinite(materialBalanceBefore) &&
      materialBalanceBefore <= 0 &&
      Number.isFinite(scoreLoss) &&
      scoreLoss <= 25 &&
      Number.isFinite(bestScore) &&
      bestScore >= 300 &&
      bestScore <= 550 &&
      Number.isFinite(afterScoreForPlayer) &&
      afterScoreForPlayer >= 300 &&
      afterScoreForPlayer <= 560
    ) {
      return acceptProfile("checking quiet knight low-value sacrifice");
    }

    if (
      candidate.piece === "r" &&
      ["b", "n"].includes(candidate.captured) &&
      hasSacrifice &&
      hasExchangeInvestment &&
      mateThreat &&
      directLowValueInvitation &&
      Number.isFinite(materialBalanceBefore) &&
      materialBalanceBefore <= 2 &&
      Number.isFinite(scoreLoss) &&
      scoreLoss <= 25 &&
      Number.isFinite(bestScore) &&
      bestScore >= -30 &&
      bestScore <= 460 &&
      Number.isFinite(afterScoreForPlayer) &&
      afterScoreForPlayer >= -30 &&
      afterScoreForPlayer <= 500
    ) {
      return acceptProfile("exchange sacrifice with mate threat");
    }

    if (
      candidate.piece === "b" &&
      candidate.captured === "p" &&
      hasSacrifice &&
      hasReason(candidate, "sacrifice near king") &&
      mateThreat &&
      directLowValueInvitation &&
      Number.isFinite(materialBalanceBefore) &&
      materialBalanceBefore <= 0 &&
      Number.isFinite(scoreLoss) &&
      scoreLoss <= 90 &&
      Number.isFinite(bestScore) &&
      (
        (bestScore >= 180 && bestScore <= 260) ||
        (bestScore >= 420 && bestScore <= 900)
      ) &&
      Number.isFinite(afterScoreForPlayer) &&
      (
        (afterScoreForPlayer >= 160 && afterScoreForPlayer <= 260) ||
        (afterScoreForPlayer >= 450 && afterScoreForPlayer <= 900)
      )
    ) {
      return acceptProfile("bishop pawn sacrifice with mate threat");
    }

    if (
      candidate.piece === "p" &&
      !candidate.captured &&
      !givesCheck &&
      latentInvitation &&
      invitedValue >= 5 &&
      acceptsWithLowValuePiece &&
      bestInvitedCapture?.recapturable &&
      Number.isFinite(materialBalanceBefore) &&
      materialBalanceBefore >= 3 &&
      materialBalanceBefore <= 4 &&
      Number.isFinite(scoreLoss) &&
      scoreLoss <= 35 &&
      Number.isFinite(bestScore) &&
      bestScore >= 300 &&
      bestScore <= 450 &&
      Number.isFinite(afterScoreForPlayer) &&
      afterScoreForPlayer >= 300 &&
      afterScoreForPlayer <= 420
    ) {
      return acceptProfile("quiet pawn major-piece lure");
    }

    if (
      candidate.piece === "n" &&
      !candidate.captured &&
      !givesCheck &&
      !hasSacrifice &&
      latentLowValueInvitation &&
      !bestInvitedCapture?.recapturable &&
      Number.isFinite(materialBalanceBefore) &&
      materialBalanceBefore === 0 &&
      Number.isFinite(scoreLoss) &&
      scoreLoss <= 35 &&
      Number.isFinite(bestScore) &&
      bestScore >= 180 &&
      bestScore <= 280 &&
      Number.isFinite(afterScoreForPlayer) &&
      afterScoreForPlayer >= 180 &&
      afterScoreForPlayer <= 260
    ) {
      return acceptProfile("latent quiet knight material lure");
    }

    if (
      candidate.piece === "q" &&
      candidate.captured === "r" &&
      hasSacrifice &&
      directInvitation &&
      Number.isFinite(materialBalanceBefore) &&
      materialBalanceBefore === 0 &&
      Number.isFinite(scoreLoss) &&
      scoreLoss <= 25 &&
      Number.isFinite(bestScore) &&
      Number.isFinite(afterScoreForPlayer) &&
      (
        (givesCheck &&
          mateThreat &&
          bestScore >= 70 &&
          bestScore <= 180 &&
          afterScoreForPlayer >= 70 &&
          afterScoreForPlayer <= 200) ||
        (!givesCheck &&
          hasReason(candidate, "apparently undefended sacrifice") &&
          bestInvitedCapture?.targetValue >= 9 &&
          bestScore >= 600 &&
          bestScore <= 900 &&
          afterScoreForPlayer >= 600 &&
          afterScoreForPlayer <= 850)
      )
    ) {
      return acceptProfile("queen-for-rook material lure");
    }

    if (
      candidate.piece === "n" &&
      candidate.captured === "p" &&
      !givesCheck &&
      hasPressureTactic &&
      mateThreat &&
      hasReason(candidate, "attacks queen") &&
      directInvitation &&
      Number.isFinite(materialBalanceBefore) &&
      materialBalanceBefore < 0 &&
      Number.isFinite(scoreLoss) &&
      scoreLoss <= 25 &&
      Number.isFinite(bestScore) &&
      bestScore >= 100 &&
      bestScore <= 240 &&
      Number.isFinite(afterScoreForPlayer) &&
      afterScoreForPlayer >= 90 &&
      afterScoreForPlayer <= 240
    ) {
      return acceptProfile("knight pawn-capture queen-pressure lure");
    }

    if (
      candidate.piece === "p" &&
      !candidate.captured &&
      !givesCheck &&
      Number.isFinite(materialBalanceBefore) &&
      materialBalanceBefore >= 1 &&
      materialBalanceBefore <= 2 &&
      Number.isFinite(scoreLoss) &&
      scoreLoss <= 110 &&
      Number.isFinite(bestScore) &&
      bestScore >= 200 &&
      bestScore <= 320 &&
      Number.isFinite(afterScoreForPlayer) &&
      afterScoreForPlayer >= 150 &&
      afterScoreForPlayer <= 220 &&
      !bestInvitedCapture?.recapturable
    ) {
      return acceptProfile("quiet pawn material invitation");
    }

    if (
      candidate.piece === "p" &&
      candidate.captured === "p" &&
      !givesCheck &&
      latentInvitation &&
      acceptsWithLowValuePiece &&
      !bestInvitedCapture?.recapturable &&
      Number.isFinite(materialBalanceBefore) &&
      materialBalanceBefore === 0 &&
      Number.isFinite(scoreLoss) &&
      scoreLoss <= 20 &&
      Number.isFinite(bestScore) &&
      bestScore >= 70 &&
      bestScore <= 140 &&
      Number.isFinite(afterScoreForPlayer) &&
      afterScoreForPlayer >= 70 &&
      afterScoreForPlayer <= 140
    ) {
      return acceptProfile("pawn-capture material invitation");
    }

    if (
      candidate.piece === "r" &&
      !candidate.captured &&
      !givesCheck &&
      directInvitation &&
      bestInvitedCapture?.targetValue >= 5 &&
      bestInvitedCapture?.attackerValue >= 5 &&
      !bestInvitedCapture?.recapturable &&
      !Number.isFinite(playedRank) &&
      Number.isFinite(materialBalanceBefore) &&
      materialBalanceBefore >= 0 &&
      materialBalanceBefore <= 2 &&
      Number.isFinite(scoreLoss) &&
      scoreLoss >= 40 &&
      scoreLoss <= 80 &&
      Number.isFinite(bestScore) &&
      bestScore >= 450 &&
      bestScore <= 700 &&
      Number.isFinite(afterScoreForPlayer) &&
      afterScoreForPlayer >= 450 &&
      afterScoreForPlayer <= 650
    ) {
      return acceptProfile("quiet rook major-piece lure");
    }

    if (
      candidate.piece === "r" &&
      !candidate.captured &&
      !givesCheck &&
      directInvitation &&
      isRookInvasion(candidate) &&
      invitedValue >= 5 &&
      Number.isFinite(materialBalanceBefore) &&
      materialBalanceBefore === 0 &&
      Number.isFinite(scoreLoss) &&
      scoreLoss <= 15 &&
      Number.isFinite(bestScore) &&
      bestScore >= -20 &&
      bestScore <= 120 &&
      Number.isFinite(afterScoreForPlayer) &&
      afterScoreForPlayer >= 50 &&
      afterScoreForPlayer <= 120
    ) {
      return acceptProfile("quiet rook material invitation");
    }

    if (
      candidate.piece === "r" &&
      candidate.captured === "p" &&
      !givesCheck &&
      latentInvitation &&
      !bestInvitedCapture?.recapturable &&
      Number.isFinite(materialBalanceBefore) &&
      materialBalanceBefore <= 0 &&
      Number.isFinite(scoreLoss) &&
      scoreLoss <= 40 &&
      Number.isFinite(bestScore) &&
      bestScore >= 200 &&
      bestScore <= 320 &&
      Number.isFinite(afterScoreForPlayer) &&
      afterScoreForPlayer >= 180 &&
      afterScoreForPlayer <= 280
    ) {
      return acceptProfile("rook pawn-capture latent lure");
    }

    if (
      candidate.piece === "n" &&
      !candidate.captured &&
      !givesCheck &&
      directInvitation &&
      Number.isFinite(materialBalanceBefore) &&
      materialBalanceBefore === 4 &&
      Number.isFinite(scoreLoss) &&
      scoreLoss <= 35 &&
      Number.isFinite(bestScore) &&
      bestScore >= 0 &&
      bestScore <= 120 &&
      Number.isFinite(afterScoreForPlayer) &&
      afterScoreForPlayer >= 0 &&
      afterScoreForPlayer <= 120
    ) {
      return acceptProfile("quiet knight material invitation");
    }

    if (
      candidate.piece === "n" &&
      !candidate.captured &&
      !givesCheck &&
      quietMateThreat &&
      directInvitation &&
      !bestInvitedCapture?.recapturable &&
      Number.isFinite(scoreLoss) &&
      scoreLoss <= 40 &&
      Number.isFinite(bestScore) &&
      bestScore >= 430 &&
      bestScore <= 620 &&
      Number.isFinite(afterScoreForPlayer) &&
      afterScoreForPlayer >= 420 &&
      afterScoreForPlayer <= 620
    ) {
      return acceptProfile("quiet knight mate-threat invitation");
    }

    if (
      candidate.piece === "n" &&
      !candidate.captured &&
      !givesCheck &&
      hasSacrifice &&
      directInvitation &&
      acceptsWithLowValuePiece &&
      Number.isFinite(materialBalanceBefore) &&
      materialBalanceBefore >= 0 &&
      materialBalanceBefore <= 0 &&
      Number.isFinite(scoreLoss) &&
      scoreLoss <= 70 &&
      Number.isFinite(bestScore) &&
      bestScore >= 280 &&
      bestScore <= 380 &&
      Number.isFinite(afterScoreForPlayer) &&
      afterScoreForPlayer >= 200 &&
      afterScoreForPlayer <= 330
    ) {
      return acceptProfile("quiet knight sacrifice invitation");
    }

    if (
      candidate.piece === "q" &&
      candidate.captured === "p" &&
      !givesCheck &&
      latentInvitation &&
      acceptsWithLowValuePiece &&
      bestInvitedCapture?.attackerValue <= 1 &&
      Number.isFinite(scoreLoss) &&
      scoreLoss <= 80 &&
      Number.isFinite(bestScore) &&
      bestScore >= 150 &&
      bestScore <= 260 &&
      Number.isFinite(afterScoreForPlayer) &&
      afterScoreForPlayer >= 180 &&
      afterScoreForPlayer <= 260 &&
      Number.isFinite(materialBalanceBefore) &&
      materialBalanceBefore === 0
    ) {
      return acceptProfile("queen pawn-capture material lure");
    }

    if (
      candidate.piece === "q" &&
      !candidate.captured &&
      !givesCheck &&
      latentInvitation &&
      acceptsWithLowValuePiece &&
      hasReason(candidate, "attacks high-value target") &&
      Number.isFinite(scoreLoss) &&
      scoreLoss <= 90 &&
      Number.isFinite(bestScore) &&
      bestScore >= 300 &&
      bestScore <= 420 &&
      Number.isFinite(afterScoreForPlayer) &&
      afterScoreForPlayer >= 240 &&
      afterScoreForPlayer <= 340 &&
      Number.isFinite(materialBalanceBefore) &&
      materialBalanceBefore >= 0 &&
      materialBalanceBefore <= 1
    ) {
      return acceptProfile("quiet queen pressure material lure");
    }

    if (
      candidate.piece === "q" &&
      !candidate.captured &&
      !givesCheck &&
      quietMateThreat &&
      latentInvitation &&
      acceptsWithLowValuePiece &&
      Number.isFinite(materialBalanceBefore) &&
      materialBalanceBefore >= 0 &&
      materialBalanceBefore <= 1 &&
      Number.isFinite(scoreLoss) &&
      scoreLoss <= 40 &&
      Number.isFinite(bestScore) &&
      bestScore >= 180 &&
      bestScore <= 280 &&
      Number.isFinite(afterScoreForPlayer) &&
      afterScoreForPlayer >= 180 &&
      afterScoreForPlayer <= 260
    ) {
      return acceptProfile("quiet queen mate-threat material lure");
    }

    if (
      candidate.piece === "n" &&
      candidate.captured === "p" &&
      !givesCheck &&
      hasReason(candidate, "creates immediate mate threat") &&
      directInvitation &&
      !bestInvitedCapture?.recapturable &&
      !hasReason(candidate, "sacrifice near king") &&
      !hasReason(candidate, "attacks queen") &&
      !hasReason(candidate, "attacks high-value target") &&
      Number.isFinite(scoreLoss) &&
      scoreLoss <= 60 &&
      Number.isFinite(bestScore) &&
      bestScore >= 180 &&
      bestScore <= 300 &&
      Number.isFinite(afterScoreForPlayer) &&
      afterScoreForPlayer >= 150 &&
      afterScoreForPlayer <= 350 &&
      Number.isFinite(materialBalanceBefore) &&
      materialBalanceBefore < 0
    ) {
      return acceptProfile("knight pawn-capture mate threat");
    }

    if (
      candidate.piece === "n" &&
      candidate.captured === "p" &&
      !givesCheck &&
      hasSacrifice &&
      hasPressureTactic &&
      hasReason(candidate, "attacks queen") &&
      directInvitation &&
      acceptsWithLowValuePiece &&
      Number.isFinite(materialBalanceBefore) &&
      materialBalanceBefore < 0 &&
      Number.isFinite(scoreLoss) &&
      scoreLoss <= 40 &&
      Number.isFinite(bestScore) &&
      bestScore >= -80 &&
      bestScore <= 80 &&
      Number.isFinite(afterScoreForPlayer) &&
      afterScoreForPlayer >= 80 &&
      afterScoreForPlayer <= 180
    ) {
      return acceptProfile("low-eval knight queen fork sacrifice");
    }

    if (
      candidate.piece === "n" &&
      candidate.captured === "p" &&
      hasSacrifice &&
      hasReason(candidate, "sacrifice near king") &&
      hasReason(candidate, "material invitation near king") &&
      acceptsWithLowValuePiece &&
      Number.isFinite(materialBalanceBefore) &&
      materialBalanceBefore <= 1 &&
      Number.isFinite(scoreLoss) &&
      scoreLoss <= 25 &&
      Number.isFinite(bestScore) &&
      bestScore >= -50 &&
      bestScore <= 50 &&
      Number.isFinite(afterScoreForPlayer) &&
      afterScoreForPlayer >= 0 &&
      afterScoreForPlayer <= 60
    ) {
      return acceptProfile("low-eval knight sacrifice near king");
    }

    if (
      candidate.piece === "b" &&
      !candidate.captured &&
      !givesCheck &&
      hasSacrifice &&
      directInvitation &&
      acceptsWithLowValuePiece &&
      Number.isFinite(materialBalanceBefore) &&
      materialBalanceBefore >= 4 &&
      materialBalanceBefore <= 6 &&
      Number.isFinite(scoreLoss) &&
      scoreLoss <= 30 &&
      Number.isFinite(bestScore) &&
      bestScore >= 240 &&
      bestScore <= 330 &&
      Number.isFinite(afterScoreForPlayer) &&
      afterScoreForPlayer >= 220 &&
      afterScoreForPlayer <= 300
    ) {
      return acceptProfile("quiet bishop sacrifice invitation");
    }

    if (
      candidate.piece === "p" &&
      !candidate.captured &&
      !givesCheck &&
      latentInvitation &&
      hasReason(candidate, "material invitation near king") &&
      acceptsWithLowValuePiece &&
      !bestInvitedCapture?.recapturable &&
      Number.isFinite(scoreLoss) &&
      scoreLoss <= 30 &&
      Number.isFinite(bestScore) &&
      bestScore >= 380 &&
      bestScore <= 520 &&
      Number.isFinite(afterScoreForPlayer) &&
      afterScoreForPlayer >= 360 &&
      afterScoreForPlayer <= 520 &&
      Number.isFinite(materialBalanceBefore) &&
      materialBalanceBefore >= 0 &&
      materialBalanceBefore <= 2
    ) {
      return acceptProfile("passed-pawn material lure");
    }

    if (
      candidate.piece === "b" &&
      candidate.captured === "p" &&
      givesCheck &&
      hasReason(candidate, "sacrifice near king") &&
      directInvitation &&
      acceptsWithHighValuePiece &&
      !hasReason(candidate, "creates immediate mate threat") &&
      Number.isFinite(scoreLoss) &&
      scoreLoss <= 60 &&
      Number.isFinite(bestScore) &&
      bestScore >= 250 &&
      bestScore <= 450 &&
      Number.isFinite(afterScoreForPlayer) &&
      afterScoreForPlayer >= 250 &&
      afterScoreForPlayer <= 450 &&
      Number.isFinite(materialBalanceBefore) &&
      materialBalanceBefore <= 2
    ) {
      return acceptProfile("checking bishop material lure");
    }

    if (
      candidate.piece === "b" &&
      !candidate.captured &&
      !givesCheck &&
      (directInvitation || latentInvitation) &&
      !hasSacrifice &&
      !bestInvitedCapture?.recapturable &&
      !hasReason(candidate, "sacrifice near king") &&
      !hasReason(candidate, "creates immediate mate threat") &&
      Number.isFinite(materialBalanceBefore) &&
      materialBalanceBefore <= 0 &&
      Number.isFinite(scoreLoss) &&
      scoreLoss <= 80 &&
      Number.isFinite(bestScore) &&
      bestScore >= -20 &&
      bestScore <= 120 &&
      Number.isFinite(afterScoreForPlayer) &&
      afterScoreForPlayer >= -80 &&
      afterScoreForPlayer <= 80
    ) {
      return acceptProfile("quiet bishop material invitation");
    }

    if (
      isMeaningfulInvitation &&
      directSoundMaterialMotif &&
      boundedMaterialEval &&
      moveIsEngineSupported &&
      remainsPlayable &&
      Number.isFinite(scoreLoss) &&
      scoreLoss <= 130 &&
      (Number.isFinite(playedRank) || scoreLoss <= 90) &&
      Number.isFinite(materialBalanceBefore) &&
      materialBalanceBefore <= 4
    ) {
      if (
        candidate.piece === "n" &&
        !candidate.captured &&
        !givesCheck &&
        Number.isFinite(materialBalanceBefore) &&
        materialBalanceBefore > 1 &&
        !(
          hasSacrifice &&
          hasReason(candidate, "creates immediate mate threat") &&
          hasReason(candidate, "material invitation near king") &&
          Number.isFinite(scoreLoss) &&
          scoreLoss <= 35 &&
          Number.isFinite(bestScore) &&
          bestScore >= 350 &&
          bestScore <= 500 &&
          Number.isFinite(afterScoreForPlayer) &&
          afterScoreForPlayer >= 350 &&
          afterScoreForPlayer <= 500
        )
      ) {
        return rejectProfile("quiet knight offer starts from too much material");
      }

      if (candidate.piece === "n" && candidate.captured && candidate.captured !== "p") {
        return rejectProfile("knight capture wins material too directly");
      }

      if (
        candidate.piece === "n" &&
        candidate.captured &&
        capturedPieceValue >= movedPieceValue &&
        !hasReason(candidate, "creates immediate mate threat")
      ) {
        return rejectProfile("knight capture is not a sacrifice invitation");
      }

      if (
        candidate.piece === "n" &&
        givesCheck &&
        !candidate.captured &&
        !hasSacrifice &&
        !hasReason(candidate, "sacrifice near king")
      ) {
        return rejectProfile("checking knight invitation lacks a sacrifice shape");
      }

      if (
        candidate.piece === "r" &&
        givesCheck &&
        !candidate.captured &&
        bestInvitedCapture?.targetValue >= 9 &&
        bestInvitedCapture?.attackerValue >= 9
      ) {
        return rejectProfile("checking rook queen lure is too direct");
      }

      if (
        candidate.piece === "r" &&
        candidate.captured === "p" &&
        givesCheck &&
        bestInvitedCapture?.attackerValue >= 5
      ) {
        return rejectProfile("checking rook pawn capture is too direct");
      }

      if (
        candidate.piece === "r" &&
        candidate.captured === "p" &&
        Number.isFinite(materialBalanceBefore) &&
        (givesCheck ? materialBalanceBefore > 2 : materialBalanceBefore >= 1)
      ) {
        return rejectProfile("rook pawn capture starts from too much material");
      }

      if (
        candidate.piece === "r" &&
        givesCheck &&
        !candidate.captured &&
        Number.isFinite(materialBalanceBefore) &&
        materialBalanceBefore < 0 &&
        Number.isFinite(afterScoreForPlayer) &&
        afterScoreForPlayer > 410
      ) {
        return rejectProfile("checking rook offer is already too forcing");
      }

      if (
        candidate.piece === "r" &&
        candidate.captured === "p" &&
        !hasReason(candidate, "apparently undefended sacrifice") &&
        !hasReason(candidate, "creates immediate mate threat") &&
        (Number.isFinite(materialBalanceBefore) && materialBalanceBefore >= -1) &&
        (Number.isFinite(afterScoreForPlayer) && afterScoreForPlayer < 180)
      ) {
        return rejectProfile("rook pawn capture is too direct");
      }

      if (
        candidate.piece === "r" &&
        ["b", "n"].includes(candidate.captured) &&
        !mateThreat &&
        Number.isFinite(afterScoreForPlayer) &&
        afterScoreForPlayer < 300 &&
        !(
          Number.isFinite(materialBalanceBefore) &&
          materialBalanceBefore <= -5
        ) &&
        !(Number.isFinite(afterScoreForPlayer) && afterScoreForPlayer < -20) &&
        !hasReason(candidate, "sacrifice near king")
      ) {
        return rejectProfile("rook minor-piece capture lacks a mate threat");
      }

      if (
        candidate.piece === "r" &&
        ["b", "n"].includes(candidate.captured) &&
        !hasReason(candidate, "sacrifice near king") &&
        !hasReason(candidate, "apparently undefended sacrifice")
      ) {
        return rejectProfile("rook minor-piece capture is too direct");
      }

      if (
        candidate.piece === "r" &&
        ["b", "n"].includes(candidate.captured) &&
        !hasReason(candidate, "sacrifice near king") &&
        Number.isFinite(materialBalanceBefore) &&
        materialBalanceBefore >= 2 &&
        Number.isFinite(afterScoreForPlayer) &&
        afterScoreForPlayer < 150
      ) {
        return rejectProfile("rook capture is not forcing enough");
      }

      if (
        candidate.piece === "r" &&
        candidate.captured === "p" &&
        !givesCheck &&
        bestInvitedCapture?.recapturable &&
        bestInvitedCapture?.attackerValue >= 5 &&
        !hasReason(candidate, "sacrifice near king") &&
        !hasReason(candidate, "material invitation near king") &&
        !hasReason(candidate, "creates immediate mate threat")
      ) {
        return rejectProfile("rook pawn capture is just recapturable material");
      }

      if (
        candidate.piece === "b" &&
        candidate.captured === "p" &&
        Number.isFinite(materialBalanceBefore) &&
        materialBalanceBefore > 0 &&
        !givesCheck &&
        !hasReason(candidate, "opens king line") &&
        !(bestInvitedCapture?.targetValue >= 5)
      ) {
        return rejectProfile("bishop pawn capture starts from too much material");
      }

      if (
        candidate.piece === "b" &&
        !candidate.captured &&
        !givesCheck &&
        hasReason(candidate, "attacks queen") &&
        Number.isFinite(materialBalanceBefore) &&
        materialBalanceBefore > 0 &&
        !(
          Number.isFinite(playedRank) &&
          playedRank >= 5 &&
          Number.isFinite(scoreLoss) &&
          scoreLoss >= 40 &&
          Number.isFinite(bestScore) &&
          bestScore >= 400 &&
          Number.isFinite(afterScoreForPlayer) &&
          afterScoreForPlayer >= 320 &&
          afterScoreForPlayer <= 420
        )
      ) {
        return rejectProfile("quiet bishop queen attack starts from too much material");
      }

      if (
        candidate.piece === "b" &&
        !candidate.captured &&
        givesCheck &&
        bestInvitedCapture?.attackerValue >= 5 &&
        Number.isFinite(afterScoreForPlayer) &&
        afterScoreForPlayer > 550
      ) {
        return rejectProfile("checking bishop offer is too direct");
      }

      if (
        candidate.piece === "b" &&
        !candidate.captured &&
        Number.isFinite(materialBalanceBefore) &&
        materialBalanceBefore > 2
      ) {
        return rejectProfile("bishop offer starts from too much material");
      }

      if (
        candidate.piece === "b" &&
        !candidate.captured &&
        givesCheck &&
        !hasReason(candidate, "sacrifice near king") &&
        (Number.isFinite(playedRank) && playedRank > 3 || Number.isFinite(scoreLoss) && scoreLoss > 80)
      ) {
        return rejectProfile("checking bishop offer is not engine-supported enough");
      }

      if (
        candidate.piece === "b" &&
        candidate.captured === "p" &&
        Number.isFinite(playedRank) &&
        playedRank > 3 &&
        Number.isFinite(scoreLoss) &&
        scoreLoss > 80
      ) {
        return rejectProfile("bishop pawn capture is not engine-supported enough");
      }

      if (
        candidate.piece === "b" &&
        candidate.captured === "p" &&
        Number.isFinite(afterScoreForPlayer) &&
        afterScoreForPlayer < 180 &&
        !hasReason(candidate, "apparently undefended sacrifice") &&
        !hasReason(candidate, "sacrifice near king") &&
        !hasReason(candidate, "creates immediate mate threat")
      ) {
        return rejectProfile("bishop pawn capture is not forcing enough");
      }

      if (
        candidate.piece === "b" &&
        candidate.captured === "p" &&
        hasReason(candidate, "sacrifice near king") &&
        hasReason(candidate, "creates immediate mate threat") &&
        !givesCheck &&
        !hasReason(candidate, "apparently undefended sacrifice") &&
        !hasReason(candidate, "opens king line") &&
        !hasReason(candidate, "attacks high-value target")
      ) {
        return rejectProfile("bishop pawn capture lacks a forcing anchor");
      }

      if (
        candidate.piece === "n" &&
        !candidate.captured &&
        !givesCheck &&
        hasSacrifice &&
        Number.isFinite(afterScoreForPlayer) &&
        afterScoreForPlayer < 220 &&
        !(Number.isFinite(materialBalanceBefore) && materialBalanceBefore >= 4) &&
        !hasReason(candidate, "apparently undefended sacrifice") &&
        !hasReason(candidate, "sacrifice near king") &&
        !hasReason(candidate, "material invitation near king")
      ) {
        return rejectProfile("quiet knight offer is not forcing enough");
      }

      if (
        candidate.piece === "n" &&
        !candidate.captured &&
        !givesCheck &&
        hasReason(candidate, "apparently undefended sacrifice") &&
        hasReason(candidate, "creates immediate mate threat") &&
        !hasReason(candidate, "sacrifice near king") &&
        !hasReason(candidate, "material invitation near king") &&
        Number.isFinite(afterScoreForPlayer) &&
        afterScoreForPlayer < 260
      ) {
        return rejectProfile("quiet knight mate threat lacks a near-king anchor");
      }

      if (
        candidate.piece === "n" &&
        candidate.captured === "p" &&
        givesCheck &&
        bestInvitedCapture?.targetValue >= 9 &&
        !hasReason(candidate, "creates immediate mate threat")
      ) {
        return rejectProfile("checking knight pawn capture over-flags queen lures");
      }

      if (
        candidate.piece === "n" &&
        candidate.captured === "p" &&
        Number.isFinite(afterScoreForPlayer) &&
        afterScoreForPlayer > 400 &&
        !hasReason(candidate, "creates immediate mate threat") &&
        !hasReason(candidate, "sacrifice near king") &&
        !hasReason(candidate, "material invitation near king")
      ) {
        return rejectProfile("knight pawn capture is too forcing");
      }

      if (
        candidate.piece === "n" &&
        candidate.captured === "p" &&
        hasReason(candidate, "creates immediate mate threat") &&
        !hasReason(candidate, "sacrifice near king") &&
        !hasReason(candidate, "material invitation near king") &&
        !hasReason(candidate, "apparently undefended sacrifice") &&
        Number.isFinite(materialBalanceBefore) &&
        materialBalanceBefore >= 0 &&
        Number.isFinite(bestScore) &&
        bestScore < 240 &&
        Number.isFinite(afterScoreForPlayer) &&
        afterScoreForPlayer > 180
      ) {
        return rejectProfile("knight pawn capture is too ordinary");
      }

      if (
        candidate.piece === "n" &&
        candidate.captured === "p" &&
        !givesCheck &&
        hasReason(candidate, "apparently undefended sacrifice") &&
        !hasReason(candidate, "attacks queen") &&
        !hasReason(candidate, "sacrifice near king") &&
        !hasReason(candidate, "material invitation near king") &&
        !hasReason(candidate, "creates immediate mate threat") &&
        bestInvitedCapture?.targetValue === 3 &&
        bestInvitedCapture?.attackerValue === 3 &&
        Number.isFinite(materialBalanceBefore) &&
        materialBalanceBefore === 0 &&
        Number.isFinite(bestScore) &&
        (bestScore < 120 || bestScore > 240)
      ) {
        return rejectProfile("equal-knight pawn capture is outside the brilliant window");
      }

      return acceptProfile("sound material invitation");
    }

    if (
      invitedValue >= 3 &&
      acceptsWithHighValuePiece &&
      Number.isFinite(playedRank) &&
      playedRank <= 2 &&
      Number.isFinite(scoreLoss) &&
      scoreLoss <= 35 &&
      Number.isFinite(bestScore) &&
      bestScore >= 50 &&
      bestScore <= 240 &&
      Number.isFinite(afterScoreForPlayer) &&
      afterScoreForPlayer >= 50 &&
      afterScoreForPlayer <= 240
    ) {
      if (
        candidate.piece === "n" &&
        candidate.captured === "p" &&
        directInvitation &&
        !bestInvitedCapture?.recapturable &&
        hasPressureTactic &&
        Number.isFinite(materialBalanceBefore) &&
        materialBalanceBefore === 1 &&
        Number.isFinite(bestScore) &&
        bestScore >= 180 &&
        bestScore <= 300 &&
        Number.isFinite(afterScoreForPlayer) &&
        afterScoreForPlayer >= 150 &&
        afterScoreForPlayer <= 260
      ) {
        return acceptProfile("knight pressure pawn lure");
      }

      const selectiveHighValueInvitation =
        (candidate.piece === "n" &&
          candidate.captured === "p" &&
          materialBalanceBefore === 1 &&
          !hasPressureTactic) ||
        (candidate.piece === "p" &&
          Boolean(candidate.captured) &&
          candidate.captured !== "p" &&
          materialBalanceBefore === 0 &&
          directInvitation &&
          invitedValue >= 5 &&
          !bestInvitedCapture?.recapturable);

      if (!selectiveHighValueInvitation) {
        return rejectProfile("high-value material invitation is not selective enough");
      }

      return acceptProfile("high-value acceptance material invitation");
    }

    if (
      candidate.piece === "b" &&
      !candidate.captured &&
      givesCheck &&
      hasReason(candidate, "aims line piece at king") &&
      directInvitation &&
      Number.isFinite(materialBalanceBefore) &&
      materialBalanceBefore <= -1 &&
      Number.isFinite(scoreLoss) &&
      scoreLoss <= 35 &&
      Number.isFinite(bestScore) &&
      bestScore >= -120 &&
      bestScore <= 120 &&
      Number.isFinite(afterScoreForPlayer) &&
      afterScoreForPlayer >= -120 &&
      afterScoreForPlayer <= 120
    ) {
      return acceptProfile("checking line-piece material invitation");
    }

    if (
      (candidate.piece === "k" || (candidate.piece === "b" && !candidate.captured)) &&
      (candidate.piece !== "b" ||
        (!givesCheck &&
          !hasSacrifice &&
          invitedValue <= 3 &&
          Number.isFinite(materialBalanceBefore) &&
          materialBalanceBefore === 2 &&
          !hasReason(candidate, "sacrifice near king") &&
          !hasReason(candidate, "attacks high-value target") &&
          !hasReason(candidate, "acceptance remains tactically contested"))) &&
      (candidate.piece !== "k" || /^O-O[+#]?$/.test(candidate.san || "")) &&
      Number.isFinite(scoreLoss) &&
      scoreLoss <= 80 &&
      Number.isFinite(afterScoreForPlayer) &&
      afterScoreForPlayer >= (candidate.piece === "k" ? 350 : 180) &&
      afterScoreForPlayer <= 380
    ) {
      return acceptProfile("quiet development material invitation");
    }

    if (
      candidate.piece === "b" &&
      candidate.captured &&
      candidate.captured === "p" &&
      !givesCheck &&
      !hasSacrifice &&
      invitedValue === 3 &&
      directInvitation &&
      !bestInvitedCapture?.recapturable &&
      hasReason(candidate, "material invitation near king") &&
      Number.isFinite(materialBalanceBefore) &&
      materialBalanceBefore <= -1 &&
      Number.isFinite(scoreLoss) &&
      scoreLoss <= 45 &&
      Number.isFinite(bestScore) &&
      bestScore >= -80 &&
      bestScore <= 120 &&
      Number.isFinite(afterScoreForPlayer) &&
      afterScoreForPlayer >= -80 &&
      afterScoreForPlayer <= 120
    ) {
      return acceptProfile("balanced bishop material invitation");
    }

  }

  if (quietPieceSacrifice && candidate.piece === "r") {
    if (
      hasReason(candidate, "exchange-sacrifice shape") &&
      Number.isFinite(materialBalanceBefore) &&
      materialBalanceBefore <= 4 &&
      Number.isFinite(bestScore) &&
      bestScore >= 350 &&
      bestScore <= 650 &&
      Number.isFinite(afterScoreForPlayer) &&
      afterScoreForPlayer >= 350 &&
      afterScoreForPlayer <= 450 &&
      Number.isFinite(scoreLoss) &&
      scoreLoss <= 190
    ) {
      return acceptProfile("quiet rook sacrifice");
    }

    return rejectProfile("quiet rook sacrifice is outside the calibrated window");
  }

  if (hasPressureTactic) {
    const anchoredQueenPressure =
      hasReason(candidate, "creates immediate mate threat") ||
      hasReason(candidate, "opens king line") ||
      candidate.materialInvitation?.bestCapture?.targetValue >= 5;

    if (
      candidate.piece === "q" &&
      !candidate.captured &&
      hasReason(candidate, "attacks high-value target") &&
      Number.isFinite(materialBalanceBefore) &&
      materialBalanceBefore <= 4 &&
      Number.isFinite(scoreLoss) &&
      scoreLoss <= 380 &&
      Number.isFinite(bestScore) &&
      bestScore >= 800 &&
      bestScore <= 950 &&
      Number.isFinite(afterScoreForPlayer) &&
      afterScoreForPlayer >= 450 &&
      afterScoreForPlayer <= 650
    ) {
      return acceptProfile("high-eval queen pressure");
    }

    if (
      candidate.piece === "q" &&
      !candidate.captured &&
      hasReason(candidate, "queen pressure near king") &&
      hasMaterialInvitation &&
      !bestInvitedCapture?.recapturable &&
      Number.isFinite(materialBalanceBefore) &&
      materialBalanceBefore === 0 &&
      Number.isFinite(scoreLoss) &&
      scoreLoss <= 120 &&
      Number.isFinite(bestScore) &&
      bestScore >= 40 &&
      bestScore <= 120 &&
      Number.isFinite(afterScoreForPlayer) &&
      afterScoreForPlayer >= -80 &&
      afterScoreForPlayer <= 0
    ) {
      return acceptProfile("low-eval queen pressure");
    }

    if (
      candidate.piece === "q" &&
      (mateInOneThreat || hasReason(candidate, "queen pressure near king")) &&
      anchoredQueenPressure &&
      !hasSacrifice &&
      Number.isFinite(bestScore) &&
      bestScore >= 450 &&
      bestScore <= 800 &&
      Number.isFinite(materialBalanceBefore) &&
      materialBalanceBefore <= 4 &&
      Number.isFinite(afterScoreForPlayer) &&
      afterScoreForPlayer >= 500 &&
      afterScoreForPlayer <= 750
    ) {
      return acceptProfile("quiet queen pressure");
    }

    if (
      candidate.piece === "q" &&
      hasReason(candidate, "attacks high-value target") &&
      !candidate.captured &&
      anchoredQueenPressure &&
      !hasSacrifice &&
      Number.isFinite(bestScore) &&
      bestScore >= 600 &&
      bestScore <= 750 &&
      Number.isFinite(materialBalanceBefore) &&
      materialBalanceBefore <= 4 &&
      Number.isFinite(afterScoreForPlayer) &&
      afterScoreForPlayer >= 500 &&
      afterScoreForPlayer <= 650
    ) {
      return acceptProfile("quiet queen pressure");
    }

    if (
      candidate.piece === "b" &&
      hasSacrifice &&
      Boolean(candidate.captured) &&
      hasReason(candidate, "attacks queen") &&
      Number.isFinite(materialBalanceBefore) &&
      materialBalanceBefore <= 2 &&
      Number.isFinite(bestScore) &&
      bestScore >= 250 &&
      bestScore <= 550 &&
      Number.isFinite(afterScoreForPlayer) &&
      afterScoreForPlayer >= 250 &&
      afterScoreForPlayer <= 500 &&
      Number.isFinite(scoreLoss) &&
      scoreLoss <= 100
    ) {
      return acceptProfile("bishop queen-pressure sacrifice");
    }

    if (
      candidate.piece === "n" &&
      !candidate.captured &&
      hasReason(candidate, "multi-target pressure") &&
      Number.isFinite(bestScore) &&
      bestScore >= 250 &&
      bestScore <= 450 &&
      Number.isFinite(afterScoreForPlayer) &&
      afterScoreForPlayer >= 200 &&
      afterScoreForPlayer <= 400 &&
      Number.isFinite(scoreLoss) &&
      scoreLoss <= 100
    ) {
      return acceptProfile("knight multi-target pressure");
    }

    if (
      candidate.piece === "n" &&
      candidate.captured &&
      candidate.captured === "p" &&
      !givesCheck &&
      hasReason(candidate, "attacks high-value target") &&
      hasMaterialInvitation &&
      Number.isFinite(materialBalanceBefore) &&
      materialBalanceBefore >= 1 &&
      Number.isFinite(bestScore) &&
      bestScore >= 250 &&
      bestScore <= 450 &&
      Number.isFinite(afterScoreForPlayer) &&
      afterScoreForPlayer >= 200 &&
      afterScoreForPlayer <= 400 &&
      Number.isFinite(scoreLoss) &&
      scoreLoss <= 100
    ) {
      return acceptProfile("knight pressure capture");
    }
  }

  if (candidate.piece === "n" && givesCheck && !candidate.captured && hasSacrifice) {
    if (
      Number.isFinite(materialBalanceBefore) &&
      materialBalanceBefore >= 0 &&
      materialBalanceBefore <= 0 &&
      (hasReason(candidate, "attacks queen") || hasReason(candidate, "sacrifice near king")) &&
      (bestInvitedCapture?.targetValue >= 5 ||
        hasReason(candidate, "creates immediate mate threat") ||
        hasReason(candidate, "apparently undefended sacrifice")) &&
      Number.isFinite(bestScore) &&
      bestScore >= 150 &&
      bestScore <= 700 &&
      Number.isFinite(afterScoreForPlayer) &&
      afterScoreForPlayer >= 150 &&
      afterScoreForPlayer <= 700 &&
      Number.isFinite(scoreLoss) &&
      scoreLoss <= 90 &&
      (!Number.isFinite(playedRank) || playedRank <= 3)
    ) {
      return acceptProfile("checking quiet knight sacrifice");
    }

    if (
      hasReason(candidate, "apparently undefended sacrifice") &&
      hasReason(candidate, "material invitation near king") &&
      Number.isFinite(materialBalanceBefore) &&
      materialBalanceBefore <= 1 &&
      Number.isFinite(bestScore) &&
      bestScore >= 250 &&
      bestScore <= 450 &&
      Number.isFinite(afterScoreForPlayer) &&
      afterScoreForPlayer >= 250 &&
      afterScoreForPlayer <= 450 &&
      Number.isFinite(scoreLoss) &&
      scoreLoss <= 25
    ) {
      return acceptProfile("checking quiet knight sacrifice");
    }

    return rejectProfile("checking quiet knight sacrifice is outside the calibrated window");
  }

  if (
    candidate.piece === "n" &&
    givesCheck &&
    candidate.captured &&
    hasSacrifice &&
    hasReason(candidate, "creates immediate mate threat")
  ) {
    if (
      Number.isFinite(materialBalanceBefore) &&
      materialBalanceBefore === 0 &&
      Number.isFinite(afterScoreForPlayer) &&
      afterScoreForPlayer >= 100
    ) {
      return acceptProfile("checking knight sacrifice near king");
    }

    return rejectProfile("checking knight sacrifice starts from too much material");
  }

  if (candidate.piece === "b" && givesCheck && hasSacrifice) {
    if (
      Number.isFinite(bestScore) &&
      bestScore >= 150 &&
      bestScore <= 350 &&
      Number.isFinite(afterScoreForPlayer) &&
      afterScoreForPlayer >= 150 &&
      afterScoreForPlayer <= 350 &&
      Number.isFinite(scoreLoss) &&
      scoreLoss <= 90 &&
      Number.isFinite(materialBalanceBefore) &&
      materialBalanceBefore <= 2
    ) {
      return acceptProfile("checking bishop sacrifice near king");
    }

    return rejectProfile("checking bishop sacrifice is outside the calibrated window");
  }

  if (candidate.piece === "b" && candidate.captured && hasSacrifice) {
    const materialOnlyBishopCapture =
      !hasReason(candidate, "creates immediate mate threat") &&
      !hasReason(candidate, "opens king line") &&
      !hasReason(candidate, "sacrifice near king") &&
      Number.isFinite(materialBalanceBefore) &&
      materialBalanceBefore <= 0;
    const tacticalBishopCapture =
      hasReason(candidate, "creates immediate mate threat") ||
      hasReason(candidate, "opens king line") ||
      hasReason(candidate, "sacrifice near king") ||
      (Number.isFinite(materialBalanceBefore) && materialBalanceBefore <= 0);

    if (
      tacticalBishopCapture &&
      hasReason(candidate, "apparently undefended sacrifice") &&
      (!materialOnlyBishopCapture || materialBalanceBefore >= 0) &&
      !(
        hasReason(candidate, "opens king line") &&
        hasReason(candidate, "creates immediate mate threat") &&
        !hasReason(candidate, "apparently undefended sacrifice") &&
        !hasReason(candidate, "sacrifice near king")
      ) &&
      Number.isFinite(bestScore) &&
      bestScore >= 180 &&
      bestScore <= 550 &&
      Number.isFinite(materialBalanceBefore) &&
      materialBalanceBefore <= 2 &&
      Number.isFinite(afterScoreForPlayer) &&
      afterScoreForPlayer >= 150 &&
      afterScoreForPlayer <= 550 &&
      Number.isFinite(scoreLoss) &&
      scoreLoss <= 140 &&
      (!materialOnlyBishopCapture || scoreLoss >= 40)
    ) {
      return acceptProfile("bishop capture sacrifice");
    }

    return rejectProfile("bishop capture sacrifice is outside the calibrated window");
  }

  if (candidate.piece === "n" && !givesCheck && !candidate.captured && hasSacrifice) {
    if (
      Number.isFinite(materialBalanceBefore) &&
      materialBalanceBefore <= 0 &&
      (
        hasReason(candidate, "apparently undefended sacrifice") ||
        hasReason(candidate, "sacrifice near king") ||
        hasReason(candidate, "material invitation near king")
      ) &&
      Number.isFinite(bestScore) &&
      bestScore >= 200 &&
      bestScore <= 330 &&
      Number.isFinite(afterScoreForPlayer) &&
      afterScoreForPlayer >= 200 &&
      afterScoreForPlayer <= 350 &&
      Number.isFinite(scoreLoss) &&
      scoreLoss <= 80
    ) {
      return acceptProfile("quiet knight sacrifice near king");
    }

    return rejectProfile("quiet knight sacrifice is outside the calibrated window");
  }

  if (
    candidate.piece === "n" &&
    !givesCheck &&
    candidate.captured &&
    hasSacrifice &&
    hasReason(candidate, "creates immediate mate threat")
  ) {
    if (
      Number.isFinite(materialBalanceBefore) &&
      materialBalanceBefore >= 0 &&
      materialBalanceBefore <= 1 &&
      (hasReason(candidate, "attacks queen") || hasReason(candidate, "sacrifice near king")) &&
      Number.isFinite(bestScore) &&
      bestScore >= -120 &&
      bestScore <= 700 &&
      Number.isFinite(afterScoreForPlayer) &&
      afterScoreForPlayer >= -140 &&
      afterScoreForPlayer <= 750
    ) {
      return acceptProfile("accepted knight sacrifice");
    }

    return rejectProfile("accepted knight mate threat is outside the calibrated window");
  }

  if (!Number.isFinite(playedRank) || playedRank > 3) {
    return rejectProfile("not close enough to the engine's top choice");
  }

  if (!Number.isFinite(scoreLoss) || scoreLoss > 80) {
    return rejectProfile("too much engine score loss for a Chess.com-style Brilliant");
  }

  if (hasExchangeInvestment) {
    const exchangeMaterialWindow =
      Number.isFinite(materialBalanceBefore) &&
      materialBalanceBefore >= -6 &&
      materialBalanceBefore <= 3;
    const exchangeEvalWindow =
      Number.isFinite(bestScore) &&
      bestScore >= -120 &&
      bestScore <= 180 &&
      Number.isFinite(afterScoreForPlayer) &&
      afterScoreForPlayer >= -80 &&
      afterScoreForPlayer <= 260;

    const checkingExchangeEvalWindow =
      Number.isFinite(bestScore) &&
      bestScore >= 300 &&
      bestScore <= 900 &&
      Number.isFinite(afterScoreForPlayer) &&
      afterScoreForPlayer >= 300 &&
      afterScoreForPlayer <= 1000;

    if (
      candidate.piece === "r" &&
      givesCheck &&
      hasSacrifice &&
      playedRank <= 2 &&
      scoreLoss <= 25 &&
      exchangeMaterialWindow &&
      checkingExchangeEvalWindow
    ) {
      return acceptProfile("checking exchange sacrifice");
    }

    if (
      candidate.piece === "r" &&
      !givesCheck &&
      !hasSacrifice &&
      playedRank === 1 &&
      scoreLoss <= 35 &&
      bestScore > 10 &&
      afterScoreForPlayer >= 5 &&
      exchangeMaterialWindow &&
      Number.isFinite(materialBalanceBefore) &&
      materialBalanceBefore >= 0 &&
      exchangeEvalWindow
    ) {
      return acceptProfile("competitive exchange investment");
    }

    return rejectProfile("exchange investment is not selective enough");
  }

  if (!Number.isFinite(bestScore) || bestScore < 100 || bestScore > 900) {
    return rejectProfile("engine evaluation is outside the calibrated Brilliant window");
  }

  if (
    !Number.isFinite(afterScoreForPlayer) ||
    afterScoreForPlayer < 100 ||
    (afterScoreForPlayer > 1000 && !(quietMateThreat && afterMateForPlayer))
  ) {
    return rejectProfile("post-move evaluation is outside the calibrated Brilliant window");
  }

  if (promotionOnly) {
    return rejectProfile("promotion tactic is not enough without a sacrifice or pawn breakthrough");
  }

  if (candidate.piece === "p" && givesCheck) {
    return rejectProfile("checking pawn lever over-flags this benchmark");
  }

  if (hasPawnStorm) {
    const sameFileLever = hasReason(candidate, "same-file pawn lever");
    const quietStorm = !candidate.captured;
    const materialWindow =
      Number.isFinite(materialBalanceBefore) &&
      materialBalanceBefore >= 1 &&
      materialBalanceBefore <= 2;

    if (
      quietStorm &&
      sameFileLever &&
      materialWindow &&
      Number.isFinite(afterScoreForPlayer) &&
      afterScoreForPlayer <= 450
    ) {
      return acceptProfile("pawn-storm lever");
    }

    if (
      quietStorm &&
      hasMaterialInvitation &&
      candidate.materialInvitation?.bestCapture?.latent &&
      hasReason(candidate, "material invitation near king") &&
      Number.isFinite(materialBalanceBefore) &&
      materialBalanceBefore === 0 &&
      Number.isFinite(scoreLoss) &&
      scoreLoss <= 35 &&
      Number.isFinite(bestScore) &&
      bestScore >= 100 &&
      bestScore <= 200 &&
      Number.isFinite(afterScoreForPlayer) &&
      afterScoreForPlayer >= 80 &&
      afterScoreForPlayer <= 180
    ) {
      return acceptProfile("pawn-storm latent material lure");
    }

    if (
      !quietStorm &&
      materialWindow &&
      !candidate.materialInvitation?.bestCapture?.latent
    ) {
      return acceptProfile("pawn-storm capture");
    }

    return rejectProfile("pawn storm is outside the calibrated material window");
  }

  if (isPawnBreakthrough) {
    if (givesCheck && candidate.captured && !hasPawnStorm) {
      return rejectProfile("checking pawn capture is not a selective pawn breakthrough");
    }

    const lowValueAcceptanceCount = candidate.sacrifice?.materialRiskCaptures?.length || 0;
    const inBreakthroughEvalWindow =
      bestScore >= 340 &&
      bestScore <= 430 &&
      afterScoreForPlayer >= 380 &&
      afterScoreForPlayer <= 450;

    if (
      candidate.captured === "p" &&
      lowValueAcceptanceCount === 0 &&
      inBreakthroughEvalWindow &&
      Number.isFinite(materialBalanceBefore) &&
      materialBalanceBefore <= 2
    ) {
      return acceptProfile("pawn breakthrough");
    }

    if (lowValueAcceptanceCount === 0) {
      return rejectProfile("pawn breakthrough evaluation is outside the calibrated window");
    }

    return rejectProfile("pawn breakthrough is too easily accepted by low-value material");
  }

  if (quietMateThreat) {
    if (candidate.piece === "n") {
      if (
        afterScoreForPlayer >= 800 &&
        Number.isFinite(materialBalanceBefore) &&
        materialBalanceBefore <= 2
      ) {
        return acceptProfile("quiet knight mate threat");
      }
      return rejectProfile("quiet knight threat is not forcing enough");
    }

    if (candidate.piece === "q") {
      if (
        playedRank === 3 &&
        scoreLoss >= 30 &&
        Number.isFinite(afterScoreForPlayer) &&
        afterScoreForPlayer >= 500 &&
        Number.isFinite(materialBalanceBefore) &&
        materialBalanceBefore >= 4
      ) {
        return acceptProfile("quiet queen mate threat");
      }
      return rejectProfile("quiet queen threat is not selective enough");
    }

    return rejectProfile("quiet mate threat shape is not selective enough");
  }

  if (
    givesCheck &&
    candidate.captured &&
    ["b", "n"].includes(candidate.piece) &&
    hasReason(candidate, "sacrifice near king")
  ) {
    if (
      candidate.piece === "b" &&
      hasSacrifice &&
      Number.isFinite(materialBalanceBefore) &&
      materialBalanceBefore <= 3 &&
      bestScore <= 450 &&
      afterScoreForPlayer <= 550
    ) {
      return acceptProfile("checking bishop sacrifice near king");
    }

    if (
      candidate.piece === "n" &&
      hasReason(candidate, "creates immediate mate threat") &&
      (candidate.sacrifice?.acceptingCaptures?.length || 0) > 0 &&
      Number.isFinite(materialBalanceBefore) &&
      materialBalanceBefore <= 3
    ) {
      return acceptProfile("checking knight sacrifice near king");
    }

    return rejectProfile("checking minor-piece sacrifice is not selective enough");
  }

  if (!hasSacrifice) {
    return rejectProfile("no calibrated sacrifice, pawn lever, or quiet mate threat");
  }

  if (candidate.piece === "n") {
    if (givesCheck && candidate.captured && hasReason(candidate, "sacrifice near king")) {
      return acceptProfile("checking knight sacrifice near king");
    }

    if (!givesCheck && candidate.captured) {
      const mateThreat = hasReason(candidate, "creates immediate mate threat");
      const pawnCanAccept = candidate.sacrifice?.materialRiskCaptures?.some((reply) => reply.piece === "p");
      const apparentlyUndefended = hasReason(candidate, "apparently undefended sacrifice");

      if (mateThreat && Number.isFinite(materialBalanceBefore) && materialBalanceBefore <= 1) {
        return acceptProfile("accepted knight sacrifice");
      }

      if (
        apparentlyUndefended &&
        Number.isFinite(materialBalanceBefore) &&
        materialBalanceBefore <= 0 &&
        Number.isFinite(bestScore) &&
        bestScore <= 180
      ) {
        return acceptProfile("accepted knight sacrifice");
      }

      return rejectProfile("accepted knight sacrifice lacks the calibrated acceptance pattern");
    }

    return rejectProfile("minor-piece checking sacrifices over-flag this benchmark");
  }

  if (candidate.piece === "b") {
    if (givesCheck && candidate.captured && hasReason(candidate, "sacrifice near king")) {
      return acceptProfile("checking bishop sacrifice near king");
    }

    return rejectProfile("bishop sacrifice shape is not calibrated as Brilliant");
  }

  if (candidate.piece === "r") {
    const quietRookCheckFromDeficit =
      givesCheck &&
      !candidate.captured &&
      Number.isFinite(materialBalanceBefore) &&
      materialBalanceBefore < 0;

    if (
      givesCheck &&
      hasSacrifice &&
      playedRank <= 2 &&
      scoreLoss <= 25 &&
      Number.isFinite(bestScore) &&
      bestScore >= 300 &&
      bestScore <= 900 &&
      Number.isFinite(afterScoreForPlayer) &&
      afterScoreForPlayer >= 300 &&
      afterScoreForPlayer <= 1000 &&
      Number.isFinite(materialBalanceBefore) &&
      materialBalanceBefore <= 0 &&
      (!quietRookCheckFromDeficit || afterScoreForPlayer <= 450)
    ) {
      return acceptProfile("checking rook sacrifice");
    }

    return rejectProfile("rook sacrifice lacks the forcing check shape");
  }

  if (candidate.piece === "q") {
    if (
      givesCheck &&
      candidate.captured === "r" &&
      hasReason(candidate, "sacrifice near king") &&
      Number.isFinite(scoreLoss) &&
      scoreLoss <= 50 &&
      Number.isFinite(bestScore) &&
      bestScore >= 350 &&
      bestScore <= 800 &&
      Number.isFinite(afterScoreForPlayer) &&
      afterScoreForPlayer >= 350 &&
      afterScoreForPlayer <= 800 &&
      Number.isFinite(materialBalanceBefore) &&
      materialBalanceBefore >= 0 &&
      materialBalanceBefore <= 3
    ) {
      return acceptProfile("checking queen-for-rook lure");
    }

    if (
      candidate.captured === "r" &&
      !givesCheck &&
      Number.isFinite(materialBalanceBefore) &&
      materialBalanceBefore >= 0 &&
      materialBalanceBefore <= 1 &&
      Number.isFinite(bestScore) &&
      bestScore <= 400 &&
      Number.isFinite(afterScoreForPlayer) &&
      afterScoreForPlayer <= 450
    ) {
      return acceptProfile("queen-for-rook sacrifice");
    }
    return rejectProfile("queen sacrifice is too much like a normal tactic");
  }

  return rejectProfile("sacrifice shape is not calibrated as Brilliant");
}

function hasReason(candidate, reason) {
  return Array.isArray(candidate.reasons) && candidate.reasons.includes(reason);
}

function isRookInvasion(candidate) {
  if (candidate.piece !== "r" || !candidate.lan) return false;
  const targetRank = Number(candidate.lan[3]);
  if (!Number.isFinite(targetRank)) return false;
  return candidate.userColor === "white" ? targetRank >= 7 : targetRank <= 2;
}

function acceptProfile(type) {
  return { accepted: true, type };
}

function rejectProfile(reason) {
  return { accepted: false, reason };
}

function metricNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function waitForExit(child, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Process exit timed out.")), timeoutMs);
    child.once("exit", () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}
