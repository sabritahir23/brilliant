import { promises as fs } from "node:fs";
import path from "node:path";
import { getCorpusPaths, upsertCorpusGames } from "../src/gameCorpus.js";

const username = String(process.argv[2] || "7yub").trim();
const dataDir = path.resolve(process.cwd(), "data");
const referenceFile = path.join(dataDir, "reference", `${username.toLowerCase()}-chesscom-review-state.json`);
const stateFile = path.join(dataDir, "state.json");

await importReference();
await importCurrentState();

const paths = getCorpusPaths(username);
const summary = JSON.parse(await fs.readFile(paths.summaryJson, "utf8"));
console.log(JSON.stringify({ paths, summary }, null, 2));

async function importReference() {
  const reference = await readJsonIfExists(referenceFile);
  if (!reference) return;

  await upsertCorpusGames(username, reference.games || [], { source: "prototype-reference" });
}

async function importCurrentState() {
  const state = await readJsonIfExists(stateFile);
  if (!state || String(state.username || "").toLowerCase() !== username.toLowerCase()) return;

  const source = state.mode === "local" ? "local" : "chesscom-pgn";
  await upsertCorpusGames(username, state.games || [], { source });
}

async function readJsonIfExists(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}
