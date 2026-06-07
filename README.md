# Brilliant Scanner

Personal beta scanner for finding Chess.com games with Brilliant-like moves.

The primary path is a local PGN candidate finder. Its output is a local prediction,
not an official Chess.com Brilliant label. The original Chess.com Game Review UI
scraper remains available as a legacy/reference path for collecting official labels.

## Detector-First Review Queue Phase

The earlier workflow sent blind chronological batches of 500 games through
Chess.com Review. That was slow and expensive because a large batch might produce
only a small number of official Brilliant labels.

The current development direction is detector-first:

1. Fetch a large pool of public PGNs.
2. Run the local detector over those games and rank likely Brilliant-like candidates.
3. Send top-ranked games plus a smaller random/control sample to Chess.com Review.
4. Treat the Chess.com Review result as the official label.
5. Use those labels to evaluate and improve the local detector, then repeat.

The random/control sample prevents the dataset from overfitting to the detector's
current guesses. It can reveal Brilliant moves the detector misses and provides a
more honest estimate of recall. The ranked review queue itself is not implemented
yet; the current UI prepares the local candidate pool and keeps legacy label tools
separate.

## Local PGN Mode

1. Fetches public Chess.com game archives for a username.
2. Reads the PGN payload returned by the archive API.
3. Replays each game locally with `chess.js`.
4. Runs a first-pass brilliancy candidate finder that looks for sacrifice-shaped,
   forcing moves.
5. Saves candidate games and move-level details to `data/state.json` and exports.

This mode does not require Chrome login and does not open Chess.com review pages.
`src/stockfishAnalyzer.js` applies Stockfish checks before a move is retained as a
local Brilliant-like candidate. This still does not make the result an official
Chess.com label.

Useful local-analysis settings:

- `BRILLIANT_STOCKFISH_DEPTH=14` controls verification depth.
- `BRILLIANT_STOCKFISH_MULTIPV=8` controls how many engine candidate lines are checked.
- `BRILLIANT_STOCKFISH_ENGINE=full` selects the bundled Stockfish.js engine flavor.
- `BRILLIANT_STOCKFISH_TIMEOUT_MS=12000` controls the per-search watchdog. If Stockfish does not return `bestmove` in time, the child process is restarted and that candidate is rejected instead of hanging the scan.

## Bounded PGN Batch Runner

Use the CLI runner to analyze a manageable chronological slice instead of scanning
an entire large account:

```bash
npm run pgn-batch -- wittyalien --from 2024-01-01 --limit 1000
npm run pgn-batch -- wittyalien --continue --limit 1000
npm run pgn-batch -- wittyalien --from 2023-01-01 --until 2024-01-01 --limit 1000
```

The start date is inclusive and `--until` is exclusive, both in UTC. Bullet games
are excluded by default; use repeatable `--exclude-time-class` options or an
`--include-time-class` allowlist to adjust the selection. The runner stops after
the requested number of eligible games, runs the existing local detector, and
saves progress to `data/corpus/<username>/batch-state.json`. JSON and JSONL reports
are written under `data/reports/`.

This runner prepares corpus data for future review queue generation. Its
Brilliant-like candidates are local predictions, not official Chess.com Brilliant
labels. Use `--dry-run` to inspect a batch without analyzing games or writing data.

The latest 7yub Chess.com Review benchmark is shelved in `data/reference/` so
local runs can overwrite `data/state.json` without losing the original 10/248
reference result.

## Per-Player Corpus

The scanner now keeps one merged per-player corpus under `data/corpus/<username>/`.
For 7yub, the main file is:

```txt
data/corpus/7yub/games.jsonl
```

Each line is one game with PGN plus any available review metadata:

- `prototype` contains official Chess.com Review scrape results.
- `local` contains heuristic/Stockfish candidate results.

Use `npm run build-corpus -- 7yub` to rebuild the corpus from the saved prototype
reference and the current `data/state.json`.

From the local UI:

- `Scan PGNs Locally` is the primary detector-first action.
- Legacy official-review tools are kept in an advanced section for collecting
  labels, filling missing move labels, retrying errors, and debugging saved runs.

## Legacy Prototype Review Scanner

1. Fetches public Chess.com game archives for a username.
2. Attaches to a normal Google Chrome window that you logged into manually.
3. Reads the Game Review summary table.
4. Saves games where your own Brilliant count is greater than zero.
5. Persists progress to `data/state.json` so the scan can resume.

This is a reference/debugging tool, not the primary workflow. It uses Chess.com's
visible review UI, not a private API. If Chess.com changes the page, asks you to
log in again, rate limits, or blocks review pages, those games are recorded as
errors and the scan continues.

## Setup

```bash
npm install
npm run install-browser
npm run chrome
npm start
```

After `npm run chrome`, a regular Google Chrome window opens. Log into Chess.com manually in that window, leave the window open, then use the scanner page. This avoids trying to solve Chess.com's robot checks inside a Playwright-launched login browser.

If the first official review scan lands on a Chess.com login or robot-check page,
the scanner pauses and leaves that Chrome tab open. Log in or approve the prompt
in that same tab, then use the advanced legacy official-review tools to resume the
saved review run.

Open:

```txt
http://localhost:5050
```

## Runtime Notes

- The legacy official-review scanner opens one Chess.com Review page at a time
  and closes it after checking the game. Local PGN mode does not open review pages.
- Default delay between games is 5 seconds.
- Set `BRILLIANT_DELAY_MS=8000` to slow the scan down.
- Set `BRILLIANT_REVIEW_TIMEOUT_MS=90000` if review pages load slowly.
- The scanner connects to Chrome at `http://127.0.0.1:9222`. Set `BRILLIANT_CDP_URL` only if you need a different port.
- The old Playwright-launched browser mode is disabled by default. Set `BRILLIANT_USE_PLAYWRIGHT_BROWSER=true` only if you intentionally want to try it again.

## Known Limits

- This is best-effort official UI scraping, not an official Chess.com API integration.
- Some games may need review generation, premium access, or manual intervention.
- If Chess.com presents login, CAPTCHA, rate limiting, or an unavailable review page, the game is logged as an error.
