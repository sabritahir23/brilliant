import { Chess } from "chess.js";
import {
  analyzePgnForBrilliancyCandidates,
  shouldVerifyBrilliancyCandidate
} from "../src/brilliancyCandidateFinder.js";
import { readCorpusGames } from "../src/gameCorpus.js";
import { closeStockfishAnalyzer, getStockfishAnalyzer } from "../src/stockfishAnalyzer.js";

const PIECE_VALUES = {
  p: 1,
  n: 3,
  b: 3,
  r: 5,
  q: 9,
  k: 0
};

const PIECE_NAMES = {
  p: "pawn",
  n: "knight",
  b: "bishop",
  r: "rook",
  q: "queen",
  k: "king"
};

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  const records = await readCorpusGames(options.username);
  const record = findGame(records, options.game);
  if (!record) {
    throw new Error(`Game not found in the local ${options.username} corpus: ${options.game}`);
  }
  if (!record.pgn) throw new Error("The selected corpus game has no PGN.");

  const target = locateMove(record.pgn, options.move);
  const rawCandidates = analyzePgnForBrilliancyCandidates(corpusRecordToGame(record), {
    limit: Infinity
  });
  const rawTarget = rawCandidates.find((candidate) => candidate.ply === target.ply);
  const storedDetector = findStoredDetectorResult(record, target);
  const material = inspectMaterialAfterMove(target);
  const direct = inspectDirectMoveEffects(target);
  const analyzer = await getStockfishAnalyzer();

  try {
    const before = await analyzer.analyzeFen(target.fenBefore);
    const after = await analyzer.analyzeFen(target.fenAfter, { multipv: 3 });
    const playedLine = before.lines.find((line) => line.bestMove === target.lan) || null;
    const bestLine = before.lines[0] || null;
    const bestScore = scoreForSideToMove(bestLine);
    const afterScoreForPlayer = -scoreForSideToMove(after.lines[0]);
    const playedScore = playedLine ? scoreForSideToMove(playedLine) : afterScoreForPlayer;
    const scoreLoss = bestLine ? Math.max(0, bestScore - playedScore) : null;
    const engineApproved =
      Boolean(bestLine) &&
      scoreLoss <= 140 &&
      afterScoreForPlayer >= -180;
    const detector = await diagnoseDetector(rawTarget, storedDetector, analyzer);
    const acceptance = await analyzeMaterialAcceptance(material.offers[0], target, analyzer);
    const delayedCompensation = describeDelayedCompensation({
      material,
      acceptance,
      afterScoreForPlayer
    });

    printReport({
      record,
      target,
      before,
      after,
      playedLine,
      bestScore,
      playedScore,
      afterScoreForPlayer,
      scoreLoss,
      engineApproved,
      material,
      direct,
      acceptance,
      delayedCompensation,
      detector,
      storedDetector
    });
  } finally {
    await closeStockfishAnalyzer().catch(() => {});
  }
}

function parseArgs(args) {
  const options = {
    username: null,
    game: null,
    move: null,
    help: false
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg.startsWith("--")) {
      if (options.username) throw new Error(`Unexpected positional argument: ${arg}`);
      options.username = arg;
      continue;
    }

    const [name, inlineValue] = arg.split("=", 2);
    if (name === "--help") {
      options.help = true;
      continue;
    }

    const value = inlineValue ?? args[++index];
    if (!value || value.startsWith("--")) throw new Error(`${name} requires a value.`);
    if (name === "--game") options.game = value;
    else if (name === "--move") options.move = value;
    else throw new Error(`Unknown option: ${name}`);
  }

  if (options.help) return options;
  if (!options.username) throw new Error("A corpus username is required.");
  if (!options.game) throw new Error("--game is required.");
  if (!options.move) throw new Error("--move is required.");
  return options;
}

function findGame(records, gameInput) {
  const input = String(gameInput || "").trim().replace(/\/+$/, "");
  const id = extractGameId(input);

  return records.find((record) => {
    const urls = [record.url, record.reviewUrl].filter(Boolean).map((value) => value.replace(/\/+$/, ""));
    return urls.includes(input) || (id && urls.some((url) => extractGameId(url) === id)) ||
      String(record.id || "") === input;
  });
}

function extractGameId(value) {
  const match = String(value || "").match(/\/(?:live|daily)\/(\d+)/);
  return match?.[1] || (/^\d+$/.test(String(value || "")) ? String(value) : null);
}

function locateMove(pgn, moveLabel) {
  const requested = parseMoveLabel(moveLabel);
  const source = new Chess();
  source.loadPgn(pgn);
  const moves = source.history({ verbose: true });
  const headers = source.header();
  const replay = headers.SetUp === "1" && headers.FEN ? new Chess(headers.FEN) : new Chess();

  for (let index = 0; index < moves.length; index += 1) {
    const move = moves[index];
    const moveNumber = Math.floor(index / 2) + 1;
    const color = move.color === "w" ? "white" : "black";
    const fenBefore = replay.fen();
    const played = replay.move({
      from: move.from,
      to: move.to,
      promotion: move.promotion
    });

    if (
      moveNumber === requested.moveNumber &&
      color === requested.color &&
      normalizeSan(played.san) === normalizeSan(requested.san)
    ) {
      return {
        label: formatMoveLabel(moveNumber, color, played.san),
        requestedLabel: moveLabel,
        moveNumber,
        color,
        colorCode: move.color,
        ply: index + 1,
        san: played.san,
        lan: `${played.from}${played.to}${played.promotion || ""}`,
        piece: played.piece,
        captured: played.captured || null,
        from: played.from,
        to: played.to,
        fenBefore,
        fenAfter: replay.fen()
      };
    }
  }

  throw new Error(`Move not found in PGN: ${moveLabel}`);
}

function parseMoveLabel(value) {
  const match = String(value || "").trim().match(/^(\d+)(\.\.\.|\.)(.+)$/);
  if (!match) throw new Error('--move must look like "15...fxe4" or "15.Bg5".');

  return {
    moveNumber: Number(match[1]),
    color: match[2] === "..." ? "black" : "white",
    san: match[3].trim()
  };
}

function normalizeSan(value) {
  return String(value || "").replace(/[+#?!]+$/g, "");
}

function formatMoveLabel(moveNumber, color, san) {
  return `${moveNumber}${color === "black" ? "..." : "."}${san}`;
}

function inspectMaterialAfterMove(target) {
  const board = new Chess(target.fenAfter);
  const movingColor = target.colorCode;
  const offers = board
    .moves({ verbose: true })
    .filter((move) => move.captured && pieceValue(move.captured) >= 3)
    .map((move) => {
      const afterCapture = new Chess(target.fenAfter);
      const accepted = afterCapture.move({
        from: move.from,
        to: move.to,
        promotion: move.promotion
      });
      const recaptures = afterCapture
        .moves({ verbose: true })
        .filter((reply) => reply.captured && reply.to === accepted.to)
        .map((reply) => reply.san);

      return {
        san: move.san,
        lan: `${move.from}${move.to}${move.promotion || ""}`,
        from: move.from,
        to: move.to,
        attacker: move.piece,
        captured: move.captured,
        targetValue: pieceValue(move.captured),
        attackerValue: pieceValue(move.piece),
        netOffer: pieceValue(move.captured) - pieceValue(move.piece),
        recaptures,
        fenAfterAcceptance: afterCapture.fen()
      };
    })
    .filter((offer) => offer.netOffer > 0 || offer.recaptures.length > 0)
    .sort((a, b) => b.targetValue - a.targetValue || b.netOffer - a.netOffer);

  return {
    leavesMaterialHanging: offers.length > 0,
    movingColor,
    offers
  };
}

function inspectDirectMoveEffects(target) {
  const board = new Chess(target.fenAfter);
  const opponent = target.colorCode === "w" ? "b" : "w";
  const attacked = [];

  for (const row of board.board()) {
    for (const piece of row) {
      if (!piece || piece.color !== opponent || piece.type === "k") continue;
      if (!board.attackers(piece.square, target.colorCode).includes(target.to)) continue;
      attacked.push({
        piece: piece.type,
        square: piece.square,
        value: pieceValue(piece.type)
      });
    }
  }

  return {
    captured: target.captured
      ? `${pieceName(target.captured)} on ${target.to}`
      : null,
    attacked
  };
}

async function analyzeMaterialAcceptance(offer, target, analyzer) {
  if (!offer) return null;

  const analysis = await analyzer.analyzeFen(offer.fenAfterAcceptance, { multipv: 3 });
  const scoreForPlayer =
    target.colorCode === sideToMove(offer.fenAfterAcceptance)
      ? scoreForSideToMove(analysis.lines[0])
      : -scoreForSideToMove(analysis.lines[0]);

  return {
    offer,
    analysis,
    scoreForPlayer,
    line: decodePv(offer.fenAfterAcceptance, analysis.lines[0]?.pv || [])
  };
}

function describeDelayedCompensation({ material, acceptance, afterScoreForPlayer }) {
  if (!material.leavesMaterialHanging) {
    return {
      appearsDelayed: false,
      explanation: "No high-value material capture is available immediately after the move."
    };
  }

  if (!acceptance) {
    return {
      appearsDelayed: false,
      explanation: "Material is offered, but no acceptance line was analyzed."
    };
  }

  const immediateRecapture = acceptance.offer.recaptures.length > 0;
  const firstReply = acceptance.line[0]?.san || null;
  const compensationSound = acceptance.scoreForPlayer >= -180 || afterScoreForPlayer >= -180;

  return {
    appearsDelayed: compensationSound && (immediateRecapture || acceptance.line.length > 0),
    explanation: immediateRecapture && compensationSound
      ? `${acceptance.offer.san} can be met by ${acceptance.offer.recaptures.join(" or ")}; ` +
        `the tactical compensation appears after the offered material is accepted.`
      : immediateRecapture
        ? `${acceptance.offer.san} has an available recapture, but Stockfish still finds the ` +
          "player's position unsound."
      : compensationSound
        ? `The offered material can be accepted, but Stockfish keeps the position sound through ` +
          `${firstReply || "the continuation"} rather than an immediate direct recapture.`
        : "The acceptance line does not show sufficient delayed compensation."
  };
}

async function diagnoseDetector(rawTarget, storedDetector, analyzer) {
  if (!rawTarget) {
    return {
      sawMove: Boolean(storedDetector.item),
      emittedCandidate: false,
      verificationEligible: false,
      accepted: storedDetector.kind === "accepted",
      rejectionReason:
        storedDetector.reason || "candidate finder did not emit the target move"
    };
  }

  const verificationEligible = shouldVerifyBrilliancyCandidate(rawTarget);
  if (!verificationEligible) {
    return {
      sawMove: true,
      emittedCandidate: true,
      verificationEligible: false,
      accepted: false,
      rejectionReason: "not a calibrated Chess.com-style brilliancy shape",
      rawCandidate: rawTarget
    };
  }

  const verified = await analyzer.verifyCandidate(rawTarget);
  return {
    sawMove: true,
    emittedCandidate: true,
    verificationEligible: true,
    accepted: Boolean(verified.verified),
    rejectionReason: verified.verified ? null : verified.rejectedReason,
    rawCandidate: rawTarget,
    verifiedCandidate: verified
  };
}

function findStoredDetectorResult(record, target) {
  const accepted = (record.local?.candidates || []).find((candidate) => matchesTarget(candidate, target));
  if (accepted) return { kind: "accepted", item: accepted, reason: null };

  const rejected = (record.local?.rejectedCandidates || []).find((candidate) =>
    matchesTarget(candidate, target)
  );
  if (rejected) {
    return {
      kind: "rejected",
      item: rejected,
      reason: rejected.rejectedReason || "stored local rejection"
    };
  }

  return { kind: "missing", item: null, reason: null };
}

function matchesTarget(candidate, target) {
  return candidate?.ply === target.ply ||
    candidate?.lan === target.lan ||
    (
      candidate?.moveNumber === target.moveNumber &&
      normalizeSan(candidate?.san) === normalizeSan(target.san)
    );
}

function printReport(report) {
  console.log("Brilliant Move Diagnostic");
  console.log("=========================");
  printField("Game", report.record.url);
  printField("Review", report.record.reviewUrl);
  printField("Target", report.target.label);
  printField("Side to move", report.target.color);
  printField("FEN before", report.target.fenBefore);
  printField("FEN after", report.target.fenAfter);

  console.log("\nStockfish before move");
  console.log("---------------------");
  for (const line of report.before.lines) {
    const decoded = decodePv(report.target.fenBefore, line.pv);
    const direct = describeLineFirstMove(report.target.fenBefore, line.bestMove);
    console.log(
      `${line.multipv}. ${decoded.map((move) => move.san).slice(0, 8).join(" ")} ` +
        `[${formatLineEval(line)}]${direct ? ` - ${direct}` : ""}`
    );
  }
  printField("Played move in top lines", yesNo(Boolean(report.playedLine)));
  printField("Played move rank", report.playedLine?.multipv ?? "not in MultiPV");
  printField("Best move eval", formatScore(report.bestScore));
  printField("Played move eval", formatScore(report.playedScore));
  printField("After-move eval", formatScore(report.afterScoreForPlayer));
  printField(
    "Score loss vs best",
    Number.isFinite(report.scoreLoss) ? `${report.scoreLoss} cp` : "unknown"
  );
  printField(
    "Engine-approved",
    `${yesNo(report.engineApproved)} (diagnostic threshold: <=140 cp loss and sound after move)`
  );

  console.log("\nStockfish after move");
  console.log("--------------------");
  for (const line of report.after.lines) {
    console.log(
      `${line.multipv}. ${decodePv(report.target.fenAfter, line.pv)
        .map((move) => move.san)
        .slice(0, 8)
        .join(" ")} [${formatLineEval(line, true)} for ${report.target.color}]`
    );
  }

  console.log("\nMaterial and tactical shape");
  console.log("---------------------------");
  printField("Direct capture", report.direct.captured || "none");
  printField(
    "Direct attacks after move",
    report.direct.attacked.length
      ? report.direct.attacked
          .map((item) => `${pieceName(item.piece)} on ${item.square}`)
          .join(", ")
      : "none"
  );
  printField("Leaves material hanging", yesNo(report.material.leavesMaterialHanging));
  printField(
    "Material offered",
    report.material.offers.length
      ? report.material.offers
          .slice(0, 3)
          .map((offer) =>
            `${pieceName(offer.captured)} on ${offer.to} via ${offer.san}` +
            `${offer.recaptures.length ? `; recapture: ${offer.recaptures.join(" or ")}` : ""}`
          )
          .join(" | ")
      : "none"
  );
  printField("Delayed compensation", yesNo(report.delayedCompensation.appearsDelayed));
  printField("Compensation explanation", report.delayedCompensation.explanation);

  if (report.acceptance) {
    printField(
      "Acceptance continuation",
      `${report.acceptance.offer.san} ${report.acceptance.line
        .map((move) => move.san)
        .slice(0, 8)
        .join(" ")} [${formatScore(report.acceptance.scoreForPlayer)} for ${report.target.color}]`
    );
  }

  console.log("\nCurrent detector");
  console.log("----------------");
  printField("Saw target move", yesNo(report.detector.sawMove));
  printField("Emitted shape candidate", yesNo(report.detector.emittedCandidate));
  printField("Eligible for Stockfish verification", yesNo(report.detector.verificationEligible));
  printField("Accepted", yesNo(report.detector.accepted));
  printField("Rejection reason", report.detector.rejectionReason || "none");
  const engineQualityGate =
    report.detector.verifiedCandidate?.engine?.engineQualityGate || null;
  printField(
    "Engine quality gate",
    engineQualityGate
      ? `${engineQualityGate.accepted ? "passed" : "rejected"}: ${engineQualityGate.reason}`
      : report.detector.rawCandidate?.piece === "k"
        ? "rejected before Stockfish verification: king move excluded by the shape gate"
        : report.detector.verificationEligible
          ? "not reached"
          : "not evaluated because the move failed the shape gate"
  );
  const productionDelayedCompensation =
    report.detector.verifiedCandidate?.engine?.delayedCompensation || null;
  printField(
    "Production delayed-compensation rule",
    productionDelayedCompensation
      ? `${productionDelayedCompensation.accepted
          ? "passed"
          : productionDelayedCompensation.analyzed
            ? "did not pass"
            : "not needed"}: ${productionDelayedCompensation.reason}`
      : report.detector.rawCandidate?.piece === "k"
        ? "not evaluated: king moves are excluded and this move failed the shape gate"
        : "not evaluated"
  );
  if (productionDelayedCompensation?.offer) {
    printField(
      "Production acceptance evidence",
      `${productionDelayedCompensation.offer.san}; ` +
        `${formatScore(productionDelayedCompensation.acceptanceScoreForPlayer)} after acceptance; ` +
        `${productionDelayedCompensation.materialConcessionAfterReply} point(s) still conceded after the first reply`
    );
  }

  const fakeCandidate = (report.record.local?.rejectedCandidates || []).find(
    (candidate) => candidate.moveNumber === 28 && candidate.san === "Ka6"
  );
  console.log("\nComparison clues");
  console.log("----------------");
  printField(
    "Obvious top moves",
    report.before.lines
      .slice(0, 3)
      .map((line) => {
        const move = decodePv(report.target.fenBefore, line.pv)[0];
        return move ? `${move.san}${describeLineFirstMove(report.target.fenBefore, line.bestMove) ? ` (${describeLineFirstMove(report.target.fenBefore, line.bestMove)})` : ""}` : line.bestMove;
      })
      .join(", ")
  );
  printField(
    "Delayed-compensation signal",
    report.delayedCompensation.appearsDelayed
      ? "target remains engine-sound while allowing an offered-material acceptance line"
      : "not established"
  );
  printField(
    "Known fake candidate",
    fakeCandidate
      ? `28...Ka6 remains rejected: ${fakeCandidate.rejectedReason}`
      : "no stored 28...Ka6 rejection found"
  );
}

function describeLineFirstMove(fen, lan) {
  if (!lan) return "";
  const board = new Chess(fen);
  const move = applyLan(board, lan);
  if (!move) return "";

  const effects = [];
  if (move.captured) effects.push(`captures ${pieceName(move.captured)}`);
  const opponent = move.color === "w" ? "b" : "w";
  const attacked = [];
  for (const row of board.board()) {
    for (const piece of row) {
      if (!piece || piece.color !== opponent || piece.type === "k") continue;
      if (board.attackers(piece.square, move.color).includes(move.to)) {
        attacked.push(`${pieceName(piece.type)} on ${piece.square}`);
      }
    }
  }
  if (attacked.length) effects.push(`attacks ${attacked.join(", ")}`);
  return effects.join("; ");
}

function decodePv(fen, pv) {
  const board = new Chess(fen);
  const decoded = [];

  for (const lan of pv || []) {
    const move = applyLan(board, lan);
    if (!move) break;
    decoded.push({
      lan,
      san: move.san,
      color: move.color,
      from: move.from,
      to: move.to,
      piece: move.piece,
      captured: move.captured || null
    });
  }

  return decoded;
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

function formatLineEval(line, invert = false) {
  if (!line) return "unknown";
  if (Number.isFinite(line.mate)) {
    const mate = invert ? -line.mate : line.mate;
    return mate > 0 ? `M${mate}` : `-M${Math.abs(mate)}`;
  }
  return formatScore((invert ? -1 : 1) * scoreForSideToMove(line));
}

function scoreForSideToMove(line) {
  if (!line) return 0;
  if (Number.isFinite(line.score)) return line.score;
  if (Number.isFinite(line.mate)) {
    return line.mate > 0 ? 100_000 - line.mate : -100_000 - line.mate;
  }
  return Number.isFinite(line.cp) ? line.cp : 0;
}

function formatScore(score) {
  if (!Number.isFinite(score)) return "unknown";
  if (Math.abs(score) > 90_000) return score > 0 ? "winning mate" : "losing mate";
  const pawns = score / 100;
  return `${pawns >= 0 ? "+" : ""}${pawns.toFixed(2)}`;
}

function sideToMove(fen) {
  return String(fen).split(/\s+/)[1] || "w";
}

function pieceValue(piece) {
  return PIECE_VALUES[piece] || 0;
}

function pieceName(piece) {
  return PIECE_NAMES[piece] || piece || "piece";
}

function yesNo(value) {
  return value ? "yes" : "no";
}

function printField(label, value) {
  console.log(`${label}: ${value}`);
}

function corpusRecordToGame(record) {
  return {
    id: record.id,
    url: record.url,
    reviewUrl: record.reviewUrl,
    white: record.white,
    black: record.black,
    whiteRating: record.whiteRating,
    blackRating: record.blackRating,
    userColor: record.userColor,
    rules: record.rules,
    timeClass: record.timeClass,
    endTime: record.endTime,
    pgn: record.pgn
  };
}

function printHelp() {
  console.log(`Usage:
  node scripts/diagnose-brilliant-move.js <username> --game <url-or-id> --move <move>

Example:
  node scripts/diagnose-brilliant-move.js Witty_Alien \\
    --game https://www.chess.com/game/live/97847462193 \\
    --move "15...fxe4"`);
}
