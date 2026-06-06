import {
  applySetOverrides,
  collectAllCandidates,
  loadKnownSet,
  moveKey,
  moveLabel,
  scoreKnownSet,
  selectSetDefinitions,
  writeJsonReport
} from "./lib/detectorRegression.js";

const options = parseArgs(process.argv.slice(2));
const sets = applySetOverrides(selectSetDefinitions(options.sets), options);
const diagnostics = [];

for (const set of sets) {
  const loaded = await loadKnownSet(set);
  const score = scoreKnownSet(loaded);
  diagnostics.push(buildSetDiagnostics(loaded, score));
}

const report = {
  generatedAt: new Date().toISOString(),
  sets: diagnostics,
  aggregate: aggregateDiagnostics(diagnostics)
};

await writeJsonReport(options.out, report);
console.log(JSON.stringify({
  out: options.out,
  sets: diagnostics.map((item) => ({
    set: item.set.id,
    misses: item.misses.length,
    falsePositives: item.falsePositives.length,
    missCauseGroups: item.missCauseGroups,
    falsePositiveProfileGroups: item.falsePositiveProfileGroups
  }))
}, null, 2));

function buildSetDiagnostics(loaded, score) {
  const candidateByKey = new Map();
  const acceptedKeys = new Set();

  for (const row of loaded.checkpointRows) {
    for (const move of row.local?.brilliantMoves || []) acceptedKeys.add(moveKey(row.url, move));
    for (const candidate of collectAllCandidates(row)) {
      candidateByKey.set(moveKey(row.url, candidate), candidate);
    }
  }

  const misses = score.exactMisses.map((miss) => {
    const key = `${miss.url}|${Number(miss.move.split(".")[0]) || ""}|${stripSuffix(miss.move.split(".").slice(1).join("."))}|${miss.lan || ""}`;
    const candidate = candidateByKey.get(key);
    const cause = !candidate
      ? "not generated"
      : !candidate.engine
        ? "generated but not engine checked"
        : "engine checked but rejected";

    return {
      ...miss,
      cause,
      rejectedReason: candidate?.rejectedReason || candidate?.engine?.brilliancyProfile?.reason || null,
      profile: candidate?.engine?.brilliancyProfile?.type || null,
      piece: candidate?.piece || null,
      captured: candidate?.captured || null,
      reasons: candidate?.reasons || [],
      engine: candidate?.engine
        ? {
            playedRank: candidate.engine.playedRank,
            scoreLoss: candidate.engine.scoreLoss,
            bestScore: candidate.engine.bestScore,
            afterScoreForPlayer: candidate.engine.afterScoreForPlayer,
            brilliancyProfile: candidate.engine.brilliancyProfile || null
          }
        : null
    };
  });

  const falsePositives = score.exactFalsePositives.map((fp) => {
    const key = `${fp.url}|${Number(fp.move.split(".")[0]) || ""}|${stripSuffix(fp.move.split(".").slice(1).join("."))}|${fp.lan || ""}`;
    const candidate = candidateByKey.get(key);

    return {
      ...fp,
      piece: candidate?.piece || null,
      captured: candidate?.captured || null,
      profile: candidate?.engine?.brilliancyProfile?.type || fp.profile || null,
      reasons: candidate?.reasons || [],
      materialBalanceBefore: candidate?.materialBalanceBefore ?? null,
      materialDeficit: candidate?.materialDeficit ?? null,
      bestCapture: candidate?.materialInvitation?.bestCapture || null,
      engine: candidate?.engine
        ? {
            playedRank: candidate.engine.playedRank,
            scoreLoss: candidate.engine.scoreLoss,
            bestScore: candidate.engine.bestScore,
            afterScoreForPlayer: candidate.engine.afterScoreForPlayer,
            brilliancyProfile: candidate.engine.brilliancyProfile || null
          }
        : null
    };
  });

  return {
    set: score.set,
    summary: score.summary,
    missCauseGroups: groupCount(misses, (item) => item.cause),
    missRejectedReasonGroups: groupCount(misses, (item) => item.rejectedReason || item.cause),
    missPieceGroups: groupCount(misses, (item) => `${item.piece || "none"}x${item.captured || "-"}`),
    falsePositiveProfileGroups: groupCount(falsePositives, (item) => item.profile || "unknown"),
    falsePositivePieceGroups: groupCount(falsePositives, (item) => `${item.piece || "none"}x${item.captured || "-"}`),
    falsePositiveReasonPairs: groupCount(falsePositives, (item) => (item.reasons || []).slice(0, 4).join(" | ") || "none"),
    misses,
    falsePositives
  };
}

function aggregateDiagnostics(items) {
  const allMisses = items.flatMap((item) => item.misses);
  const allFalsePositives = items.flatMap((item) => item.falsePositives);

  return {
    missCauseGroups: groupCount(allMisses, (item) => item.cause),
    missRejectedReasonGroups: groupCount(allMisses, (item) => item.rejectedReason || item.cause),
    missPieceGroups: groupCount(allMisses, (item) => `${item.piece || "none"}x${item.captured || "-"}`),
    falsePositiveProfileGroups: groupCount(allFalsePositives, (item) => item.profile || "unknown"),
    falsePositivePieceGroups: groupCount(allFalsePositives, (item) => `${item.piece || "none"}x${item.captured || "-"}`)
  };
}

function groupCount(items, keyFn) {
  const groups = new Map();
  for (const item of items) {
    const key = keyFn(item);
    groups.set(key, (groups.get(key) || 0) + 1);
  }

  return Object.fromEntries([...groups.entries()].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0]))));
}

function stripSuffix(value) {
  return String(value || "").replace(/[+#]+$/g, "");
}

function parseArgs(args) {
  const parsed = {
    sets: ["sab3"],
    checkpoints: {},
    completedOnly: false,
    out: "data/reports/detector-failure-diagnostics.json"
  };

  for (const arg of args) {
    if (arg.startsWith("--sets=")) parsed.sets = arg.slice("--sets=".length).split(",").filter(Boolean);
    else if (arg.startsWith("--checkpoint=")) {
      const value = arg.slice("--checkpoint=".length);
      const equals = value.indexOf("=");
      if (equals > 0) parsed.checkpoints[value.slice(0, equals)] = value.slice(equals + 1);
    }
    else if (arg.startsWith("--out=")) parsed.out = arg.slice("--out=".length);
    else if (arg === "--completed-only") parsed.completedOnly = true;
  }

  return parsed;
}
