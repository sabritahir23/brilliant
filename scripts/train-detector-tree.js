import { promises as fs } from "node:fs";
import path from "node:path";

const options = parseArgs(process.argv.slice(2));
const rows = (await fs.readFile(options.dataset, "utf8"))
  .split(/\r?\n/)
  .map((line) => line.trim())
  .filter(Boolean)
  .map((line) => JSON.parse(line));

const featureSpec = buildFeatureSpec(rows);
const items = rows.map((row, index) => ({
  row,
  index,
  x: rawVector(row, featureSpec),
  y: row.officialBrilliant ? 1 : 0
}));
const trainItems = items.filter((item) => item.row.split === "train");
const validationItems = items.filter((item) => item.row.split === "validation");
const model = trainForest(trainItems, featureSpec, options);
const threshold = tuneThreshold(trainItems, model);
const report = {
  generatedAt: new Date().toISOString(),
  dataset: options.dataset,
  featureCount: featureSpec.names.length,
  threshold,
  options,
  train: evaluateItems(trainItems, model, threshold),
  validation: evaluateItems(validationItems, model, threshold),
  all: evaluateItems(items, model, threshold),
  topFeatures: topFeatureUsage(model, featureSpec.names, 50)
};

await fs.mkdir(path.dirname(options.out), { recursive: true });
await fs.writeFile(options.out, `${JSON.stringify({ featureSpec, model, threshold, report }, null, 2)}\n`, "utf8");
console.log(JSON.stringify(report, null, 2));

function trainForest(trainRows, spec, opts) {
  const positives = trainRows.filter((item) => item.y);
  const negatives = trainRows.filter((item) => !item.y);
  const trees = [];
  const negativeSampleSize = Math.min(negatives.length, Math.max(opts.minNegatives, positives.length * opts.negativeRatio));

  for (let index = 0; index < opts.trees; index += 1) {
    const sampledNegatives = deterministicSample(negatives, negativeSampleSize, `neg:${index}`);
    const sampledPositives = opts.samplePositives
      ? deterministicSample(positives, positives.length, `pos:${index}`)
      : positives;
    const sample = deterministicShuffle([...sampledPositives, ...sampledNegatives], `tree:${index}`);
    trees.push(buildTree(sample, spec, opts, 0));
  }

  return {
    type: "balanced-forest",
    trees,
    positiveCount: positives.length,
    negativeCount: negatives.length
  };
}

function buildTree(items, spec, opts, depth) {
  const stats = labelStats(items);
  const probability = stats.weightedPositive / stats.weightedTotal;

  if (
    depth >= opts.maxDepth ||
    items.length < opts.minSplit ||
    stats.positive === 0 ||
    stats.negative === 0
  ) {
    return leaf(probability, stats);
  }

  const split = findBestSplit(items, spec, opts);
  if (!split || split.gain < opts.minGain) return leaf(probability, stats);

  const left = [];
  const right = [];
  for (const item of items) {
    if (item.x[split.featureIndex] <= split.threshold) left.push(item);
    else right.push(item);
  }

  if (left.length < opts.minLeaf || right.length < opts.minLeaf) return leaf(probability, stats);

  return {
    type: "split",
    probability,
    stats,
    featureIndex: split.featureIndex,
    feature: spec.names[split.featureIndex],
    threshold: split.threshold,
    gain: split.gain,
    left: buildTree(left, spec, opts, depth + 1),
    right: buildTree(right, spec, opts, depth + 1)
  };
}

function findBestSplit(items, spec, opts) {
  const parentStats = labelStats(items);
  const parentImpurity = weightedGini(parentStats);
  let best = null;

  for (let featureIndex = 0; featureIndex < spec.names.length; featureIndex += 1) {
    const thresholds = candidateThresholds(items, featureIndex, opts.thresholdsPerFeature);
    for (const threshold of thresholds) {
      const left = [];
      const right = [];
      for (const item of items) {
        if (item.x[featureIndex] <= threshold) left.push(item);
        else right.push(item);
      }
      if (left.length < opts.minLeaf || right.length < opts.minLeaf) continue;

      const leftStats = labelStats(left);
      const rightStats = labelStats(right);
      if (leftStats.positive === 0 && rightStats.positive === 0) continue;

      const weightedChildImpurity =
        (leftStats.weightedTotal / parentStats.weightedTotal) * weightedGini(leftStats) +
        (rightStats.weightedTotal / parentStats.weightedTotal) * weightedGini(rightStats);
      const gain = parentImpurity - weightedChildImpurity;

      if (!best || gain > best.gain) {
        best = { featureIndex, threshold, gain };
      }
    }
  }

  return best;
}

function candidateThresholds(items, featureIndex, limit) {
  const values = [...new Set(items.map((item) => item.x[featureIndex]).filter(Number.isFinite))].sort((a, b) => a - b);
  if (values.length <= 1) return [];
  if (values.length === 2 && values[0] === 0 && values[1] === 1) return [0.5];

  const thresholds = [];
  const maxThresholds = Math.max(1, Math.min(limit, values.length - 1));
  for (let i = 1; i <= maxThresholds; i += 1) {
    const pos = Math.floor((i * values.length) / (maxThresholds + 1));
    const left = values[Math.max(0, pos - 1)];
    const right = values[Math.min(values.length - 1, pos)];
    if (left !== right) thresholds.push((left + right) / 2);
  }

  return [...new Set(thresholds)];
}

function labelStats(items) {
  let positive = 0;
  let negative = 0;
  let weightedPositive = 0;
  let weightedNegative = 0;

  for (const item of items) {
    if (item.y) {
      positive += 1;
      weightedPositive += 8;
    } else {
      negative += 1;
      weightedNegative += 1;
    }
  }

  return {
    rows: items.length,
    positive,
    negative,
    weightedPositive,
    weightedNegative,
    weightedTotal: weightedPositive + weightedNegative
  };
}

function weightedGini(stats) {
  if (!stats.weightedTotal) return 0;
  const p = stats.weightedPositive / stats.weightedTotal;
  const n = stats.weightedNegative / stats.weightedTotal;
  return 1 - p * p - n * n;
}

function leaf(probability, stats) {
  return {
    type: "leaf",
    probability,
    stats
  };
}

function tuneThreshold(items, model) {
  let best = { threshold: 0.5, score: -Infinity };

  for (let i = 1; i < 100; i += 1) {
    const threshold = i / 100;
    const result = evaluateItems(items, model, threshold);
    const score = result.f1 * 1000 + result.recall * 40 - result.falsePositives * 1.5;
    if (score > best.score) best = { threshold, score };
  }

  return best.threshold;
}

function evaluateItems(items, model, threshold) {
  let tp = 0;
  let fp = 0;
  let tn = 0;
  let fn = 0;

  for (const item of items) {
    const predicted = predict(item, model) >= threshold;
    if (predicted && item.y) tp += 1;
    else if (predicted) fp += 1;
    else if (item.y) fn += 1;
    else tn += 1;
  }

  const precision = ratio(tp, tp + fp);
  const recall = ratio(tp, tp + fn);
  const f1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 0;

  return {
    rows: items.length,
    positives: tp + fn,
    predictedPositive: tp + fp,
    truePositives: tp,
    falsePositives: fp,
    falseNegatives: fn,
    trueNegatives: tn,
    precision,
    recall,
    f1
  };
}

function predict(item, model) {
  if (!model.trees.length) return 0;
  let sum = 0;
  for (const tree of model.trees) sum += predictTree(item, tree);
  return sum / model.trees.length;
}

function predictTree(item, node) {
  let cursor = node;
  while (cursor.type === "split") {
    cursor = item.x[cursor.featureIndex] <= cursor.threshold ? cursor.left : cursor.right;
  }
  return cursor.probability;
}

function buildFeatureSpec(items) {
  const names = [];
  const seen = new Set();

  for (const row of items) {
    for (const [name] of flattenFeatures(row.features)) {
      if (seen.has(name)) continue;
      seen.add(name);
      names.push(name);
    }
  }

  return { names };
}

function rawVector(row, spec) {
  const values = new Map(flattenFeatures(row.features));
  return spec.names.map((name) => values.get(name) || 0);
}

function flattenFeatures(value, prefix = "f") {
  const out = [];

  for (const [key, item] of Object.entries(value || {})) {
    const name = `${prefix}.${key}`;
    if (item == null) {
      out.push([`${name}.missing`, 1]);
    } else if (typeof item === "boolean") {
      out.push([name, item ? 1 : 0]);
    } else if (typeof item === "number") {
      out.push([name, Number.isFinite(item) ? item : 0]);
      if (!Number.isFinite(item)) out.push([`${name}.missing`, 1]);
    } else if (typeof item === "string") {
      out.push([`${name}=${item}`, 1]);
    } else if (typeof item === "object") {
      out.push(...flattenFeatures(item, name));
    }
  }

  return out;
}

function topFeatureUsage(model, names, count) {
  const usage = new Map();
  for (const tree of model.trees) collectFeatureUsage(tree, usage);

  return [...usage.entries()]
    .map(([index, value]) => ({ feature: names[index], count: value.count, gain: value.gain }))
    .sort((a, b) => b.gain - a.gain || b.count - a.count || a.feature.localeCompare(b.feature))
    .slice(0, count);
}

function collectFeatureUsage(node, usage) {
  if (!node || node.type !== "split") return;
  const current = usage.get(node.featureIndex) || { count: 0, gain: 0 };
  current.count += 1;
  current.gain += node.gain || 0;
  usage.set(node.featureIndex, current);
  collectFeatureUsage(node.left, usage);
  collectFeatureUsage(node.right, usage);
}

function deterministicSample(items, count, seed) {
  return deterministicShuffle(items, seed).slice(0, count);
}

function deterministicShuffle(items, seed) {
  return items
    .map((item, index) => ({
      item,
      key: hashNumber(`${seed}:${index}:${item.row.set}:${item.row.index}:${item.row.lan}`)
    }))
    .sort((a, b) => a.key - b.key)
    .map(({ item }) => item);
}

function hashNumber(value) {
  let hash = 2166136261;
  for (const char of String(value)) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function ratio(numerator, denominator) {
  return denominator ? numerator / denominator : 0;
}

function parseArgs(args) {
  const parsed = {
    dataset: "data/reports/detector-supervised-dataset.jsonl",
    out: "data/reports/detector-tree-model.json",
    trees: 25,
    maxDepth: 4,
    minSplit: 24,
    minLeaf: 4,
    minGain: 0.0005,
    thresholdsPerFeature: 12,
    negativeRatio: 24,
    minNegatives: 600,
    samplePositives: false
  };

  for (const arg of args) {
    if (arg.startsWith("--dataset=")) parsed.dataset = arg.slice("--dataset=".length);
    else if (arg.startsWith("--out=")) parsed.out = arg.slice("--out=".length);
    else if (arg.startsWith("--trees=")) parsed.trees = Number(arg.slice("--trees=".length)) || parsed.trees;
    else if (arg.startsWith("--max-depth=")) parsed.maxDepth = Number(arg.slice("--max-depth=".length)) || parsed.maxDepth;
    else if (arg.startsWith("--min-split=")) parsed.minSplit = Number(arg.slice("--min-split=".length)) || parsed.minSplit;
    else if (arg.startsWith("--min-leaf=")) parsed.minLeaf = Number(arg.slice("--min-leaf=".length)) || parsed.minLeaf;
    else if (arg.startsWith("--min-gain=")) parsed.minGain = Number(arg.slice("--min-gain=".length)) || parsed.minGain;
    else if (arg.startsWith("--thresholds-per-feature=")) parsed.thresholdsPerFeature = Number(arg.slice("--thresholds-per-feature=".length)) || parsed.thresholdsPerFeature;
    else if (arg.startsWith("--negative-ratio=")) parsed.negativeRatio = Number(arg.slice("--negative-ratio=".length)) || parsed.negativeRatio;
    else if (arg.startsWith("--min-negatives=")) parsed.minNegatives = Number(arg.slice("--min-negatives=".length)) || parsed.minNegatives;
    else if (arg === "--sample-positives") parsed.samplePositives = true;
  }

  return parsed;
}
