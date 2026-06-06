import { promises as fs } from "node:fs";
import { classifyBrilliancyProfile } from "../src/stockfishAnalyzer.js";

const checkpointPath = process.argv[2];

if (!checkpointPath) {
  console.error("Usage: node scripts/reclassify-detector-checkpoint.js <checkpoint.jsonl>");
  process.exit(1);
}

const raw = await fs.readFile(checkpointPath, "utf8");
const rows = raw
  .split(/\r?\n/)
  .filter(Boolean)
  .map((line) => JSON.parse(line));

let changedRows = 0;

for (const row of rows) {
  if (!row.local) continue;

  const originalMoves = JSON.stringify(row.local.brilliantMoves || []);
  const candidates = [];
  const rejectedCandidates = [];
  const allCandidates = [...(row.local.candidates || []), ...(row.local.rejectedCandidates || [])];
  const seen = new Set();

  for (const candidate of allCandidates) {
    const key = `${candidate.ply}:${candidate.lan}:${candidate.san}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const engine = normalizeEngineMetrics(candidate);
    const profile = classifyBrilliancyProfile(candidate, {
      playedRank: engine.playedRank,
      bestScore: engine.bestScore,
      scoreLoss: engine.scoreLoss,
      afterScoreForPlayer: engine.afterScoreForPlayer,
      afterLine: engine.afterLine
    });

    if (candidate.engine && profile.accepted) {
      candidates.push({
        ...candidate,
        verified: true,
        rejectedReason: undefined,
        engine: {
          ...engine,
          brilliancyProfile: profile
        }
      });
    } else {
      rejectedCandidates.push({
        ...candidate,
        verified: false,
        rejectedReason: profile.reason || candidate.rejectedReason || "not accepted by current detector",
        engine: candidate.engine
          ? {
              ...engine,
              brilliancyProfile: profile
            }
          : candidate.engine
      });
    }
  }

  row.local.candidates = candidates.sort((a, b) => a.ply - b.ply);
  row.local.rejectedCandidates = rejectedCandidates.sort((a, b) => a.ply - b.ply);
  row.local.brilliantMoves = row.local.candidates.map((candidate) => ({
    moveNumber: candidate.moveNumber,
    ply: candidate.ply,
    san: candidate.san,
    lan: candidate.lan,
    color: candidate.userColor,
    source: "local-detector",
    score: candidate.score,
    reasons: candidate.reasons,
    engine: candidate.engine
      ? {
          bestMove: candidate.engine.bestMove,
          playedRank: candidate.engine.playedRank,
          scoreLoss: candidate.engine.scoreLoss,
          afterScoreForPlayer: candidate.engine.afterScoreForPlayer,
          brilliancyProfile: candidate.engine.brilliancyProfile
        }
      : null
  }));
  row.local.brilliantCount = row.local.brilliantMoves.length;

  if (JSON.stringify(row.local.brilliantMoves) !== originalMoves) changedRows += 1;
}

await fs.writeFile(checkpointPath, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`, "utf8");
console.log(JSON.stringify({ checkpointPath, rows: rows.length, changedRows }, null, 2));

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
  const afterLine = engine.after?.lines?.[0] || null;

  return {
    ...engine,
    playedRank,
    bestScore,
    playedScore,
    scoreLoss,
    afterLine,
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
