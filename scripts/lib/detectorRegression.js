import { promises as fs } from "node:fs";
import path from "node:path";
import { readCorpusGames } from "../../src/gameCorpus.js";

export const KNOWN_SETS = [
  {
    id: "7yub",
    username: "7yub",
    label: "7yub full corpus",
    checkpoint: "data/reports/7yub-after-hikaru130-pass6.jsonl",
    offset: 0,
    first: null,
    split: "train"
  },
  {
    id: "sab1",
    username: "sabreezy23",
    label: "sabreezy23 games 1-500",
    checkpoint: "data/reports/sab1-after-hikaru130-pass6.jsonl",
    offset: 0,
    first: 500,
    split: "train"
  },
  {
    id: "sab2",
    username: "sabreezy23",
    label: "sabreezy23 games 501-1000",
    checkpoint: "data/reports/sab2-after-hikaru130-pass6.jsonl",
    offset: 500,
    first: 500,
    split: "train"
  },
  {
    id: "sab3",
    username: "sabreezy23",
    label: "sabreezy23 games 1001-1500",
    checkpoint: "data/reports/sab3-after-hikaru130-pass6.jsonl",
    offset: 1000,
    first: 500,
    split: "validation"
  },
  {
    id: "hikaru130",
    username: "hikaru",
    label: "Hikaru high-depth overlap games 1-130",
    checkpoint: "data/reports/hikaru130-after-feature-pass6.jsonl",
    offset: 0,
    first: 130,
    split: "validation"
  }
];

export function selectSetDefinitions(ids = []) {
  const wanted = new Set(ids.filter(Boolean));
  if (!wanted.size) return KNOWN_SETS;
  return KNOWN_SETS.filter((set) => wanted.has(set.id));
}

export function applySetOverrides(sets, { checkpoints = {}, completedOnly = false } = {}) {
  return sets.map((set) => ({
    ...set,
    checkpoint: checkpoints[set.id] || set.checkpoint,
    completedOnly: Boolean(completedOnly)
  }));
}

export async function loadKnownSet(set) {
  const corpus = (await readCorpusGames(set.username))
    .slice()
    .sort((a, b) => Number(a.endTime || 0) - Number(b.endTime || 0) || String(a.url).localeCompare(String(b.url)));
  const games = set.first == null ? corpus.slice(set.offset) : corpus.slice(set.offset, set.offset + set.first);
  const checkpointRows = await loadCheckpointRows(set.checkpoint);
  const rowsByUrl = new Map(checkpointRows.map((row) => [row.url, row]));
  const scopedGames = set.completedOnly ? games.filter((game) => rowsByUrl.has(game.url)) : games;

  return {
    ...set,
    games: scopedGames,
    checkpointRows,
    rowsByUrl
  };
}

export async function loadCheckpointRows(filePath) {
  const raw = await fs.readFile(filePath, "utf8");
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

export function scoreKnownSet(loadedSet) {
  const officialMoves = [];
  const officialGameUrls = new Set();
  const unlabeledOfficialGames = [];
  const localMoves = [];
  const localGameUrls = new Set();
  const generatedCandidates = [];
  const generatedMoveKeys = new Set();
  const classifierCandidateKeys = new Set();

  for (const [index, game] of loadedSet.games.entries()) {
    const officialCount = Number(game.prototype?.brilliantCount) || 0;
    const moves = Array.isArray(game.prototype?.brilliantMoves) ? game.prototype.brilliantMoves : [];

    if (officialCount > 0) officialGameUrls.add(game.url);
    if (officialCount > 0 && moves.length < officialCount) {
      unlabeledOfficialGames.push({
        set: loadedSet.id,
        index: index + 1,
        url: game.url,
        game: gameLabel(game),
        officialCount,
        labeledMoves: moves.length
      });
    }

    for (const move of moves) {
      officialMoves.push({
        set: loadedSet.id,
        index: index + 1,
        url: game.url,
        game: gameLabel(game),
        move,
        key: moveKey(game.url, move)
      });
    }
  }

  for (const row of loadedSet.checkpointRows) {
    const gameIndex = loadedSet.games.findIndex((game) => game.url === row.url);
    const game = loadedSet.games[gameIndex] || row;

    for (const candidate of collectAllCandidates(row)) {
      const key = moveKey(row.url, candidate);
      generatedMoveKeys.add(key);
      generatedCandidates.push({
        set: loadedSet.id,
        index: gameIndex + 1 || row.index,
        url: row.url,
        game: gameLabel(game),
        candidate,
        key
      });
      if (candidate.engine) classifierCandidateKeys.add(key);
    }

    for (const move of row.local?.brilliantMoves || []) {
      localGameUrls.add(row.url);
      localMoves.push({
        set: loadedSet.id,
        index: gameIndex + 1 || row.index,
        url: row.url,
        game: gameLabel(game),
        move,
        key: moveKey(row.url, move),
        profile: move.engine?.brilliancyProfile?.type || null
      });
    }
  }

  const officialKeys = new Set(officialMoves.map((item) => item.key));
  const localKeys = new Set(localMoves.map((item) => item.key));
  const exactHits = officialMoves.filter((item) => localKeys.has(item.key));
  const exactMisses = officialMoves.filter((item) => !localKeys.has(item.key));
  const exactFalsePositives = localMoves.filter((item) => !officialKeys.has(item.key));
  const gameHits = [...officialGameUrls].filter((url) => localGameUrls.has(url));
  const gameMisses = [...officialGameUrls].filter((url) => !localGameUrls.has(url));
  const gameFalsePositives = [...localGameUrls].filter((url) => !officialGameUrls.has(url));
  const candidateGeneratedOfficialMoves = officialMoves.filter((item) => generatedMoveKeys.has(item.key));
  const classifierSeenOfficialMoves = officialMoves.filter((item) => classifierCandidateKeys.has(item.key));
  const notGeneratedOfficialMoves = officialMoves.filter((item) => !generatedMoveKeys.has(item.key));
  const generatedButNotAcceptedOfficialMoves = officialMoves.filter((item) => {
    return generatedMoveKeys.has(item.key) && !localKeys.has(item.key);
  });
  const engineCheckedButNotAcceptedOfficialMoves = officialMoves.filter((item) => {
    return classifierCandidateKeys.has(item.key) && !localKeys.has(item.key);
  });

  return {
    set: {
      id: loadedSet.id,
      label: loadedSet.label,
      split: loadedSet.split,
      username: loadedSet.username,
      checkpoint: loadedSet.checkpoint
    },
    summary: {
      games: loadedSet.games.length,
      checkpointRows: loadedSet.checkpointRows.length,
      prototypeChecked: loadedSet.games.filter((game) => game.prototype?.checkedAt).length,
      prototypeErrors: loadedSet.games.filter((game) => game.prototype?.status === "error" || game.prototype?.error).length,
      officialBrilliantGames: officialGameUrls.size,
      officialBrilliantMoves: officialMoves.length,
      officialUnlabeledBrilliantGames: unlabeledOfficialGames.length,
      detectorCandidateGames: localGameUrls.size,
      detectorCandidateMoves: localMoves.length,
      exactHits: exactHits.length,
      exactMisses: exactMisses.length,
      exactFalsePositives: exactFalsePositives.length,
      exactRecall: ratio(exactHits.length, officialMoves.length),
      exactPrecision: ratio(exactHits.length, localMoves.length),
      gameHits: gameHits.length,
      gameMisses: gameMisses.length,
      gameFalsePositiveGames: gameFalsePositives.length,
      gameRecall: ratio(gameHits.length, officialGameUrls.size),
      gamePrecision: ratio(gameHits.length, localGameUrls.size),
      generatedCandidates: generatedCandidates.length,
      engineCheckedCandidates: generatedCandidates.filter((item) => item.candidate.engine).length,
      candidateGeneratedOfficialMoves: candidateGeneratedOfficialMoves.length,
      candidateGenerationRecall: ratio(candidateGeneratedOfficialMoves.length, officialMoves.length),
      classifierSeenOfficialMoves: classifierSeenOfficialMoves.length,
      classifierSeenRecall: ratio(classifierSeenOfficialMoves.length, officialMoves.length),
      generatedButNotAcceptedOfficialMoves: generatedButNotAcceptedOfficialMoves.length,
      engineCheckedButNotAcceptedOfficialMoves: engineCheckedButNotAcceptedOfficialMoves.length,
      notGeneratedOfficialMoves: notGeneratedOfficialMoves.length
    },
    exactHits: exactHits.map(formatMoveItem),
    exactMisses: exactMisses.map(formatMoveItem),
    exactFalsePositives: exactFalsePositives.map(formatMoveItem),
    profileStats: buildProfileStats(localMoves, officialKeys),
    gameMisses: gameMisses.map((url) => formatGameUrl(loadedSet, url)),
    gameFalsePositives: gameFalsePositives.map((url) => formatGameUrl(loadedSet, url)),
    unlabeledOfficialGames,
    notGeneratedOfficialMoves: notGeneratedOfficialMoves.map(formatMoveItem),
    generatedButNotAcceptedOfficialMoves: generatedButNotAcceptedOfficialMoves.map(formatMoveItem),
    engineCheckedButNotAcceptedOfficialMoves: engineCheckedButNotAcceptedOfficialMoves.map(formatMoveItem)
  };
}

export function summarizeProfileStats(scores) {
  const grouped = new Map();

  for (const score of scores) {
    for (const item of score.profileStats || []) {
      const current = grouped.get(item.profile) || {
        profile: item.profile,
        detectorMoves: 0,
        exactHits: 0,
        exactFalsePositives: 0
      };

      current.detectorMoves += Number(item.detectorMoves) || 0;
      current.exactHits += Number(item.exactHits) || 0;
      current.exactFalsePositives += Number(item.exactFalsePositives) || 0;
      grouped.set(item.profile, current);
    }
  }

  return formatProfileStats(grouped);
}

export function summarizeScores(scores) {
  const totals = {
    games: 0,
    checkpointRows: 0,
    officialBrilliantGames: 0,
    officialBrilliantMoves: 0,
    detectorCandidateGames: 0,
    detectorCandidateMoves: 0,
    exactHits: 0,
    exactMisses: 0,
    exactFalsePositives: 0,
    gameHits: 0,
    gameMisses: 0,
    gameFalsePositiveGames: 0,
    generatedCandidates: 0,
    engineCheckedCandidates: 0,
    candidateGeneratedOfficialMoves: 0,
    classifierSeenOfficialMoves: 0,
    generatedButNotAcceptedOfficialMoves: 0,
    engineCheckedButNotAcceptedOfficialMoves: 0,
    notGeneratedOfficialMoves: 0
  };

  for (const score of scores) {
    for (const key of Object.keys(totals)) {
      totals[key] += Number(score.summary[key]) || 0;
    }
  }

  return {
    ...totals,
    exactRecall: ratio(totals.exactHits, totals.officialBrilliantMoves),
    exactPrecision: ratio(totals.exactHits, totals.detectorCandidateMoves),
    gameRecall: ratio(totals.gameHits, totals.officialBrilliantGames),
    gamePrecision: ratio(totals.gameHits, totals.detectorCandidateGames),
    candidateGenerationRecall: ratio(totals.candidateGeneratedOfficialMoves, totals.officialBrilliantMoves),
    classifierSeenRecall: ratio(totals.classifierSeenOfficialMoves, totals.officialBrilliantMoves)
  };
}

function buildProfileStats(localMoves, officialKeys) {
  const grouped = new Map();

  for (const item of localMoves) {
    const profile = item.profile || "unknown";
    const current = grouped.get(profile) || {
      profile,
      detectorMoves: 0,
      exactHits: 0,
      exactFalsePositives: 0
    };

    current.detectorMoves += 1;
    if (officialKeys.has(item.key)) current.exactHits += 1;
    else current.exactFalsePositives += 1;
    grouped.set(profile, current);
  }

  return formatProfileStats(grouped);
}

function formatProfileStats(grouped) {
  return [...grouped.values()]
    .map((item) => ({
      ...item,
      exactPrecision: ratio(item.exactHits, item.detectorMoves)
    }))
    .sort((a, b) =>
      b.detectorMoves - a.detectorMoves ||
      b.exactHits - a.exactHits ||
      String(a.profile).localeCompare(String(b.profile))
    );
}

export function buildDatasetRows(loadedSet) {
  const officialKeys = new Set();
  const officialGameUrls = new Set();

  for (const game of loadedSet.games) {
    if ((Number(game.prototype?.brilliantCount) || 0) > 0) officialGameUrls.add(game.url);
    for (const move of game.prototype?.brilliantMoves || []) {
      officialKeys.add(moveKey(game.url, move));
    }
  }

  const rows = [];
  for (const row of loadedSet.checkpointRows) {
    const gameIndex = loadedSet.games.findIndex((game) => game.url === row.url);
    const game = loadedSet.games[gameIndex] || row;

    for (const candidate of collectAllCandidates(row)) {
      const key = moveKey(row.url, candidate);
      rows.push({
        set: loadedSet.id,
        split: loadedSet.split,
        index: gameIndex + 1 || row.index,
        url: row.url,
        game: gameLabel(game),
        move: moveLabel(candidate),
        lan: candidate.lan || null,
        officialBrilliant: officialKeys.has(key),
        officialBrilliantGame: officialGameUrls.has(row.url),
        detectorAccepted: Boolean(row.local?.brilliantMoves?.some((move) => moveKey(row.url, move) === key)),
        detectorProfile: candidate.engine?.brilliancyProfile?.type || null,
        rejectedReason: candidate.rejectedReason || candidate.engine?.brilliancyProfile?.reason || null,
        features: extractCandidateFeatures(candidate)
      });
    }
  }

  return rows;
}

export function collectAllCandidates(row) {
  const seen = new Set();
  const candidates = [];

  for (const candidate of [...(row.local?.candidates || []), ...(row.local?.rejectedCandidates || [])]) {
    const key = `${candidate.ply ?? ""}:${candidate.lan || ""}:${candidate.san || ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push(candidate);
  }

  return candidates.sort((a, b) => Number(a.ply || 0) - Number(b.ply || 0));
}

export function extractCandidateFeatures(candidate) {
  const engine = normalizeEngineMetrics(candidate);
  const bestCapture = candidate.materialInvitation?.bestCapture || {};
  const reasons = new Set(candidate.reasons || []);

  return {
    piece: candidate.piece || null,
    captured: candidate.captured || null,
    isCapture: Boolean(candidate.captured),
    givesCheck: /[+#]/.test(candidate.san || ""),
    givesMate: /#/.test(candidate.san || ""),
    phaseBucket: getPhaseBucket(candidate.ply),
    userRatingBucket: getRatingBucket(candidate.userRating),
    materialDeficit: num(candidate.materialDeficit),
    materialBalanceBefore: num(candidate.materialBalanceBefore),
    materialBalanceAfter: num(candidate.materialBalanceAfter),
    candidateScore: num(candidate.score),
    forceClassify: Boolean(candidate.forceClassify),
    verifiedByEngine: Boolean(candidate.engine),
    playedRank: num(engine.playedRank),
    scoreLoss: num(engine.scoreLoss),
    bestScore: num(engine.bestScore),
    playedScore: num(engine.playedScore),
    afterScoreForPlayer: num(engine.afterScoreForPlayer),
    uniqueness: num(engine.uniqueness),
    bestMoveMatchesPlayed: Boolean(engine.bestMove && candidate.lan && engine.bestMove === candidate.lan),
    sacrifice: Boolean(candidate.sacrifice?.isCandidate),
    sacrificeScore: num(candidate.sacrifice?.score),
    sacrificeMovedPieceValue: num(candidate.sacrifice?.movedPieceValue),
    sacrificeCapturedValue: num(candidate.sacrifice?.capturedValue),
    sacrificeAcceptingCaptures: count(candidate.sacrifice?.acceptingCaptures),
    sacrificeMaterialRiskCaptures: count(candidate.sacrifice?.materialRiskCaptures),
    kingPressure: Boolean(candidate.kingPressure?.isCandidate),
    kingPressureScore: num(candidate.kingPressure?.score),
    pawnStorm: Boolean(candidate.pawnStorm?.isCandidate),
    pawnStormScore: num(candidate.pawnStorm?.score),
    promotionPressure: Boolean(candidate.promotionPressure?.isCandidate),
    promotionPressureScore: num(candidate.promotionPressure?.score),
    queenSacrifice: Boolean(candidate.queenSacrifice?.isCandidate),
    queenSacrificeScore: num(candidate.queenSacrifice?.score),
    exchangeInvestment: Boolean(candidate.exchangeInvestment?.isCandidate),
    exchangeInvestmentScore: num(candidate.exchangeInvestment?.score),
    pressureTactic: Boolean(candidate.pressureTactic?.isCandidate),
    pressureTacticScore: num(candidate.pressureTactic?.score),
    pressureTargets: count(candidate.pressureTactic?.attackedTargets),
    materialInvitation: Boolean(candidate.materialInvitation?.isCandidate),
    materialInvitationScore: num(candidate.materialInvitation?.score),
    invitationTargetValue: num(bestCapture.targetValue),
    invitationAttackerValue: num(bestCapture.attackerValue),
    invitationMaterialSwing: num(bestCapture.materialSwing),
    invitationRecapturable: Boolean(bestCapture.recapturable),
    invitationIsMovedPiece: Boolean(bestCapture.isMovedPiece),
    invitationNewlyAvailable: Boolean(bestCapture.newlyAvailable),
    invitationLatent: Boolean(bestCapture.latent),
    invitationCaptureCount: count(candidate.materialInvitation?.captures),
    reasonFlags: {
      materialSacrificeCanBeAccepted: reasons.has("material sacrifice can be accepted"),
      apparentlyUndefendedSacrifice: reasons.has("apparently undefended sacrifice"),
      givesCheck: reasons.has("gives check"),
      forcingCapture: reasons.has("forcing capture"),
      sacrificeNearKing: reasons.has("sacrifice near king"),
      opensKingLine: reasons.has("opens king line"),
      aimsLinePieceAtKing: reasons.has("aims line piece at king"),
      createsImmediateMateThreat: reasons.has("creates immediate mate threat"),
      createsMateInOneThreat: reasons.has("creates mate-in-one threat"),
      attacksQueen: reasons.has("attacks queen"),
      attacksHighValueTarget: reasons.has("attacks high-value target"),
      multiTargetPressure: reasons.has("multi-target pressure"),
      materialInvitationNearKing: reasons.has("material invitation near king"),
      invitesMinorPieceCapture: reasons.has("invites minor-piece capture"),
      invitesMajorPieceCapture: reasons.has("invites major-piece capture"),
      invitesQueenCapture: reasons.has("invites queen capture"),
      acceptedByLowValuePiece: reasons.has("material can be accepted by low-value piece"),
      acceptanceContested: reasons.has("acceptance remains tactically contested"),
      latentMaterialInvitation: reasons.has("latent material invitation"),
      pawnBreakthroughNearKing: reasons.has("pawn breakthrough near king"),
      centralPawnBreak: reasons.has("central pawn break"),
      promotionThreat: reasons.has("promotion threat")
    }
  };
}

export async function writeJsonReport(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export async function writeJsonl(filePath, rows) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`, "utf8");
}

export function moveKey(url, move) {
  return `${url}|${Number(move.moveNumber) || ""}|${stripSuffix(move.san)}|${move.lan || ""}`;
}

export function moveLabel(move) {
  return `${move.moveNumber ? `${move.moveNumber}.` : ""}${move.san || "unknown"}`;
}

function formatMoveItem(item) {
  return {
    set: item.set,
    index: item.index,
    url: item.url,
    game: item.game,
    move: moveLabel(item.move),
    lan: item.move.lan || null,
    profile: item.profile || item.move.engine?.brilliancyProfile?.type || null
  };
}

function formatGameUrl(loadedSet, url) {
  const index = loadedSet.games.findIndex((game) => game.url === url);
  const game = loadedSet.games[index] || { url };
  const row = loadedSet.rowsByUrl.get(url);

  return {
    set: loadedSet.id,
    index: index + 1,
    url,
    game: gameLabel(game),
    officialCount: Number(game.prototype?.brilliantCount) || 0,
    detectorMoves: (row?.local?.brilliantMoves || []).map(moveLabel)
  };
}

function gameLabel(game) {
  return `${game.white || "?"} vs ${game.black || "?"}`;
}

function stripSuffix(value) {
  return String(value || "").replace(/[+#]+$/g, "");
}

function ratio(numerator, denominator) {
  return denominator ? numerator / denominator : null;
}

function num(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function count(value) {
  return Array.isArray(value) ? value.length : 0;
}

function normalizeEngineMetrics(candidate) {
  const engine = candidate.engine || {};
  const beforeLines = engine.before?.lines || [];
  const bestLine = beforeLines[0] || null;
  const playedLine = beforeLines.find((line) => line.bestMove === candidate.lan) || null;
  const rawBestScore = finiteNumber(engine.bestScore);
  const rawPlayedScore = finiteNumber(engine.playedScore);
  const rawPlayedRank = finiteNumber(engine.playedRank);
  const rawScoreLoss = finiteNumber(engine.scoreLoss);
  const rawAfterScoreForPlayer = finiteNumber(engine.afterScoreForPlayer);
  const bestScore = rawBestScore != null
    ? rawBestScore
    : scoreForSideToMove(bestLine);
  const playedScore = rawPlayedScore != null
    ? rawPlayedScore
    : scoreForSideToMove(playedLine);
  const playedRank = rawPlayedRank != null
    ? rawPlayedRank
    : playedLine?.multipv ?? null;
  const scoreLoss = rawScoreLoss != null
    ? rawScoreLoss
    : Number.isFinite(bestScore) && Number.isFinite(playedScore)
      ? Math.max(0, bestScore - playedScore)
      : null;

  return {
    ...engine,
    playedRank,
    bestScore,
    playedScore,
    scoreLoss,
    afterScoreForPlayer: rawAfterScoreForPlayer ?? engine.afterScoreForPlayer
  };
}

function finiteNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function scoreForSideToMove(line) {
  if (!line) return null;
  if (Number.isFinite(Number(line.mate))) {
    return Number(line.mate) > 0 ? 100_000 - Number(line.mate) : -100_000 - Number(line.mate);
  }
  return Number.isFinite(Number(line.cp)) ? Number(line.cp) : null;
}

function getPhaseBucket(ply) {
  const parsed = Number(ply);
  if (!Number.isFinite(parsed)) return "unknown";
  if (parsed <= 20) return "opening";
  if (parsed <= 60) return "middlegame";
  return "endgame";
}

function getRatingBucket(rating) {
  const parsed = Number(rating);
  if (!Number.isFinite(parsed)) return "unknown";
  if (parsed < 600) return "under600";
  if (parsed < 900) return "600-899";
  if (parsed < 1200) return "900-1199";
  if (parsed < 1600) return "1200-1599";
  return "1600plus";
}
