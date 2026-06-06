const form = document.querySelector("#scanForm");
const usernameInput = document.querySelector("#username");
const startButton = document.querySelector("#startButton");
const prototypeButton = document.querySelector("#prototypeButton");
const prototypeWindowButton = document.querySelector("#prototypeWindowButton");
const prototypeNextWindowButton = document.querySelector("#prototypeNextWindowButton");
const prototypeThirdWindowButton = document.querySelector("#prototypeThirdWindowButton");
const hikaruRestWindowButton = document.querySelector("#hikaruRestWindowButton");
const resumeWindowButton = document.querySelector("#resumeWindowButton");
const moveLabelsButton = document.querySelector("#moveLabelsButton");
const retryErrorsButton = document.querySelector("#retryErrorsButton");
const retryWindowErrorsButton = document.querySelector("#retryWindowErrorsButton");
const retryNextWindowErrorsButton = document.querySelector("#retryNextWindowErrorsButton");
const retryThirdWindowErrorsButton = document.querySelector("#retryThirdWindowErrorsButton");
const retryHikaruRestWindowErrorsButton = document.querySelector("#retryHikaruRestWindowErrorsButton");
const pauseButton = document.querySelector("#pauseButton");
const resetButton = document.querySelector("#resetButton");
const statusBadge = document.querySelector("#statusBadge");
const progressLabel = document.querySelector("#progressLabel");
const percentLabel = document.querySelector("#percentLabel");
const progressFill = document.querySelector("#progressFill");
const totalGames = document.querySelector("#totalGames");
const scannedGames = document.querySelector("#scannedGames");
const foundGames = document.querySelector("#foundGames");
const failedGames = document.querySelector("#failedGames");
const message = document.querySelector("#message");
const currentGameLink = document.querySelector("#currentGameLink");
const results = document.querySelector("#results");
const errors = document.querySelector("#errors");

const HIKARU_REST_ANCHOR_URL = "https://www.chess.com/game/live/172051815101";

form.addEventListener("submit", async (event) => {
  event.preventDefault();

  const username = usernameInput.value.trim();
  if (!username) {
    alert("Enter your Chess.com username first.");
    return;
  }

  const response = await fetch("/api/scan/start", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username })
  });

  const payload = await response.json();
  if (!response.ok) alert(payload.error || "Failed to start local scan.");
  await refreshStatus();
});

pauseButton.addEventListener("click", async () => {
  await fetch("/api/pause", { method: "POST" });
  await refreshStatus();
});

prototypeButton.addEventListener("click", async () => {
  const username = usernameInput.value.trim();
  if (!username) {
    alert("Enter your Chess.com username first.");
    return;
  }

  const response = await fetch("/api/prototype/since-reference", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username })
  });

  const payload = await response.json();
  if (!response.ok) alert(payload.error || "Failed to start prototype baseline update.");
  await refreshStatus();
});

prototypeWindowButton.addEventListener("click", async () => {
  const username = usernameInput.value.trim();
  if (!username) {
    alert("Enter your Chess.com username first.");
    return;
  }

  const response = await fetch("/api/prototype/window", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, first: 500, offset: 0, order: "oldest" })
  });

  const payload = await response.json();
  if (!response.ok) alert(payload.error || "Failed to start first-500 official review scan.");
  await refreshStatus();
});

prototypeNextWindowButton.addEventListener("click", async () => {
  const username = usernameInput.value.trim();
  if (!username) {
    alert("Enter your Chess.com username first.");
    return;
  }

  const response = await fetch("/api/prototype/window", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, first: 500, offset: 500, order: "oldest" })
  });

  const payload = await response.json();
  if (!response.ok) alert(payload.error || "Failed to start games 501-1000 official review scan.");
  await refreshStatus();
});

prototypeThirdWindowButton.addEventListener("click", async () => {
  const username = usernameInput.value.trim();
  if (!username) {
    alert("Enter your Chess.com username first.");
    return;
  }

  const response = await fetch("/api/prototype/window", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, first: 500, offset: 1000, order: "oldest" })
  });

  const payload = await response.json();
  if (!response.ok) alert(payload.error || "Failed to start games 1001-1500 official review scan.");
  await refreshStatus();
});

hikaruRestWindowButton.addEventListener("click", async () => {
  usernameInput.value = "hikaru";

  const response = await fetch("/api/prototype/window", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      username: "hikaru",
      first: 370,
      offset: 0,
      order: "oldest",
      afterUrl: HIKARU_REST_ANCHOR_URL
    })
  });

  const payload = await response.json();
  if (!response.ok) alert(payload.error || "Failed to start Hikaru games 131-500 official review scan.");
  await refreshStatus();
});

resumeWindowButton.addEventListener("click", async () => {
  const response = await fetch("/api/prototype/window/resume-current", {
    method: "POST",
    headers: { "Content-Type": "application/json" }
  });

  const payload = await response.json();
  if (!response.ok) alert(payload.error || "Failed to resume or retry the current official review window.");
  await refreshStatus();
});

moveLabelsButton.addEventListener("click", async () => {
  const username = usernameInput.value.trim();
  if (!username) {
    alert("Enter your Chess.com username first.");
    return;
  }

  const response = await fetch("/api/prototype/move-labels", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username })
  });

  const payload = await response.json();
  if (!response.ok) alert(payload.error || "Failed to start move-label scan.");
  await refreshStatus();
});

retryErrorsButton.addEventListener("click", async () => {
  const username = usernameInput.value.trim();
  if (!username) {
    alert("Enter your Chess.com username first.");
    return;
  }

  const response = await fetch("/api/prototype/retry-errors", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username })
  });

  const payload = await response.json();
  if (!response.ok) alert(payload.error || "Failed to retry official review errors.");
  await refreshStatus();
});

retryWindowErrorsButton.addEventListener("click", async () => {
  const username = usernameInput.value.trim();
  if (!username) {
    alert("Enter your Chess.com username first.");
    return;
  }

  const response = await fetch("/api/prototype/window/retry-errors", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, first: 500, offset: 0, order: "oldest" })
  });

  const payload = await response.json();
  if (!response.ok) alert(payload.error || "Failed to retry first-500 official review errors.");
  await refreshStatus();
});

retryNextWindowErrorsButton.addEventListener("click", async () => {
  const username = usernameInput.value.trim();
  if (!username) {
    alert("Enter your Chess.com username first.");
    return;
  }

  const response = await fetch("/api/prototype/window/retry-errors", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, first: 500, offset: 500, order: "oldest" })
  });

  const payload = await response.json();
  if (!response.ok) alert(payload.error || "Failed to retry games 501-1000 official review errors.");
  await refreshStatus();
});

retryThirdWindowErrorsButton.addEventListener("click", async () => {
  const username = usernameInput.value.trim();
  if (!username) {
    alert("Enter your Chess.com username first.");
    return;
  }

  const response = await fetch("/api/prototype/window/retry-errors", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, first: 500, offset: 1000, order: "oldest" })
  });

  const payload = await response.json();
  if (!response.ok) alert(payload.error || "Failed to retry games 1001-1500 official review errors.");
  await refreshStatus();
});

retryHikaruRestWindowErrorsButton.addEventListener("click", async () => {
  usernameInput.value = "hikaru";

  const response = await fetch("/api/prototype/window/retry-errors", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      username: "hikaru",
      first: 370,
      offset: 0,
      order: "oldest",
      afterUrl: HIKARU_REST_ANCHOR_URL
    })
  });

  const payload = await response.json();
  if (!response.ok) alert(payload.error || "Failed to retry Hikaru games 131-500 official review errors.");
  await refreshStatus();
});

resetButton.addEventListener("click", async () => {
  if (!confirm("Reset saved scan state and results?")) return;

  const response = await fetch("/api/reset", { method: "POST" });
  const payload = await response.json();
  if (!response.ok) alert(payload.error || "Could not reset while scanner is running.");
  await refreshStatus();
});

errors.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-dismiss-error]");
  if (!button) return;

  const response = await fetch("/api/errors/dismiss", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      index: Number(button.dataset.index),
      checkedAt: button.dataset.checkedAt,
      reviewUrl: button.dataset.reviewUrl
    })
  });

  const payload = await response.json();
  if (!response.ok) alert(payload.error || "Could not remove error.");
  await refreshStatus();
});

async function refreshStatus() {
  const response = await fetch("/api/status");
  const state = await response.json();
  render(state);
}

function render(state) {
  const total = state.totalGames || 0;
  const checked = state.currentIndex || state.scanned || 0;
  const percent = total > 0 ? Math.min(100, Math.round((checked / total) * 100)) : 0;

  if (state.username && !usernameInput.value) usernameInput.value = state.username;

  statusBadge.textContent = state.status || "idle";
  progressLabel.textContent = getProgressLabel(state, checked, total);
  percentLabel.textContent = `${percent}%`;
  progressFill.style.width = `${percent}%`;
  totalGames.textContent = total;
  scannedGames.textContent = state.scanned || 0;
  foundGames.textContent = state.found || 0;
  failedGames.textContent = state.failed || 0;
  message.textContent = state.message || "Ready.";

  const hasWindow = hasCurrentWindow(state);
  const hasPending = hasPendingWindowGames(state);
  const hasErrors = (state.failed || 0) > 0;
  const canActOnCurrentWindow = hasWindow && (hasPending || hasErrors);

  pauseButton.hidden = !state.isRunning;
  pauseButton.disabled = !state.isRunning;
  startButton.hidden = state.isRunning || canActOnCurrentWindow;
  startButton.disabled = state.isRunning;
  prototypeButton.disabled = state.isRunning;
  prototypeWindowButton.disabled = state.isRunning;
  prototypeNextWindowButton.disabled = state.isRunning;
  prototypeThirdWindowButton.hidden = state.isRunning || canActOnCurrentWindow;
  prototypeThirdWindowButton.disabled = state.isRunning;
  hikaruRestWindowButton.hidden = state.isRunning || canActOnCurrentWindow;
  hikaruRestWindowButton.disabled = state.isRunning;
  resumeWindowButton.hidden = state.isRunning || !canActOnCurrentWindow;
  resumeWindowButton.disabled = state.isRunning || !canActOnCurrentWindow;
  resumeWindowButton.textContent = getResumeWindowLabel(state);
  moveLabelsButton.disabled = state.isRunning || hasPending || hasErrors || !hasWindow || !(state.found > 0);
  retryErrorsButton.disabled = state.isRunning;
  retryWindowErrorsButton.disabled = state.isRunning;
  retryNextWindowErrorsButton.disabled = state.isRunning;
  retryThirdWindowErrorsButton.disabled = state.isRunning;
  retryHikaruRestWindowErrorsButton.disabled = state.isRunning;

  const currentGameUrl = state.currentGame?.url || state.currentGame?.reviewUrl;
  if (currentGameUrl) {
    currentGameLink.hidden = false;
    currentGameLink.href = currentGameUrl;
    currentGameLink.textContent = `${state.currentGame.white} vs ${state.currentGame.black}`;
  } else {
    currentGameLink.hidden = true;
  }

  renderResults(state.results || []);
  renderErrors(state.errors || []);
}

function hasCurrentWindow(state) {
  return state.baseline?.source === "prototype-window" && Array.isArray(state.games) && state.games.length > 0;
}

function getResumeWindowLabel(state) {
  if (state.isRunning && state.status === "paused") return "Pausing...";
  if (!hasCurrentWindow(state)) return "Continue Scan";
  if (hasPendingWindowGames(state)) return "Continue Scan";
  if ((state.failed || 0) > 0) return "Retry Errors";
  return "Continue Scan";
}

function hasPendingWindowGames(state) {
  const games = Array.isArray(state.games) ? state.games : [];
  return games.some((game) => !isFinishedWindowGame(game));
}

function isFinishedWindowGame(game) {
  return (
    game?.status === "checked" ||
    game?.status === "error" ||
    (game?.status === "skipped" && Boolean(game.checkedAt))
  );
}

function getProgressLabel(state, checked, total) {
  if (state.status === "fetching") return total > 0 ? `Fetched ${total} PGNs` : "Fetching PGNs";
  if (state.status === "completed") return total > 0 ? `Scanned ${total}/${total} games` : "Scan complete";
  if (state.status === "idle") return "Ready to fetch PGNs";
  if (state.status === "paused") return total > 0 ? `Paused at game ${Math.min(checked + 1, total)}/${total}` : "Paused";
  if (total > 0) return `Analyzing game ${Math.min(checked + 1, total)}/${total}`;
  return "Analyzing game 0/0";
}

function renderResults(items) {
  if (!items.length) {
    results.className = "list empty";
    results.textContent = "No candidates found yet.";
    return;
  }

  results.className = "list";
  results.innerHTML = items
    .slice()
    .reverse()
    .map((item) => {
      const candidateSummary = (item.candidates || [])
        .slice(0, 3)
        .map((candidate) => {
          const reasons = (candidate.reasons || []).slice(0, 3).join(", ");
          return `M${escapeHtml(candidate.moveNumber)} ${escapeHtml(candidate.san)} (${escapeHtml(candidate.score)})${reasons ? ` - ${escapeHtml(reasons)}` : ""}`;
        })
        .join("<br />");
      const count = item.candidateCount ?? item.brilliantCount;
      const scoreText = Number.isFinite(item.topScore) ? ` Top score ${item.topScore}.` : "";
      const brilliantMoveSummary = !candidateSummary && Array.isArray(item.brilliantMoves)
        ? item.brilliantMoves
            .map((move) => {
              const number = move.moveNumber ? `M${escapeHtml(move.moveNumber)} ` : "";
              return `${number}${escapeHtml(move.san || "unknown")}`;
            })
            .join("<br />")
        : "";

      return `
        <div class="item">
          <a href="${escapeAttr(item.url || item.reviewUrl)}" target="_blank" rel="noreferrer">
            ${escapeHtml(item.white)} vs ${escapeHtml(item.black)}
          </a>
          <p>${count} candidate(s) as ${escapeHtml(item.userColor)}.${scoreText} Checked ${formatDate(item.checkedAt)}.</p>
          ${candidateSummary ? `<p>${candidateSummary}</p>` : ""}
          ${brilliantMoveSummary ? `<p>${brilliantMoveSummary}</p>` : ""}
        </div>
      `;
    })
    .join("");
}

function renderErrors(items) {
  const latest = items.slice().reverse();

  if (!latest.length) {
    errors.className = "list empty";
    errors.textContent = "No errors yet.";
    return;
  }

  errors.className = "list";
  errors.innerHTML = latest
    .map((item) => {
      return `
        <div class="item">
          <div class="itemHeader">
            <a href="${escapeAttr(item.url || item.reviewUrl)}" target="_blank" rel="noreferrer">
              Game ${item.index}
            </a>
            <button
              type="button"
              class="iconButton"
              data-dismiss-error
              data-index="${escapeAttr(item.index)}"
              data-checked-at="${escapeAttr(item.checkedAt)}"
              data-review-url="${escapeAttr(item.reviewUrl)}"
              title="Remove error"
              aria-label="Remove error for game ${escapeAttr(item.index)}"
            >X</button>
          </div>
          <p class="errorText">${escapeHtml(item.message)}</p>
        </div>
      `;
    })
    .join("");
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function escapeAttr(value) {
  return escapeHtml(value);
}

function formatDate(value) {
  if (!value) return "unknown time";
  return new Date(value).toLocaleString();
}

await refreshStatus();
setInterval(refreshStatus, 1500);
