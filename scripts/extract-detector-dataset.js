import {
  applySetOverrides,
  buildDatasetRows,
  loadKnownSet,
  scoreKnownSet,
  selectSetDefinitions,
  summarizeScores,
  writeJsonl,
  writeJsonReport
} from "./lib/detectorRegression.js";

const options = parseArgs(process.argv.slice(2));
const sets = applySetOverrides(selectSetDefinitions(options.sets), options);
const datasetRows = [];
const scores = [];

for (const set of sets) {
  const loaded = await loadKnownSet(set);
  datasetRows.push(...buildDatasetRows(loaded));
  scores.push(scoreKnownSet(loaded));
}

const summary = {
  generatedAt: new Date().toISOString(),
  rows: datasetRows.length,
  acceptedRows: datasetRows.filter((row) => row.detectorAccepted).length,
  positiveRows: datasetRows.filter((row) => row.officialBrilliant).length,
  positiveAcceptedRows: datasetRows.filter((row) => row.officialBrilliant && row.detectorAccepted).length,
  officialBrilliantGameRows: datasetRows.filter((row) => row.officialBrilliantGame).length,
  bySplit: summarizeDatasetBy(datasetRows, "split"),
  bySet: summarizeDatasetBy(datasetRows, "set"),
  regression: {
    totals: summarizeScores(scores),
    sets: scores.map((score) => ({
      set: score.set,
      summary: score.summary
    }))
  }
};

await writeJsonl(options.out, datasetRows);
await writeJsonReport(options.summaryOut, summary);

console.log(JSON.stringify({
  out: options.out,
  summaryOut: options.summaryOut,
  rows: summary.rows,
  positiveRows: summary.positiveRows,
  acceptedRows: summary.acceptedRows,
  positiveAcceptedRows: summary.positiveAcceptedRows,
  candidateGenerationRecall: summary.regression.totals.candidateGenerationRecall,
  exactRecall: summary.regression.totals.exactRecall,
  exactPrecision: summary.regression.totals.exactPrecision
}, null, 2));

function summarizeDatasetBy(rows, key) {
  const groups = new Map();

  for (const row of rows) {
    const id = row[key] || "unknown";
    const group = groups.get(id) || {
      rows: 0,
      positives: 0,
      accepted: 0,
      trueAccepted: 0,
      falseAccepted: 0,
      rejectedPositives: 0
    };

    group.rows += 1;
    if (row.officialBrilliant) group.positives += 1;
    if (row.detectorAccepted) group.accepted += 1;
    if (row.officialBrilliant && row.detectorAccepted) group.trueAccepted += 1;
    if (!row.officialBrilliant && row.detectorAccepted) group.falseAccepted += 1;
    if (row.officialBrilliant && !row.detectorAccepted) group.rejectedPositives += 1;
    groups.set(id, group);
  }

  return Object.fromEntries(groups);
}

function parseArgs(args) {
  const parsed = {
    sets: [],
    checkpoints: {},
    completedOnly: false,
    out: "data/reports/detector-supervised-dataset.jsonl",
    summaryOut: "data/reports/detector-supervised-dataset-summary.json"
  };

  for (const arg of args) {
    if (arg.startsWith("--sets=")) parsed.sets = arg.slice("--sets=".length).split(",").filter(Boolean);
    else if (arg.startsWith("--checkpoint=")) {
      const value = arg.slice("--checkpoint=".length);
      const equals = value.indexOf("=");
      if (equals > 0) parsed.checkpoints[value.slice(0, equals)] = value.slice(equals + 1);
    }
    else if (arg.startsWith("--out=")) parsed.out = arg.slice("--out=".length);
    else if (arg.startsWith("--summary-out=")) parsed.summaryOut = arg.slice("--summary-out=".length);
    else if (arg === "--completed-only") parsed.completedOnly = true;
  }

  return parsed;
}
