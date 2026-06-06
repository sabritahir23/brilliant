const API_BASE = "https://api.chess.com/pub";
const USER_AGENT = "brilliant-scanner personal-use";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function fetchJson(url, attempts = 4) {
  let lastError;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: {
          "User-Agent": USER_AGENT,
          Accept: "application/json"
        }
      });

      if (response.status === 404) {
        throw new Error("Chess.com user or archive not found.");
      }

      if (response.status === 429) {
        const retryAfter = Number(response.headers.get("retry-after")) || attempt * 10;
        await sleep(retryAfter * 1000);
        continue;
      }

      if (!response.ok) {
        throw new Error(`Chess.com API returned HTTP ${response.status}`);
      }

      return response.json();
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await sleep(attempt * 1500);
    }
  }

  throw lastError;
}

export function toReviewUrl(gameUrl) {
  try {
    const url = new URL(gameUrl);
    const parts = url.pathname.split("/").filter(Boolean);

    if (parts[0] === "game" && parts[1] && parts[2]) {
      return `https://www.chess.com/analysis/game/${parts[1]}/${parts[2]}/review`;
    }

    if (parts[0] === "analysis" && parts[1] === "game" && parts[2] && parts[3]) {
      return `https://www.chess.com/analysis/game/${parts[2]}/${parts[3]}/review`;
    }
  } catch {
    return null;
  }

  return null;
}

export async function fetchUserGames(username, onProgress = async () => {}, options = {}) {
  const normalizedUsername = username.trim().toLowerCase();
  const archiveIndex = await fetchJson(`${API_BASE}/player/${normalizedUsername}/games/archives`);
  const sinceEndTime = Number(options.sinceEndTime);
  const archives = (archiveIndex.archives || []).filter((archiveUrl) => {
    if (!Number.isFinite(sinceEndTime)) return true;
    return isArchiveAtOrAfterTimestamp(archiveUrl, sinceEndTime);
  });
  const games = [];
  const seen = new Set();

  for (let archiveNumber = 0; archiveNumber < archives.length; archiveNumber += 1) {
    const archiveUrl = archives[archiveNumber];
    const archiveLabel = archiveUrl.split("/").slice(-2).join("/");

    await onProgress({
      archiveNumber: archiveNumber + 1,
      totalArchives: archives.length,
      archiveUrl,
      archiveLabel,
      gamesFound: games.length
    });

    const archive = await fetchJson(archiveUrl);

    for (const game of archive.games || []) {
      if (seen.has(game.url)) continue;
      seen.add(game.url);

      const white = game.white?.username || "";
      const black = game.black?.username || "";
      const userColor =
        white.toLowerCase() === normalizedUsername
          ? "white"
          : black.toLowerCase() === normalizedUsername
            ? "black"
            : null;

      const reviewUrl = toReviewUrl(game.url);

      games.push({
        id: game.uuid || game.url,
        url: game.url,
        reviewUrl,
        white,
        black,
        whiteRating: game.white?.rating || null,
        blackRating: game.black?.rating || null,
        userColor,
        rules: game.rules || "unknown",
        timeClass: game.time_class || "unknown",
        endTime: game.end_time || null,
        pgn: game.pgn || "",
        status: reviewUrl && userColor && game.rules === "chess" ? "pending" : "skipped",
        brilliantCount: null,
        checkedAt: null,
        error: null
      });
    }

    await onProgress({
      archiveNumber: archiveNumber + 1,
      totalArchives: archives.length,
      archiveUrl,
      archiveLabel,
      gamesFound: games.length
    });

    await sleep(400);
  }

  return games;
}

function isArchiveAtOrAfterTimestamp(archiveUrl, timestamp) {
  const match = String(archiveUrl).match(/\/games\/(\d{4})\/(\d{1,2})$/);
  if (!match) return true;

  const year = Number(match[1]);
  const month = Number(match[2]);
  if (!Number.isFinite(year) || !Number.isFinite(month)) return true;

  const since = new Date(timestamp * 1000);
  const archiveMonthEnd = Date.UTC(year, month, 0, 23, 59, 59);
  const sinceMonthStart = Date.UTC(since.getUTCFullYear(), since.getUTCMonth(), 1);

  return archiveMonthEnd >= sinceMonthStart;
}
