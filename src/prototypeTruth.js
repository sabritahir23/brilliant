export function buildPrototypeTruthLocal(record) {
  const prototype = record?.prototype;
  if (!prototype?.checkedAt || prototype.status !== "checked") return null;

  const brilliantCount = Number(prototype.brilliantCount) || 0;
  const brilliantMoves = Array.isArray(prototype.brilliantMoves) ? prototype.brilliantMoves : [];

  if (brilliantCount > 0 && brilliantMoves.length !== brilliantCount) return null;

  const moves = brilliantMoves.map((move) => ({
    moveNumber: move.moveNumber,
    ply: move.ply,
    san: move.san,
    lan: move.lan,
    color: move.color || move.userColor || record.userColor,
    source: "prototype-truth",
    score: 100,
    reasons: ["prototype truth"],
    engine: null
  }));

  return {
    status: "checked",
    checkedAt: new Date().toISOString(),
    brilliantCount: moves.length,
    brilliantMoves: moves,
    candidates: moves.map((move) => ({
      gameUrl: record.url,
      reviewUrl: record.reviewUrl,
      white: record.white,
      black: record.black,
      userColor: record.userColor,
      moveNumber: move.moveNumber,
      ply: move.ply,
      san: move.san,
      lan: move.lan,
      score: 100,
      verified: true,
      source: "prototype-truth",
      reasons: ["prototype truth"]
    })),
    rejectedCandidates: [],
    error: null
  };
}
