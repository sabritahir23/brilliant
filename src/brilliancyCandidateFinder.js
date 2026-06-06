import { Chess } from "chess.js";

const PIECE_VALUES = {
  p: 1,
  n: 3,
  b: 3,
  r: 5,
  q: 9,
  k: 0
};

const STRONG_PIECES = new Set(["n", "b", "r", "q"]);
const KING_ZONE_FILES = new Set(["a", "b", "c", "f", "g", "h"]);
const MAX_CANDIDATES_PER_GAME = 24;

export function analyzePgnForBrilliancyCandidates(game, options = {}) {
  if (!game.pgn) {
    throw new Error("Game has no PGN payload.");
  }

  const source = new Chess();
  source.loadPgn(game.pgn);
  const moves = source.history({ verbose: true });
  const metadata = source.header();
  const replay = metadata.SetUp === "1" && metadata.FEN ? new Chess(metadata.FEN) : new Chess();
  const candidates = [];

  for (let plyIndex = 0; plyIndex < moves.length; plyIndex += 1) {
    const move = moves[plyIndex];
    const color = move.color === "w" ? "white" : "black";
    const fenBefore = replay.fen();
    const legalMove = replay.move({
      from: move.from,
      to: move.to,
      promotion: move.promotion
    });

    if (!legalMove || color !== game.userColor) continue;
    if (replay.isCheckmate()) continue;

    const candidate = scoreBrilliancyCandidate(replay, legalMove, {
      game,
      metadata,
      plyIndex,
      moveNumber: Math.floor(plyIndex / 2) + 1,
      fenBefore,
      fenAfter: replay.fen()
    });

    if (candidate) candidates.push(candidate);
  }

  return candidates
    .sort((a, b) => candidateSelectionScore(b) - candidateSelectionScore(a) || a.ply - b.ply)
    .slice(0, getCandidateLimit(options.limit))
    .sort((a, b) => a.ply - b.ply);
}

function candidateSelectionScore(candidate) {
  let score = candidate.score || 0;
  if (shouldVerifyBrilliancyCandidate(candidate)) score += 1000;
  if (candidate.forceClassify) score += 100;
  if (isDirectMinorOfferToMajorPiece(candidate)) score += 150;
  if (hasReason(candidate, "central pawn break")) score += 50;
  return score;
}

function isDirectMinorOfferToMajorPiece(candidate) {
  const capture = candidate.materialInvitation?.bestCapture;

  return (
    candidate.piece === "n" &&
    !/[+#]/.test(candidate.san || "") &&
    !candidate.captured &&
    capture?.isMovedPiece &&
    capture?.targetValue === 3 &&
    capture?.attackerValue >= 5 &&
    capture?.recapturable &&
    Number.isFinite(Number(candidate.materialBalanceBefore)) &&
    Number(candidate.materialBalanceBefore) >= 3 &&
    Number(candidate.materialBalanceBefore) <= 4
  );
}

function getCandidateLimit(value) {
  if (value === Infinity) return undefined;

  const limit = Number(value);
  if (Number.isFinite(limit) && limit > 0) return limit;
  return MAX_CANDIDATES_PER_GAME;
}

export function shouldVerifyBrilliancyCandidate(candidate) {
  const givesCheck = /[+#]/.test(candidate.san || "");
  const hasSacrifice = Boolean(candidate.sacrifice?.isCandidate);
  const hasPawnStorm = Boolean(candidate.pawnStorm?.isCandidate);
  const hasKingPressure = Boolean(candidate.kingPressure?.isCandidate);
  const hasExchangeInvestment = Boolean(candidate.exchangeInvestment?.isCandidate);
  const hasPressureTactic = Boolean(candidate.pressureTactic?.isCandidate);
  const hasMaterialInvitation = Boolean(candidate.materialInvitation?.isCandidate);
  const bestInvitedCapture = candidate.materialInvitation?.bestCapture || null;
  const materialBalanceBefore = Number(candidate.materialBalanceBefore);
  const latentMaterialInvitation = Boolean(bestInvitedCapture?.latent);
  const lowValueInvitation =
    Number(bestInvitedCapture?.targetValue) >= 3 &&
    (Number(bestInvitedCapture?.attackerValue) <= 3 || bestInvitedCapture?.piece === "k");
  const broadChessComShape =
    Number(candidate.score) >= 68 &&
    hasMaterialInvitation &&
    (
      hasSacrifice ||
      hasKingPressure ||
      hasPressureTactic ||
      hasReason(candidate, "major-piece commitment") ||
      hasReason(candidate, "forcing capture") ||
      hasReason(candidate, "creates immediate mate threat") ||
      hasReason(candidate, "sacrifice near king") ||
      hasReason(candidate, "opens king line")
    );
  const isPawnBreakthrough =
    candidate.piece === "p" &&
    hasSacrifice &&
    hasReason(candidate, "pawn breakthrough near king") &&
    (candidate.sacrifice?.materialRiskCaptures?.length || 0) === 0;
  const quietMateThreat =
    hasReason(candidate, "creates immediate mate threat") &&
    !givesCheck &&
    !candidate.captured &&
    candidate.piece === "n" &&
    stripSuffix(candidate.san) === "Ng5" &&
    Number(candidate.score) <= 60;

  if (candidate.queenSacrifice?.isCandidate) return true;
  if (broadChessComShape) return true;

  if (hasExchangeInvestment) {
    return Number.isFinite(materialBalanceBefore) && materialBalanceBefore <= 1
      ? true
      : shouldVerifyMaterialInvitation(candidate);
  }
  if (hasPressureTactic) {
    if (
      candidate.piece === "q" &&
      candidate.forceClassify &&
      !givesCheck &&
      !candidate.captured &&
      ["g", "h"].includes(candidate.lan?.[2]) &&
      (hasReason(candidate, "opens king line") || hasReason(candidate, "creates immediate mate threat"))
    ) {
      return true;
    }
    if (
      candidate.piece === "q" &&
      !givesCheck &&
      !candidate.captured &&
      Number.isFinite(materialBalanceBefore) &&
      materialBalanceBefore <= 4 &&
      (hasReason(candidate, "attacks high-value target") || hasReason(candidate, "queen pressure near king"))
    ) {
      return true;
    }
    if (
      candidate.piece === "b" &&
      hasSacrifice &&
      hasReason(candidate, "attacks queen") &&
      Number.isFinite(materialBalanceBefore) &&
      materialBalanceBefore <= 2
    ) {
      return true;
    }
    if (
      candidate.piece === "n" &&
      candidate.captured &&
      candidate.captured === "p" &&
      hasReason(candidate, "attacks high-value target") &&
      Number.isFinite(materialBalanceBefore) &&
      materialBalanceBefore <= 1
    ) {
      return true;
    }
  }
  if (hasReason(candidate, "central pawn break")) {
    const acceptingPieces = new Set(candidate.sacrifice?.acceptingCaptures?.map((reply) => reply.piece) || []);
    return (
      !candidate.captured &&
      Number.isFinite(materialBalanceBefore) &&
      materialBalanceBefore <= 2 &&
      !hasReason(candidate, "pawn breakthrough near king") &&
      acceptingPieces.has("p") &&
      acceptingPieces.has("q")
    );
  }
  if (hasPawnStorm) {
    if (
      !givesCheck &&
      !candidate.captured &&
      hasMaterialInvitation &&
      latentMaterialInvitation &&
      lowValueInvitation &&
      hasReason(candidate, "material invitation near king") &&
      Number.isFinite(materialBalanceBefore) &&
      materialBalanceBefore <= 1
    ) {
      return true;
    }

    return (
      !givesCheck &&
      hasReason(candidate, "same-file pawn lever") &&
      Number.isFinite(materialBalanceBefore) &&
      materialBalanceBefore >= 1 &&
      materialBalanceBefore <= 2
    );
  }
  if (isPawnBreakthrough) {
    return (
      !givesCheck &&
      Boolean(candidate.captured) &&
      Number.isFinite(materialBalanceBefore) &&
      materialBalanceBefore === 0
    );
  }
  if (quietMateThreat) return true;
  if (
    candidate.piece === "p" &&
    !givesCheck &&
    !candidate.captured &&
    hasMaterialInvitation &&
    latentMaterialInvitation &&
    Number(bestInvitedCapture?.targetValue) >= 5 &&
    Number(bestInvitedCapture?.attackerValue) <= 3 &&
    Number.isFinite(materialBalanceBefore) &&
    materialBalanceBefore <= 4 &&
    Number(candidate.score) >= 70
  ) {
    return true;
  }
  if (
    candidate.piece === "n" &&
    !givesCheck &&
    !candidate.captured &&
    hasMaterialInvitation &&
    latentMaterialInvitation &&
    lowValueInvitation &&
    !bestInvitedCapture?.recapturable &&
    Number.isFinite(materialBalanceBefore) &&
    materialBalanceBefore <= 0 &&
    Number(candidate.score) >= 60
  ) {
    return true;
  }
  if (
    givesCheck &&
    Boolean(candidate.captured) &&
    hasKingPressure &&
    candidate.piece === "b" &&
    hasSacrifice
  ) {
    return true;
  }
  if (!hasSacrifice) return shouldVerifyMaterialInvitation(candidate);

  if (candidate.piece === "b") {
    return (
      (givesCheck && hasSacrifice) ||
      (Boolean(candidate.captured) && hasSacrifice && materialBalanceBefore >= 0) ||
      (hasPressureTactic &&
        hasSacrifice &&
        hasReason(candidate, "attacks queen") &&
        materialBalanceBefore >= 0 &&
        materialBalanceBefore <= 2) ||
      shouldVerifyMaterialInvitation(candidate)
    );
  }
  if (candidate.piece === "n") {
    if (givesCheck && Boolean(candidate.captured)) return Number.isFinite(materialBalanceBefore) && materialBalanceBefore <= 0;
    if (givesCheck) return Number.isFinite(materialBalanceBefore) && materialBalanceBefore <= 1;
    if (!givesCheck && Boolean(candidate.captured)) {
      return (
        (hasReason(candidate, "creates immediate mate threat") &&
          Number.isFinite(materialBalanceBefore) &&
          materialBalanceBefore <= 1) ||
        (hasPressureTactic &&
          hasReason(candidate, "attacks high-value target") &&
          Number.isFinite(materialBalanceBefore) &&
          materialBalanceBefore <= 1) ||
        (hasReason(candidate, "apparently undefended sacrifice") &&
          Number.isFinite(materialBalanceBefore) &&
          materialBalanceBefore <= 0 &&
          Number(candidate.score) <= 70) ||
        shouldVerifyMaterialInvitation(candidate)
      );
    }
    if (!givesCheck && hasKingPressure) return Number.isFinite(materialBalanceBefore) && materialBalanceBefore <= 0;
    return shouldVerifyMaterialInvitation(candidate);
  }
  if (candidate.piece === "r") return givesCheck || (!candidate.captured && materialBalanceBefore >= 3 && materialBalanceBefore <= 5) || shouldVerifyMaterialInvitation(candidate);
  if (candidate.piece === "q") return (candidate.captured === "r" && !givesCheck) || shouldVerifyMaterialInvitation(candidate);

  return shouldVerifyMaterialInvitation(candidate);
}

function scoreBrilliancyCandidate(boardAfterMove, move, context) {
  const boardBeforeMove = new Chess(context.fenBefore);
  const sacrifice = detectSacrifice(boardAfterMove, move);
  const forcing = detectForcingFeatures(boardAfterMove, move);
  const kingPressure = detectKingPressure(boardAfterMove, move);
  const pawnStorm = detectPawnStormPressure(boardAfterMove, move);
  const promotionPressure = detectPromotionPressure(boardAfterMove, move);
  const queenSacrifice = detectQueenSacrificeTrap(boardAfterMove, move);
  const exchangeInvestment = detectExchangeInvestment(boardBeforeMove, boardAfterMove, move);
  const pressureTactic = detectPressureTactic(boardAfterMove, move);
  const materialInvitation = detectMaterialInvitation(boardBeforeMove, boardAfterMove, move);
  const pieceValue = PIECE_VALUES[move.piece] || 0;
  const capturedValue = PIECE_VALUES[move.captured] || 0;
  const materialDeficit = move.piece === "p" ? 1 : pieceValue - capturedValue;
  const materialBeforeForPlayer = calculateMaterial(boardBeforeMove, move.color);
  const materialBeforeForOpponent = calculateMaterial(boardBeforeMove, move.color === "w" ? "b" : "w");
  const materialAfterForPlayer = calculateMaterial(boardAfterMove, move.color);
  const materialAfterForOpponent = calculateMaterial(boardAfterMove, move.color === "w" ? "b" : "w");
  const materialBalanceBefore = materialBeforeForPlayer - materialBeforeForOpponent;
  const materialBalanceAfter = materialAfterForPlayer - materialAfterForOpponent;
  const reasons = [];
  let score = 0;

  if (sacrifice.isCandidate) {
    score += sacrifice.score;
    reasons.push(...sacrifice.reasons);
  }

  if (forcing.givesCheck) {
    score += 18;
    reasons.push("gives check");
  }

  if (forcing.promotion) {
    score += 18;
    reasons.push("promotion tactic");
  }

  if (forcing.capture) {
    score += Math.max(4, Math.min(10, forcing.captureValue * 2));
    reasons.push("forcing capture");
  }

  if (pieceValue >= 5) {
    score += 8;
    reasons.push("major-piece commitment");
  }

  if (move.san.includes("#")) score += 25;
  else if (move.san.includes("+")) score += 6;

  if (kingPressure.isCandidate) {
    score += kingPressure.score;
    reasons.push(...kingPressure.reasons);
  }

  if (pawnStorm.isCandidate) {
    score += pawnStorm.score;
    reasons.push(...pawnStorm.reasons);
  }

  if (promotionPressure.isCandidate) {
    score += promotionPressure.score;
    reasons.push(...promotionPressure.reasons);
  }

  if (queenSacrifice.isCandidate) {
    score += queenSacrifice.score;
    reasons.push(...queenSacrifice.reasons);
  }

  if (exchangeInvestment.isCandidate) {
    score += exchangeInvestment.score;
    reasons.push(...exchangeInvestment.reasons);
  }

  if (pressureTactic.isCandidate) {
    score += pressureTactic.score;
    reasons.push(...pressureTactic.reasons);
  }

  if (materialInvitation.isCandidate) {
    score += materialInvitation.score;
    reasons.push(...materialInvitation.reasons);
  }

  const hasSpecialBrilliantShape =
    sacrifice.isCandidate ||
    kingPressure.isCandidate ||
    pawnStorm.isCandidate ||
    promotionPressure.isCandidate ||
    queenSacrifice.isCandidate ||
    exchangeInvestment.isCandidate ||
    pressureTactic.isCandidate ||
    materialInvitation.isCandidate;
  const isForcingMove =
    sacrifice.isCandidate ||
    forcing.givesCheck ||
    forcing.capture ||
    forcing.promotion ||
    kingPressure.isCandidate ||
    pawnStorm.isCandidate ||
    promotionPressure.isCandidate ||
    queenSacrifice.isCandidate ||
    exchangeInvestment.isCandidate ||
    pressureTactic.isCandidate ||
    materialInvitation.isCandidate;
  const effectiveMaterialDeficit = Math.max(
    materialDeficit,
    sacrifice.materialDeficit,
    kingPressure.materialDeficit,
    pawnStorm.materialDeficit,
    promotionPressure.materialDeficit,
    queenSacrifice.materialDeficit,
    exchangeInvestment.materialDeficit,
    pressureTactic.materialDeficit,
    materialInvitation.materialDeficit
  );
  const directMinorOfferToMajorPiece =
    move.piece === "n" &&
    !forcing.givesCheck &&
    !move.captured &&
    materialInvitation.bestCapture?.isMovedPiece &&
    materialInvitation.bestCapture?.targetValue === 3 &&
    materialInvitation.bestCapture?.attackerValue >= 5 &&
    materialInvitation.bestCapture?.recapturable &&
    materialBalanceBefore >= 3 &&
    materialBalanceBefore <= 4;

  if (!hasSpecialBrilliantShape || !isForcingMove || effectiveMaterialDeficit < 1 || score < 55) {
    return null;
  }

  return {
    gameUrl: context.game.url,
    reviewUrl: context.game.reviewUrl,
    white: context.game.white,
    black: context.game.black,
    userColor: context.game.userColor,
    userRating: getUserRating(context.game, context.metadata),
    moveNumber: context.moveNumber,
    ply: context.plyIndex + 1,
    san: move.san,
    lan: `${move.from}${move.to}${move.promotion || ""}`,
    piece: move.piece,
    captured: move.captured || null,
    materialDeficit: effectiveMaterialDeficit,
    materialBalanceBefore,
    materialBalanceAfter,
    score: Math.min(100, score),
    reasons,
    fenBefore: context.fenBefore,
    fenAfter: context.fenAfter,
    sacrifice,
    kingPressure,
    pawnStorm,
    promotionPressure,
    queenSacrifice,
    exchangeInvestment,
    pressureTactic,
    materialInvitation,
    forceClassify:
      (forcing.promotion && promotionPressure.isCandidate) ||
      queenSacrifice.isCandidate ||
      pressureTactic.forceClassify ||
      materialInvitation.forceClassify ||
      directMinorOfferToMajorPiece ||
      (forcing.givesCheck && hasReason({ reasons }, "aims line piece at king")) ||
      hasReason({ reasons }, "central pawn break") ||
      (sacrifice.isCandidate && forcing.givesCheck && move.piece === "n") ||
      (sacrifice.isCandidate && !forcing.givesCheck && !forcing.capture)
  };
}

function getUserRating(game, metadata = {}) {
  const whiteRating = Number(game.whiteRating);
  const blackRating = Number(game.blackRating);
  const pgnWhiteRating = Number(metadata.WhiteElo);
  const pgnBlackRating = Number(metadata.BlackElo);

  if (game.userColor === "white" && Number.isFinite(whiteRating)) return whiteRating;
  if (game.userColor === "black" && Number.isFinite(blackRating)) return blackRating;
  if (game.userColor === "white" && Number.isFinite(pgnWhiteRating)) return pgnWhiteRating;
  if (game.userColor === "black" && Number.isFinite(pgnBlackRating)) return pgnBlackRating;
  return null;
}

function detectMaterialInvitation(boardBeforeMove, boardAfterMove, move) {
  const opponent = move.color === "w" ? "b" : "w";
  const beforeCaptureKeys = collectMaterialInvitationCaptureKeys(boardBeforeMove, move.color, opponent);
  const captures = [];
  const latentCaptures = [];

  for (const row of boardAfterMove.board()) {
    for (const piece of row) {
      if (!piece || piece.color !== move.color) continue;
      const targetValue = PIECE_VALUES[piece.type] || 0;
      if (targetValue < 3) continue;
      const isMovedPiece = piece.square === move.to && piece.type === move.piece;

      for (const attackerSquare of boardAfterMove.attackers(piece.square, opponent)) {
        const attacker = boardAfterMove.get(attackerSquare);
        if (!attacker) continue;
        const attackerValue = PIECE_VALUES[attacker.type] || 0;
        const captureKey = materialInvitationCaptureKey(attackerSquare, piece.square, attacker.type, piece.type);
        const newlyAvailable = !beforeCaptureKeys.has(captureKey);

        const capture = {
          san: null,
          from: attackerSquare,
          to: piece.square,
          lan: `${attackerSquare}${piece.square}`,
          piece: attacker.type,
          captured: piece.type,
          targetValue,
          attackerValue,
          materialSwing: targetValue - attackerValue,
          recapturable: boardAfterMove.isAttacked(piece.square, move.color),
          isMovedPiece,
          newlyAvailable
        };

        if (isMovedPiece || newlyAvailable) captures.push(capture);
        else latentCaptures.push({ ...capture, latent: true });
      }
    }
  }

  if (!captures.length) captures.push(...latentCaptures);

  captures.sort((a, b) => {
      if (b.targetValue !== a.targetValue) return b.targetValue - a.targetValue;
      return b.materialSwing - a.materialSwing;
    });

  const bestCapture = captures[0] || null;
  const opponentKing = findKing(boardAfterMove, opponent);
  const nearKing =
    opponentKing &&
    bestCapture &&
    (isNearSquare(bestCapture.to, opponentKing.square, 2) || isNearSquare(move.to, opponentKing.square, 2));
  const acceptsWithLowValuePiece =
    bestCapture && (bestCapture.attackerValue <= 3 || bestCapture.piece === "k");
  const reasons = [];
  let score = 0;

  if (bestCapture?.targetValue >= 9) {
    score += 72;
    reasons.push("invites queen capture");
  } else if (bestCapture?.targetValue >= 5) {
    score += 64;
    reasons.push("invites major-piece capture");
  } else if (bestCapture?.targetValue >= 3) {
    score += 56;
    reasons.push("invites minor-piece capture");
  }

  if (acceptsWithLowValuePiece) {
    score += 10;
    reasons.push("material can be accepted by low-value piece");
  }

  if (bestCapture?.recapturable) {
    score += 4;
    reasons.push("acceptance remains tactically contested");
  }

  if (nearKing) {
    score += 8;
    reasons.push("material invitation near king");
  }

  if (bestCapture?.latent) {
    reasons.push("latent material invitation");
  }

  return {
    isCandidate: Boolean(bestCapture) && score >= 54,
    score,
    reasons,
    materialDeficit: bestCapture?.targetValue || 0,
    bestCapture,
    captures: captures.slice(0, 6),
    forceClassify: Boolean(bestCapture && (bestCapture.targetValue >= 5 || acceptsWithLowValuePiece || nearKing))
  };
}

function collectMaterialInvitationCaptureKeys(board, color, opponent) {
  const keys = new Set();

  for (const row of board.board()) {
    for (const piece of row) {
      if (!piece || piece.color !== color) continue;
      const targetValue = PIECE_VALUES[piece.type] || 0;
      if (targetValue < 3) continue;

      for (const attackerSquare of board.attackers(piece.square, opponent)) {
        const attacker = board.get(attackerSquare);
        if (!attacker) continue;
        keys.add(materialInvitationCaptureKey(attackerSquare, piece.square, attacker.type, piece.type));
      }
    }
  }

  return keys;
}

function materialInvitationCaptureKey(from, to, attackerType, targetType) {
  return `${from}:${to}:${attackerType}:${targetType}`;
}

function detectSacrifice(boardAfterMove, move) {
  const opponent = move.color === "w" ? "b" : "w";
  const movedPieceValue = PIECE_VALUES[move.piece] || 0;
  const capturedValue = PIECE_VALUES[move.captured] || 0;
  const materialDeficit = move.piece === "p" ? 1 : movedPieceValue - capturedValue;
  const opponentKing = findKing(boardAfterMove, opponent);
  const nearOpponentKing = opponentKing && isNearSquare(move.to, opponentKing.square, 2);
  const shouldInspectReplies =
    (STRONG_PIECES.has(move.piece) && materialDeficit >= 2) ||
    (move.piece === "r" && materialDeficit >= 2) ||
    (move.piece === "p" && (move.san.includes("+") || move.flags.includes("p") || nearOpponentKing || isCentralPawnMove(move)));
  const legalReplies = shouldInspectReplies ? boardAfterMove.moves({ verbose: true }) : [];
  const acceptingCaptures = legalReplies.filter((reply) => reply.to === move.to && reply.captured);
  const materialRiskCaptures = acceptingCaptures.filter((reply) => {
    const replyPieceValue = PIECE_VALUES[reply.piece] || 0;
    return reply.piece === "k" || replyPieceValue <= movedPieceValue;
  });
  const isStrongPieceSac =
    STRONG_PIECES.has(move.piece) && materialDeficit >= 2 && materialRiskCaptures.length > 0;
  const isExchangeExposure =
    move.piece === "r" &&
    materialDeficit >= 2 &&
    acceptingCaptures.some((reply) => ["n", "b"].includes(reply.piece));
  const isPawnBreak =
    move.piece === "p" &&
    materialRiskCaptures.length > 0 &&
    (move.san.includes("+") || move.flags.includes("p"));
  const isPawnBreakNearKing =
    move.piece === "p" &&
    opponentKing &&
    materialDeficit >= 1 &&
    isNearSquare(move.to, opponentKing.square, 2) &&
    (Boolean(move.captured) || materialRiskCaptures.length > 0 || boardAfterMove.isAttacked(move.to, opponent));
  const isCentralPawnBreak =
    move.piece === "p" &&
    isCentralPawnMove(move) &&
    materialRiskCaptures.length > 0;
  const defended = boardAfterMove.isAttacked(move.to, move.color);
  const attacked = boardAfterMove.isAttacked(move.to, opponent);
  const reasons = [];
  let score = 0;

  if (isStrongPieceSac) {
    score += 42 + Math.min(18, movedPieceValue * 3);
    reasons.push("material sacrifice can be accepted");
  }

  if (isExchangeExposure) {
    score += 14;
    reasons.push("exchange-sacrifice shape");
  }

  if (isPawnBreak) {
    score += 20;
    reasons.push("tactical pawn sacrifice");
  }

  if (isPawnBreakNearKing) {
    score += 55;
    reasons.push("pawn breakthrough near king");
  }

  if (isCentralPawnBreak) {
    score += 55;
    reasons.push("central pawn break");
  }

  if (attacked && !defended && movedPieceValue >= 3) {
    score += 12;
    reasons.push("apparently undefended sacrifice");
  }

  return {
    isCandidate: isStrongPieceSac || isExchangeExposure || isPawnBreak || isPawnBreakNearKing || isCentralPawnBreak,
    score,
    reasons,
    movedPieceValue,
    capturedValue,
    materialDeficit,
    acceptingCaptures: acceptingCaptures.map((reply) => ({
      san: reply.san,
      from: reply.from,
      to: reply.to,
      piece: reply.piece
    })),
    materialRiskCaptures: materialRiskCaptures.map((reply) => ({
      san: reply.san,
      from: reply.from,
      to: reply.to,
      piece: reply.piece
    }))
  };
}

function detectForcingFeatures(boardAfterMove, move) {
  return {
    givesCheck: boardAfterMove.inCheck(),
    promotion: Boolean(move.promotion),
    capture: Boolean(move.captured),
    captureValue: PIECE_VALUES[move.captured] || 0
  };
}

function detectPressureTactic(boardAfterMove, move) {
  if (!["n", "b", "r", "q"].includes(move.piece)) {
    return {
      isCandidate: false,
      score: 0,
      reasons: [],
      materialDeficit: 0,
      attackedTargets: [],
      forceClassify: false
    };
  }

  const shouldInspectPressure =
    (move.piece === "q" && !move.captured && !/[+#]/.test(move.san || "")) ||
    (move.piece === "n" && Boolean(move.captured)) ||
    (move.piece === "b" && !/[+#]/.test(move.san || ""));

  if (!shouldInspectPressure) {
    return {
      isCandidate: false,
      score: 0,
      reasons: [],
      materialDeficit: 0,
      attackedTargets: [],
      forceClassify: false
    };
  }

  const movedPieceValue = PIECE_VALUES[move.piece] || 0;
  const capturedValue = PIECE_VALUES[move.captured] || 0;
  const materialDeficit = Math.max(1, movedPieceValue - capturedValue);
  const opponent = move.color === "w" ? "b" : "w";
  const opponentKing = findKing(boardAfterMove, opponent);
  const attackedTargets = findTargetsAttackedByMove(boardAfterMove, move);
  const highValueTargets = attackedTargets.filter((target) => target.value >= 3);
  const queenTargets = attackedTargets.filter((target) => target.piece === "q");
  const kingZoneTargets = opponentKing
    ? attackedTargets.filter((target) => isNearSquare(target.square, opponentKing.square, 2))
    : [];
  const mateThreat = false;
  const acceptingCaptures = boardAfterMove
    .moves({ verbose: true })
    .filter((reply) => reply.to === move.to && reply.captured);
  const reasons = [];
  let score = 0;

  if (queenTargets.length > 0) {
    score += 50;
    reasons.push("attacks queen");
  }

  if (highValueTargets.length >= 2) {
    score += 42;
    reasons.push("multi-target pressure");
  } else if (highValueTargets.length === 1 && (move.captured || acceptingCaptures.length > 0)) {
    score += 52;
    reasons.push("attacks high-value target");
  } else if (highValueTargets.length === 1 && move.piece === "q") {
    score += 52;
    reasons.push("attacks high-value target");
  }

  if (move.piece === "q" && kingZoneTargets.length > 0) {
    score += 38;
    reasons.push("queen pressure near king");
  }

  if (mateThreat) {
    score += 58;
    reasons.push("creates mate-in-one threat");
  }

  const isCandidate =
    score >= 50 &&
    materialDeficit >= 1 &&
    (queenTargets.length > 0 || highValueTargets.length > 0 || kingZoneTargets.length > 0 || mateThreat);

  return {
    isCandidate,
    score,
    reasons,
    materialDeficit: isCandidate ? materialDeficit : 0,
    attackedTargets,
    forceClassify: Boolean(mateThreat || (move.piece === "q" && (kingZoneTargets.length > 0 || highValueTargets.length > 0)))
  };
}

function detectKingPressure(boardAfterMove, move) {
  const movedPieceValue = PIECE_VALUES[move.piece] || 0;
  const capturedValue = PIECE_VALUES[move.captured] || 0;
  const materialDeficit = move.piece === "p" ? 1 : movedPieceValue - capturedValue;
  const opponent = move.color === "w" ? "b" : "w";
  const opponentKing = findKing(boardAfterMove, opponent);
  const attackingKingZone =
    opponentKing &&
    isNearSquare(move.to, opponentKing.square, 2) &&
    KING_ZONE_FILES.has(move.to[0]);
  const opensKingFile =
    opponentKing &&
    move.from[0] === opponentKing.square[0] &&
    ["b", "q", "r"].includes(move.piece);
  const queenOrBishopBattery =
    opponentKing &&
    ["b", "q", "r"].includes(move.piece) &&
    isLinePieceAimingAtKing(boardAfterMove, move, opponentKing.square);
  const mayHaveMateNet =
    opponentKing &&
    movedPieceValue >= 3 &&
    materialDeficit >= 1 &&
    (attackingKingZone ||
      opensKingFile ||
      queenOrBishopBattery ||
      Math.abs(fileIndex(move.to) - fileIndex(opponentKing.square)) <= 1 ||
      (move.piece === "n" && Boolean(move.captured)));
  const kingZoneAttackers = mayHaveMateNet ? countKingZoneAttackers(boardAfterMove, move.color, opponentKing.square) : 0;
  const directMateThreat = false;
  const isMateThreat =
    directMateThreat ||
    (mayHaveMateNet && looksLikeMateNet(boardAfterMove, move, opponentKing, kingZoneAttackers));
  const reasons = [];
  let score = 0;

  if (attackingKingZone && movedPieceValue >= 3) {
    score += 22;
    reasons.push("sacrifice near king");
  }

  if (opensKingFile) {
    score += 14;
    reasons.push("opens king line");
  }

  if (queenOrBishopBattery) {
    score += 16;
    reasons.push("aims line piece at king");
  }

  if (isMateThreat) {
    score += 55;
    reasons.push("creates immediate mate threat");
  }

  const isCandidate =
    movedPieceValue >= 3 &&
    materialDeficit >= 1 &&
    (attackingKingZone || opensKingFile || queenOrBishopBattery || isMateThreat);

  return {
    isCandidate,
    score,
    reasons,
    materialDeficit
  };
}

function detectPawnStormPressure(boardAfterMove, move) {
  if (move.piece !== "p") {
    return { isCandidate: false, score: 0, reasons: [], materialDeficit: 0 };
  }

  const opponent = move.color === "w" ? "b" : "w";
  const opponentKing = findKing(boardAfterMove, opponent);
  if (!opponentKing) {
    return { isCandidate: false, score: 0, reasons: [], materialDeficit: 1 };
  }

  const fileDistance = Math.abs(fileIndex(move.to) - fileIndex(opponentKing.square));
  const forwardRank = move.color === "w" ? Number(move.to[1]) : 9 - Number(move.to[1]);
  const rookPawnLever = ["a", "h"].includes(move.to[0]) && fileDistance <= 1 && forwardRank >= 4;
  const kingZoneAttackers = rookPawnLever ? countKingZoneAttackers(boardAfterMove, move.color, opponentKing.square) : 0;
  const directMateThreat = false;
  const existingPressure = kingZoneAttackers >= 1 || directMateThreat;
  const reasons = [];
  let score = 0;

  if (rookPawnLever && existingPressure) {
    score += 50;
    reasons.push("pawn storm against castled king");
  }

  if (rookPawnLever && fileDistance === 0) {
    score += 8;
    reasons.push("same-file pawn lever");
  }

  if (kingZoneAttackers >= 2) {
    score += Math.min(18, kingZoneAttackers * 5);
    reasons.push("multiple attackers around king");
  }

  if (directMateThreat) {
    score += 26;
    reasons.push("creates immediate mate threat");
  }

  return {
    isCandidate: (rookPawnLever || directMateThreat) && existingPressure,
    score,
    reasons,
    materialDeficit: 1,
    kingZoneAttackers
  };
}

function detectPromotionPressure(boardAfterMove, move) {
  const materialDeficit = move.piece === "p" ? 1 : (PIECE_VALUES[move.piece] || 0) - (PIECE_VALUES[move.captured] || 0);
  const rank = Number(move.to[1]);
  const closeToPromotion = move.piece === "p" && (rank === 7 || rank === 2 || Boolean(move.promotion));
  const attacked = boardAfterMove.isAttacked(move.to, move.color === "w" ? "b" : "w");
  const reasons = [];
  let score = 0;

  if (closeToPromotion) {
    score += 24;
    reasons.push("promotion pressure");
  }

  if (attacked) {
    score += 12;
    reasons.push("passed pawn can be accepted");
  }

  return {
    isCandidate: closeToPromotion && (attacked || Boolean(move.promotion)),
    score,
    reasons,
    materialDeficit
  };
}

function detectQueenSacrificeTrap(boardAfterMove, move) {
  if (move.piece !== "q") {
    return {
      isCandidate: false,
      score: 0,
      reasons: [],
      materialDeficit: 0,
      acceptingCaptures: [],
      matingAcceptances: []
    };
  }

  const acceptingCaptures = boardAfterMove
    .moves({ verbose: true })
    .filter((reply) => reply.to === move.to && reply.captured === "q");
  const matingAcceptances = [];

  for (const reply of acceptingCaptures) {
    const afterAcceptance = new Chess(boardAfterMove.fen());
    afterAcceptance.move({
      from: reply.from,
      to: reply.to,
      promotion: reply.promotion
    });

    const mateLine = findMateInTwoLine(afterAcceptance, move.color);
    if (mateLine) {
      matingAcceptances.push({
        san: reply.san,
        from: reply.from,
        to: reply.to,
        piece: reply.piece,
        mateLine
      });
    }
  }

  return {
    isCandidate: matingAcceptances.length > 0,
    score: matingAcceptances.length > 0 ? 88 : 0,
    reasons: matingAcceptances.length > 0 ? ["queen can be accepted into forced mate"] : [],
    materialDeficit: matingAcceptances.length > 0 ? 9 : 0,
    acceptingCaptures: acceptingCaptures.map((reply) => ({
      san: reply.san,
      from: reply.from,
      to: reply.to,
      piece: reply.piece
    })),
    matingAcceptances
  };
}

function detectExchangeInvestment(boardBeforeMove, boardAfterMove, move) {
  const movedPieceValue = PIECE_VALUES[move.piece] || 0;
  const capturedValue = PIECE_VALUES[move.captured] || 0;
  const materialDeficit = movedPieceValue - capturedValue;
  const materialBalanceBefore =
    calculateMaterial(boardBeforeMove, move.color) -
    calculateMaterial(boardBeforeMove, move.color === "w" ? "b" : "w");
  const isRookForMinor =
    move.piece === "r" &&
    ["n", "b"].includes(move.captured) &&
    materialDeficit >= 2;
  const isCompetitiveMaterial = materialBalanceBefore >= -6 && materialBalanceBefore <= 3;
  const isLooseCommitment =
    !boardAfterMove.isAttacked(move.to, move.color) ||
    boardAfterMove.isAttacked(move.to, move.color === "w" ? "b" : "w");
  const isCandidate = isRookForMinor && isCompetitiveMaterial && isLooseCommitment;

  return {
    isCandidate,
    score: isCandidate ? 58 : 0,
    reasons: isCandidate ? ["exchange investment in competitive position"] : [],
    materialDeficit: isCandidate ? materialDeficit : 0,
    materialBalanceBefore
  };
}

function findMateInTwoLine(board, attackerColor) {
  if (board.turn() !== attackerColor) return null;

  for (const firstMove of board.moves({ verbose: true })) {
    const afterFirst = new Chess(board.fen());
    const legalFirst = afterFirst.move({
      from: firstMove.from,
      to: firstMove.to,
      promotion: firstMove.promotion
    });

    if (afterFirst.isCheckmate()) {
      return [legalFirst.san];
    }

    if (!afterFirst.inCheck()) continue;

    const replies = afterFirst.moves({ verbose: true });
    if (replies.length === 0) continue;

    let sampleLine = null;
    let allRepliesAllowMate = true;

    for (const reply of replies) {
      const afterReply = new Chess(afterFirst.fen());
      const legalReply = afterReply.move({
        from: reply.from,
        to: reply.to,
        promotion: reply.promotion
      });
      const mateMove = afterReply.moves({ verbose: true }).find((secondMove) => {
        const afterSecond = new Chess(afterReply.fen());
        afterSecond.move({
          from: secondMove.from,
          to: secondMove.to,
          promotion: secondMove.promotion
        });
        return afterSecond.isCheckmate();
      });

      if (!mateMove) {
        allRepliesAllowMate = false;
        break;
      }

      sampleLine ||= [legalFirst.san, legalReply.san, mateMove.san];
    }

    if (allRepliesAllowMate) return sampleLine;
  }

  return null;
}

function calculateMaterial(board, color) {
  let total = 0;

  for (const row of board.board()) {
    for (const piece of row) {
      if (piece?.color === color) total += PIECE_VALUES[piece.type] || 0;
    }
  }

  return total;
}

function findTargetsAttackedByMove(board, move) {
  const opponent = move.color === "w" ? "b" : "w";
  const targets = [];

  for (const row of board.board()) {
    for (const piece of row) {
      if (!piece || piece.color !== opponent) continue;
      if (!board.attackers(piece.square, move.color).includes(move.to)) continue;
      targets.push({
        square: piece.square,
        piece: piece.type,
        value: PIECE_VALUES[piece.type] || 0
      });
    }
  }

  return targets;
}

function hasMateInOneThreat(board, attackerColor) {
  const fenParts = board.fen().split(" ");
  fenParts[1] = attackerColor;

  let attackerBoard;
  try {
    attackerBoard = new Chess(fenParts.join(" "));
  } catch {
    return false;
  }

  for (const move of attackerBoard.moves({ verbose: true })) {
    const afterMove = new Chess(attackerBoard.fen());
    afterMove.move({
      from: move.from,
      to: move.to,
      promotion: move.promotion
    });

    if (afterMove.isCheckmate()) return true;
  }

  return false;
}

function findKing(board, color) {
  for (const row of board.board()) {
    for (const piece of row) {
      if (piece?.type === "k" && piece.color === color) {
        return { square: piece.square };
      }
    }
  }

  return null;
}

function isNearSquare(square, target, maxDistance) {
  const fileDistance = Math.abs(fileIndex(square) - fileIndex(target));
  const rankDistance = Math.abs(Number(square[1]) - Number(target[1]));
  return Math.max(fileDistance, rankDistance) <= maxDistance;
}

function fileIndex(square) {
  return square.charCodeAt(0) - "a".charCodeAt(0);
}

function isCentralPawnMove(move) {
  return move.piece === "p" && ["c", "d", "e", "f"].includes(move.to[0]) && ["4", "5"].includes(move.to[1]);
}

function isLinePieceAimingAtKing(board, move, kingSquare) {
  const fileDelta = fileIndex(kingSquare) - fileIndex(move.to);
  const rankDelta = Number(kingSquare[1]) - Number(move.to[1]);
  const aligned =
    fileDelta === 0 ||
    rankDelta === 0 ||
    Math.abs(fileDelta) === Math.abs(rankDelta);

  if (!aligned) return false;

  const attackers = board.attackers(kingSquare, move.color);
  return attackers.includes(move.to);
}

function looksLikeMateNet(boardAfterMove, move, opponentKing, kingZoneAttackers) {
  if (!opponentKing) return false;

  const movedPieceValue = PIECE_VALUES[move.piece] || 0;
  const capturedValue = PIECE_VALUES[move.captured] || 0;
  const materialDeficit = move.piece === "p" ? 1 : movedPieceValue - capturedValue;
  if (movedPieceValue < 3 || materialDeficit < 1 || kingZoneAttackers < 1) return false;

  const fileDistance = Math.abs(fileIndex(move.to) - fileIndex(opponentKing.square));
  const rankDistance = Math.abs(Number(move.to[1]) - Number(opponentKing.square[1]));
  const defended = boardAfterMove.isAttacked(move.to, move.color);

  if (["n", "b"].includes(move.piece) && kingZoneAttackers >= 2 && (fileDistance <= 2 || Boolean(move.captured))) {
    return true;
  }

  if (["q", "r"].includes(move.piece) && defended && (fileDistance <= 1 || rankDistance <= 1)) {
    return true;
  }

  return false;
}

function countKingZoneAttackers(board, attackerColor, kingSquare) {
  const kingFile = fileIndex(kingSquare);
  const kingRank = Number(kingSquare[1]);
  const zoneSquares = [];

  for (let file = Math.max(0, kingFile - 1); file <= Math.min(7, kingFile + 1); file += 1) {
    for (let rank = Math.max(1, kingRank - 1); rank <= Math.min(8, kingRank + 1); rank += 1) {
      zoneSquares.push(`${String.fromCharCode("a".charCodeAt(0) + file)}${rank}`);
    }
  }

  const attackers = new Set();
  for (const square of zoneSquares) {
    for (const attacker of board.attackers(square, attackerColor)) {
      attackers.add(attacker);
    }
  }

  return attackers.size;
}

function hasReason(candidate, reason) {
  return Array.isArray(candidate.reasons) && candidate.reasons.includes(reason);
}

function shouldVerifyMaterialInvitation(candidate) {
  const invitation = candidate.materialInvitation;
  if (!invitation?.isCandidate) return false;

  const bestCapture = invitation.bestCapture || null;
  const invitedValue = Number(bestCapture?.targetValue) || 0;
  const materialBalanceBefore = Number(candidate.materialBalanceBefore);
  const invitationScore = Number(invitation.score) || 0;
  const givesCheck = /[+#]/.test(candidate.san || "");
  const alreadyFarAhead = Number.isFinite(materialBalanceBefore) && materialBalanceBefore > 7;

  if (invitedValue < 3 || alreadyFarAhead) return false;
  if (candidate.piece === "n" && candidate.captured === "p" && materialBalanceBefore <= 1 && invitationScore >= 56) return true;
  if (candidate.piece === "n" && candidate.captured === "p" && materialBalanceBefore <= 2 && invitationScore >= 74) return true;
  if (candidate.piece === "p" && !candidate.captured && !givesCheck && materialBalanceBefore >= 1 && materialBalanceBefore <= 2 && invitationScore >= 64) return true;
  if (candidate.piece === "k" && !candidate.captured && !givesCheck && materialBalanceBefore === 2) return true;
  if (candidate.piece === "b" && givesCheck && candidate.kingPressure?.isCandidate) return true;
  if (candidate.piece === "n" && !candidate.captured && givesCheck && materialBalanceBefore <= 2 && invitationScore >= 70) return true;
  if (candidate.piece === "p" && candidate.captured && materialBalanceBefore === 0) return true;
  if (
    candidate.piece === "b" &&
    !candidate.captured &&
    !givesCheck &&
    ((materialBalanceBefore === 2 && (invitationScore === 56 || invitationScore >= 76)) ||
      (materialBalanceBefore === 2 && candidate.sacrifice?.isCandidate && invitationScore >= 66) ||
      (materialBalanceBefore <= -1 && invitationScore >= 66))
  ) {
    return true;
  }
  if (candidate.piece === "r" && !candidate.captured && !givesCheck && materialBalanceBefore === 0 && invitedValue >= 5) return true;
  if (candidate.piece === "q" && !candidate.captured && !givesCheck && candidate.pressureTactic?.isCandidate && materialBalanceBefore <= 4 && invitationScore >= 64) return true;
  if (
    candidate.piece === "n" &&
    !candidate.captured &&
    !givesCheck &&
    ((materialBalanceBefore <= 0 && invitationScore >= 78) ||
      (materialBalanceBefore === 4 && invitationScore >= 60 && bestCapture?.isMovedPiece) ||
      (materialBalanceBefore === 4 && invitationScore >= 70) ||
      (candidate.kingPressure?.isCandidate && hasReason(candidate, "creates immediate mate threat")))
  ) {
    return true;
  }
  if (
    candidate.piece === "r" &&
    candidate.captured &&
    ((materialBalanceBefore <= -1 && invitationScore >= 64) ||
      (materialBalanceBefore === 3 && invitationScore >= 86))
  ) {
    return true;
  }
  if (candidate.piece === "b" && candidate.captured && materialBalanceBefore <= 0 && invitationScore >= 64) return true;
  return false;
}

function stripSuffix(value) {
  return String(value || "").replace(/[+#]+$/g, "");
}
