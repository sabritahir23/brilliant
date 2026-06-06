# Brilliant Scanner

Personal beta scanner for finding Chess.com games with Brilliant-like moves.

The current primary path is a local PGN candidate finder. The original Chess.com
Game Review UI scraper is still present as the prototype/reference path.

## Local PGN Mode

1. Fetches public Chess.com game archives for a username.
2. Reads the PGN payload returned by the archive API.
3. Replays each game locally with `chess.js`.
4. Runs a first-pass brilliancy candidate finder that looks for sacrifice-shaped,
   forcing moves.
5. Saves candidate games and move-level details to `data/state.json` and exports.

This mode does not require Chrome login and does not open Chess.com review pages.
The current candidate finder is intentionally heuristic-only; `src/stockfishAnalyzer.js`
now verifies candidates with Stockfish.js before counting them.

Useful local-analysis settings:

- `BRILLIANT_STOCKFISH_DEPTH=14` controls verification depth.
- `BRILLIANT_STOCKFISH_MULTIPV=8` controls how many engine candidate lines are checked.
- `BRILLIANT_STOCKFISH_ENGINE=full` selects the bundled Stockfish.js engine flavor.
- `BRILLIANT_STOCKFISH_TIMEOUT_MS=12000` controls the per-search watchdog. If Stockfish does not return `bestmove` in time, the child process is restarted and that candidate is rejected instead of hanging the scan.

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

- `Update Official Review Baseline` scans only games newer than the saved
  prototype reference baseline.
- `Fill Official Brilliant Moves` revisits known official Brilliant games that
  have a count but no exact move labels yet.

## Prototype Review Scanner

1. Fetches public Chess.com game archives for a username.
2. Attaches to a normal Google Chrome window that you logged into manually.
3. Reads the Game Review summary table.
4. Saves games where your own Brilliant count is greater than zero.
5. Persists progress to `data/state.json` so the scan can resume.

This uses Chess.com's visible review UI, not a private API. If Chess.com changes the page, asks you to log in again, rate limits, or blocks review pages, those games are recorded as errors and the scan continues.

## Setup

```bash
npm install
npm run install-browser
npm run chrome
npm start
```

After `npm run chrome`, a regular Google Chrome window opens. Log into Chess.com manually in that window, leave the window open, then use the scanner page. This avoids trying to solve Chess.com's robot checks inside a Playwright-launched login browser.

If the first scanned game still lands on a Chess.com login or robot-check page, the scanner pauses and leaves that Chrome tab open. Log in or approve the phone prompt in that same tab, then click `Start / Resume` on the scanner page with `Resume saved progress` checked.

Open:

```txt
http://localhost:5050
```

## Runtime Notes

- The scanner opens one page at a time and closes it after checking the game.
- Default delay between games is 5 seconds.
- Set `BRILLIANT_DELAY_MS=8000` to slow the scan down.
- Set `BRILLIANT_REVIEW_TIMEOUT_MS=90000` if review pages load slowly.
- The scanner connects to Chrome at `http://127.0.0.1:9222`. Set `BRILLIANT_CDP_URL` only if you need a different port.
- The old Playwright-launched browser mode is disabled by default. Set `BRILLIANT_USE_PLAYWRIGHT_BROWSER=true` only if you intentionally want to try it again.

## Known Limits

- This is best-effort official UI scraping, not an official Chess.com API integration.
- Some games may need review generation, premium access, or manual intervention.
- If Chess.com presents login, CAPTCHA, rate limiting, or an unavailable review page, the game is logged as an error.
