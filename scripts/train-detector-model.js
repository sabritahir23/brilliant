import { promises as fs } from "node:fs";
import path from "node:path";

const options = parseArgs(process.argv.slice(2));
const rows = (await fs.readFile(options.dataset, "utf8"))
  .split(/\r?\n/)
  .map((line) => line.trim())
  .filter(Boolean)
  .map((line) => JSON.parse(line));

const featureSpec = buildFeatureSpec(rows);
const trainRows = rows.filter((row) => row.split === "train");
const validationRows = rows.filter((row) => row.split === "validation");
const scaler = buildScaler(trainRows, featureSpec);
const trainItems = prepareRows(trainRows, featureSpec, scaler);
const validationItems = prepareRows(validationRows, featureSpec, scaler);
const allItems = prepareRows(rows, featureSpec, scaler);
const model = trainLogisticModel(trainItems, options);
const threshold = tuneThreshold(trainItems, model);
const report = {
  generatedAt: new Date().toISOString(),
  dataset: options.dataset,
  featureCount: featureSpec.names.length,
  threshold,
  train: evaluatePreparedRows(trainItems, model, threshold),
  validation: evaluatePreparedRows(validationItems, model, threshold),
  all: evaluatePreparedRows(allItems, model, threshold),
  topWeights: topWeights(model, featureSpec.names, 40)
};

await fs.mkdir(path.dirname(options.out), { recursive: true });
await fs.writeFile(options.out, `${JSON.stringify({ featureSpec, scaler, model, threshold, report }, null, 2)}\n`, "utf8");
console.log(JSON.stringify(report, null, 2));

function trainLogisticModel(items, options) {
  const weights = new Array(items[0]?.x.length || 0).fill(0);
  let bias = 0;
  const positives = items.filter((row) => row.y).length;
  const negatives = items.length - positives;
  const positiveWeight = positives ? Math.min(80, negatives / positives) : 1;

  for (let epoch = 0; epoch < options.epochs; epoch += 1) {
    const rate = options.learningRate / Math.sqrt(1 + epoch / 20);
    for (const row of deterministicShuffle(items, epoch)) {
      const x = row.x;
      const y = row.y;
      const p = sigmoid(dot(weights, x) + bias);
      const sampleWeight = y ? positiveWeight : 1;
      const error = (p - y) * sampleWeight;

      for (let i = 0; i < weights.length; i += 1) {
        weights[i] -= rate * (error * x[i] + options.l2 * weights[i]);
      }
      bias -= rate * error;
    }
  }

  return { weights, bias, positiveWeight };
}

function tuneThreshold(items, model) {
  let best = { threshold: 0.5, score: -Infinity };

  for (let i = 1; i < 100; i += 1) {
    const threshold = i / 100;
    const result = evaluatePreparedRows(items, model, threshold);
    const score = result.f1 * 1000 + result.recall * 20 - result.falsePositives;
    if (score > best.score) best = { threshold, score };
  }

  return best.threshold;
}

function evaluatePreparedRows(items, model, threshold) {
  let tp = 0;
  let fp = 0;
  let tn = 0;
  let fn = 0;

  for (const row of items) {
    const predicted = predictPrepared(row, model) >= threshold;
    if (predicted && row.y) tp += 1;
    else if (predicted) fp += 1;
    else if (row.y) fn += 1;
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

function prepareRows(items, spec, scaler) {
  return items.map((row, index) => ({
    row,
    index,
    x: vectorize(row, spec, scaler),
    y: row.officialBrilliant ? 1 : 0
  }));
}

function predictPrepared(item, model) {
  return sigmoid(dot(model.weights, item.x) + model.bias);
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

function buildScaler(items, spec) {
  const means = new Array(spec.names.length).fill(0);
  const variances = new Array(spec.names.length).fill(0);
  const count = Math.max(1, items.length);

  for (const row of items) {
    const raw = rawVector(row, spec);
    for (let i = 0; i < raw.length; i += 1) means[i] += raw[i] / count;
  }

  for (const row of items) {
    const raw = rawVector(row, spec);
    for (let i = 0; i < raw.length; i += 1) {
      const delta = raw[i] - means[i];
      variances[i] += (delta * delta) / count;
    }
  }

  return {
    means,
    stds: variances.map((variance) => Math.sqrt(variance) || 1)
  };
}

function vectorize(row, spec, scaler) {
  const raw = rawVector(row, spec);
  return raw.map((value, index) => (value - scaler.means[index]) / scaler.stds[index]);
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

function topWeights(model, names, count) {
  return names
    .map((name, index) => ({ name, weight: model.weights[index] }))
    .sort((a, b) => Math.abs(b.weight) - Math.abs(a.weight))
    .slice(0, count);
}

function deterministicShuffle(items, epoch) {
  return items
    .map((item, index) => ({
      item,
      key: hashNumber(`${epoch}:${index}:${item.row.set}:${item.row.index}:${item.row.lan}`)
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

function sigmoid(value) {
  if (value < -40) return 0;
  if (value > 40) return 1;
  return 1 / (1 + Math.exp(-value));
}

function dot(a, b) {
  let sum = 0;
  for (let i = 0; i < a.length; i += 1) sum += a[i] * b[i];
  return sum;
}

function ratio(numerator, denominator) {
  return denominator ? numerator / denominator : 0;
}

function parseArgs(args) {
  const parsed = {
    dataset: "data/reports/detector-supervised-dataset.jsonl",
    out: "data/reports/detector-supervised-model.json",
    epochs: 120,
    learningRate: 0.01,
    l2: 0.0005
  };

  for (const arg of args) {
    if (arg.startsWith("--dataset=")) parsed.dataset = arg.slice("--dataset=".length);
    else if (arg.startsWith("--out=")) parsed.out = arg.slice("--out=".length);
    else if (arg.startsWith("--epochs=")) parsed.epochs = Number(arg.slice("--epochs=".length)) || parsed.epochs;
    else if (arg.startsWith("--learning-rate=")) parsed.learningRate = Number(arg.slice("--learning-rate=".length)) || parsed.learningRate;
    else if (arg.startsWith("--l2=")) parsed.l2 = Number(arg.slice("--l2=".length)) || parsed.l2;
  }

  return parsed;
}
