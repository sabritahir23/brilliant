import {
  applySetOverrides,
  loadKnownSet,
  scoreKnownSet,
  selectSetDefinitions,
  summarizeProfileStats,
  summarizeScores,
  writeJsonReport
} from "./lib/detectorRegression.js";

const options = parseArgs(process.argv.slice(2));
const sets = applySetOverrides(selectSetDefinitions(options.sets), options);
const scores = [];

for (const set of sets) {
  const loaded = await loadKnownSet(set);
  scores.push(scoreKnownSet(loaded));
}

const bySplit = {};
const profileStatsBySplit = {};
for (const split of new Set(scores.map((score) => score.set.split))) {
  const splitScores = scores.filter((score) => score.set.split === split);
  bySplit[split] = summarizeScores(splitScores);
  profileStatsBySplit[split] = summarizeProfileStats(splitScores);
}

const report = {
  generatedAt: new Date().toISOString(),
  sets: scores,
  totals: summarizeScores(scores),
  bySplit,
  profileStats: summarizeProfileStats(scores),
  profileStatsBySplit
};

if (options.out) await writeJsonReport(options.out, report);

if (options.json) {
  console.log(JSON.stringify(report, null, 2));
} else {
  printSummary(report);
}

function printSummary(report) {
  console.log("Detector Regression");
  console.log("===================");
  printLine("all", report.totals);
  for (const [split, summary] of Object.entries(report.bySplit)) printLine(split, summary);

  console.log("\nSets");
  for (const score of report.sets) {
    printLine(score.set.id, score.summary);
  }

  console.log("\nFailure Counts");
  for (const score of report.sets) {
    console.log(
      `${score.set.id}: misses=${score.summary.exactMisses}, fp=${score.summary.exactFalsePositives}, notGenerated=${score.summary.notGeneratedOfficialMoves}, generatedNotAccepted=${score.summary.generatedButNotAcceptedOfficialMoves}`
    );
  }

  if (report.profileStats.length) {
    console.log("\nAccepted Profiles");
    for (const item of report.profileStats.slice(0, 12)) {
      console.log(
        `${item.profile}: moves=${item.detectorMoves}, hits=${item.exactHits}, fp=${item.exactFalsePositives}, precision=${pct(item.exactPrecision)}`
      );
    }
  }

  if (options.out) console.log(`\nWrote ${options.out}`);
}

function printLine(label, summary) {
  console.log(
    `${label}: games=${summary.games}, officialMoves=${summary.officialBrilliantMoves}, detectorMoves=${summary.detectorCandidateMoves}, hits=${summary.exactHits}, misses=${summary.exactMisses}, fp=${summary.exactFalsePositives}, exactRecall=${pct(summary.exactRecall)}, exactPrecision=${pct(summary.exactPrecision)}, candidateRecall=${pct(summary.candidateGenerationRecall)}`
  );
}

function pct(value) {
  return value == null ? "n/a" : `${(value * 100).toFixed(1)}%`;
}

function parseArgs(args) {
  const parsed = {
    sets: [],
    checkpoints: {},
    completedOnly: false,
    out: null,
    json: false
  };

  for (const arg of args) {
    if (arg.startsWith("--sets=")) parsed.sets = arg.slice("--sets=".length).split(",").filter(Boolean);
    else if (arg.startsWith("--checkpoint=")) {
      const value = arg.slice("--checkpoint=".length);
      const equals = value.indexOf("=");
      if (equals > 0) parsed.checkpoints[value.slice(0, equals)] = value.slice(equals + 1);
    }
    else if (arg.startsWith("--out=")) parsed.out = arg.slice("--out=".length);
    else if (arg === "--json") parsed.json = true;
    else if (arg === "--completed-only") parsed.completedOnly = true;
  }

  return parsed;
}
