import { Chess } from "chess.js";

const DEFAULT_REVIEW_TIMEOUT_MS = 60_000;
const DEFAULT_REVIEW_POLL_MS = 250;
const DEFAULT_REVIEW_REFRESH_MS = 15_000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function getRuntimeConfig() {
  return {
    reviewTimeoutMs: Number(process.env.BRILLIANT_REVIEW_TIMEOUT_MS) || DEFAULT_REVIEW_TIMEOUT_MS,
    reviewPollMs: Number(process.env.BRILLIANT_REVIEW_POLL_MS) || DEFAULT_REVIEW_POLL_MS,
    reviewRefreshMs: Number(process.env.BRILLIANT_REVIEW_REFRESH_MS) || DEFAULT_REVIEW_REFRESH_MS
  };
}

export async function checkGameReview(context, game, username, options = {}) {
  const { reviewTimeoutMs, reviewPollMs, reviewRefreshMs } = getRuntimeConfig();
  const shouldPause = options.shouldPause || (() => false);
  const page = await context.newPage();
  let keepPageOpen = false;

  try {
    options.onPage?.(page);
    throwIfPauseRequested(shouldPause);

    await page.goto(game.reviewUrl, {
      waitUntil: "domcontentloaded",
      timeout: 45_000
    });

    const deadline = Date.now() + reviewTimeoutMs;
    let lastRefreshAt = Date.now();
    let lastSnapshot = null;

    while (Date.now() < deadline) {
      throwIfPauseRequested(shouldPause);

      const snapshot = await page.evaluate(extractReviewSummary, {
        username,
        userColor: game.userColor
      });

      lastSnapshot = snapshot;

      if (snapshot.loginRequired) {
        keepPageOpen = true;
        throw createAccessPauseError(
          "Chess.com login required. I left the Chrome tab open. Log in there, then resume the scan."
        );
      }

      if (snapshot.blocked) {
        keepPageOpen = true;
        throw createAccessPauseError(
          snapshot.blockedReason ||
            "Chess.com blocked or interrupted the review page. I left the tab open so you can handle it."
        );
      }

      if (snapshot.ready) {
        if (snapshot.brilliantCount > 0 && (!snapshot.brilliantMoves || snapshot.brilliantMoves.length === 0)) {
          snapshot.brilliantMoves = await extractBrilliantMovesByNavigation(page, {
            username,
            userColor: game.userColor,
            expectedCount: snapshot.brilliantCount,
            pgn: game.pgn
          });
        }

        return toReviewResult(snapshot);
      }

      if (Date.now() - lastRefreshAt >= reviewRefreshMs) {
        await refreshReviewPage(page, game.reviewUrl);
        lastRefreshAt = Date.now();
      }

      await sleep(reviewPollMs);
    }

    throw new Error(
      `Timed out waiting for Brilliant row. Last page hint: ${lastSnapshot?.hint || "none"}`
    );
  } finally {
    options.onPage?.(null);
    if (!keepPageOpen) {
      await page.close({ runBeforeUnload: false }).catch(() => {});
    }
  }
}

async function extractBrilliantMovesByNavigation(page, { userColor, expectedCount, pgn }) {
  const moves = [];
  const seen = new Set();
  const pgnMoves = getPgnMoves(pgn);
  const maxSteps = pgnMoves.length > 0 ? pgnMoves.length + 2 : 240;

  await page.getByText("Start Review", { exact: true }).click({ timeout: 5_000 }).catch(() => {});
  await sleep(300);

  for (let step = 0; step < maxSteps; step += 1) {
    const snapshot = await page.evaluate(extractActiveMoveClassification, { userColor });
    const pgnMove = pgnMoves[step] || null;

    if (snapshot?.isBrilliant && (snapshot.san || pgnMove?.san)) {
      const moveNumber = pgnMove?.moveNumber || snapshot.moveNumber || null;
      const san = pgnMove?.san || snapshot.san;
      const color = pgnMove?.color || snapshot.color || userColor;
      const key = `${moveNumber || ""}:${san}:${color || ""}`;
      if (!seen.has(key)) {
        seen.add(key);
        moves.push({
          moveNumber,
          ply: pgnMove?.ply || null,
          san,
          lan: pgnMove?.lan || null,
          color,
          userColor,
          source: pgnMove ? "navigation-pgn" : "navigation",
          labelText: snapshot.labelText,
          contextText: snapshot.contextText
        });

        if (moves.length >= expectedCount) break;
      }
    }

    const advanced = await page.keyboard.press("ArrowRight").then(() => true).catch(() => false);
    if (!advanced) break;
    await sleep(90);
  }

  return moves.filter((move) => !move.color || move.color === userColor);
}

function getPgnMoves(pgn) {
  if (!pgn) return [];

  try {
    const chess = new Chess();
    chess.loadPgn(pgn);

    return chess.history({ verbose: true }).map((move, index) => ({
      moveNumber: Math.floor(index / 2) + 1,
      ply: index + 1,
      san: move.san,
      lan: `${move.from}${move.to}${move.promotion || ""}`,
      color: move.color === "w" ? "white" : "black"
    }));
  } catch {
    return [];
  }
}

function extractActiveMoveClassification({ userColor }) {
  const bodyText = document.body?.innerText || "";
  const active = findActiveMoveElement();
  const activeText = active ? compactText(active.innerText || active.textContent || "") : "";
  const panelText = compactText(findClassificationPanelText(active) || bodyText);
  const labelText = findBrilliantLabelText(active, panelText);
  const move = parseMoveText(activeText) || parseMoveText(panelText);

  return {
    isBrilliant: /brilliant/i.test(labelText),
    labelText,
    contextText: panelText,
    moveNumber: move?.moveNumber || null,
    san: move?.san || null,
    color: inferMoveColor(move, userColor)
  };

  function findActiveMoveElement() {
    const selectors = [
      "[aria-current='true']",
      "[class*='active'][class*='move']",
      "[class*='selected'][class*='move']",
      "[class*='current'][class*='move']",
      ".move.active",
      ".move.selected"
    ];

    for (const selector of selectors) {
      const element = document.querySelector(selector);
      if (element && isVisibleElement(element)) return element;
    }

    const moveNodes = Array.from(document.querySelectorAll("button, span, div, a")).filter((element) => {
      if (!isVisibleElement(element)) return false;
      const className = String(element.className || "").toLowerCase();
      const aria = String(element.getAttribute("aria-label") || "").toLowerCase();
      return /move|node|selected|active|current/.test(`${className} ${aria}`) && parseMoveText(element.innerText || element.textContent || "");
    });

    return moveNodes.find((element) => /active|selected|current/.test(String(element.className || "").toLowerCase())) || null;
  }

  function findClassificationPanelText(active) {
    const selectors = [
      "[class*='classification']",
      "[class*='coach']",
      "[class*='review']",
      "[class*='feedback']",
      "[class*='annotation']",
      "[data-cy*='classification']"
    ];

    const panels = selectors
      .flatMap((selector) => Array.from(document.querySelectorAll(selector)))
      .filter(isVisibleElement)
      .map((element) => compactText(element.innerText || element.textContent || ""))
      .filter((text) => /brilliant|great|best|excellent|good|inaccuracy|mistake|blunder/i.test(text));

    if (panels.length > 0) return panels.join(" | ");

    if (!active) return "";
    let current = active;
    const parts = [];
    for (let depth = 0; depth < 4 && current; depth += 1) {
      parts.push(current.innerText || current.textContent || "");
      current = current.parentElement;
    }

    return compactText(parts.join(" | "));
  }

  function findBrilliantLabelText(active, panelText) {
    const nearby = [];
    if (active) {
      let current = active;
      for (let depth = 0; depth < 5 && current; depth += 1) {
        nearby.push(current.innerText || current.textContent || "");
        nearby.push(current.getAttribute("aria-label") || "");
        nearby.push(current.getAttribute("title") || "");
        nearby.push(String(current.className || ""));
        current = current.parentElement;
      }
    }

    nearby.push(panelText);
    return compactText(nearby.join(" | "));
  }

  function parseMoveText(text) {
    const compact = compactText(text);
    const match = compact.match(/\b(\d{1,3})\s*(\.{1,3})?\s*([O0]-[O0](?:-[O0])?|[KQRBN]?[a-h]?[1-8]?x?[a-h][1-8](?:=[QRBN])?[+#]?)\b/);
    if (match) {
      return {
        moveNumber: Number(match[1]),
        san: normalizeSan(match[3]),
        blackMove: match[2] === "..."
      };
    }

    const sanMatch = compact.match(/\b([O0]-[O0](?:-[O0])?|[KQRBN]?[a-h]?[1-8]?x?[a-h][1-8](?:=[QRBN])?[+#]?)\b/);
    if (!sanMatch) return null;

    return {
      moveNumber: null,
      san: normalizeSan(sanMatch[1]),
      blackMove: null
    };
  }

  function inferMoveColor(move, fallbackColor) {
    if (!move) return fallbackColor || null;
    if (move.blackMove === true) return "black";
    if (move.blackMove === false) return "white";
    return fallbackColor || null;
  }

  function normalizeSan(value) {
    return String(value || "").replaceAll("0", "O").trim();
  }

  function compactText(value) {
    return String(value || "").replace(/\s+/g, " ").trim().slice(0, 500);
  }

  function isVisibleElement(element) {
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;

    const style = window.getComputedStyle(element);
    return (
      style.display !== "none" &&
      style.visibility !== "hidden" &&
      Number(style.opacity) !== 0
    );
  }
}

function toReviewResult(snapshot) {
  return {
    brilliantCount: snapshot.brilliantCount,
    brilliantMoves: snapshot.brilliantMoves || [],
    leftCount: snapshot.leftCount,
    rightCount: snapshot.rightCount,
    method: snapshot.method,
    playerNameSeen: snapshot.playerNameSeen,
    leftAccuracy: snapshot.leftAccuracy,
    rightAccuracy: snapshot.rightAccuracy,
    classificationTotal: snapshot.classificationTotal,
    reviewAborted: snapshot.reviewAborted
  };
}

function throwIfPauseRequested(shouldPause) {
  if (!shouldPause()) return;
  const error = new Error("Scan paused.");
  error.pauseRequested = true;
  throw error;
}

async function refreshReviewPage(page, reviewUrl) {
  await page
    .reload({
      waitUntil: "domcontentloaded",
      timeout: 15_000
    })
    .catch(async () => {
      await page
        .goto(reviewUrl, {
          waitUntil: "domcontentloaded",
          timeout: 15_000
        })
        .catch(() => {});
    });
}

function createAccessPauseError(message) {
  const error = new Error(message);
  error.accessPause = true;
  return error;
}

function extractReviewSummary({ username, userColor }) {
  const bodyText = document.body?.innerText || "";
  const lowerText = bodyText.toLowerCase();

  if (
    /verify you are human|captcha|access denied|too many requests|rate limit/.test(lowerText)
  ) {
    return {
      ready: false,
      blocked: true,
      blockedReason: "Chess.com showed a block, CAPTCHA, or rate-limit page."
    };
  }

  if (
    /log in|login|sign in/.test(lowerText) &&
    !/game review/i.test(bodyText)
  ) {
    return { ready: false, loginRequired: true };
  }

  const items = getVisibleTextItems();
  const lines = bodyText
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

    const accuracyResult = getReadyAccuracy(items, lines);
    if (!accuracyResult.ready) return accuracyResult;
    const brilliantMoves = extractBrilliantMoves(username, userColor);

    const coordinateResult = extractByCoordinates(username, userColor, items, accuracyResult);
  if (coordinateResult.ready) return { ...coordinateResult, brilliantMoves };

  const textResult = extractByTextOrder(username, userColor, lines, accuracyResult);
  if (textResult.ready) return { ...textResult, brilliantMoves };

  return {
    ready: false,
    hint:
      coordinateResult.hint ||
      textResult.hint ||
      bodyText.split("\n").map((line) => line.trim()).filter(Boolean).slice(0, 8).join(" | ")
  };

  function getReadyAccuracy(items, lines) {
    const coordinateResult = extractAccuracyByCoordinates(items);
    if (coordinateResult.ready) return coordinateResult;

    const textResult = extractAccuracyByTextOrder(lines);
    if (textResult.ready) return textResult;

    return {
      ready: false,
      hint: coordinateResult.hint || textResult.hint || "Waiting for Chess.com accuracy numbers."
    };
  }

  function extractAccuracyByCoordinates(items) {
    const label = items.find((item) => normalizeText(item.text) === "accuracy");
    if (!label) {
      return {
        ready: false,
        hint: "Waiting for Chess.com accuracy row."
      };
    }

    const rowCenter = label.y + label.height / 2;
    const rowTolerance = getRowTolerance(label);
    const values = items
      .filter((item) => isAccuracyValue(item.text))
      .filter((item) => Math.abs(item.y + item.height / 2 - rowCenter) <= rowTolerance)
      .filter((item) => item.x > label.x + 30)
      .sort((a, b) => a.x - b.x)
      .slice(0, 2)
      .map((item) => parseAccuracy(item.text));

    if (values.length < 2) {
      return {
        ready: false,
        hint: "Waiting for Chess.com accuracy numbers."
      };
    }

    return {
      ready: true,
      leftAccuracy: values[0],
      rightAccuracy: values[1],
      accuracyMethod: "coordinate"
    };
  }

  function extractAccuracyByTextOrder(lines) {
    const accuracyIndex = lines.findIndex((line) => normalizeText(line) === "accuracy");
    if (accuracyIndex === -1) {
      return {
        ready: false,
        hint: "Waiting for Chess.com accuracy row."
      };
    }

    const values = [];
    for (const line of lines.slice(accuracyIndex + 1, accuracyIndex + 12)) {
      if (isMoveClassificationLabel(line)) break;
      if (isAccuracyValue(line)) values.push(parseAccuracy(line));
      if (values.length === 2) break;
    }

    if (values.length < 2) {
      return {
        ready: false,
        hint: "Waiting for Chess.com accuracy numbers."
      };
    }

    return {
      ready: true,
      leftAccuracy: values[0],
      rightAccuracy: values[1],
      accuracyMethod: "text"
    };
  }

  function extractByCoordinates(username, userColor, items, accuracyResult) {
    const label = items.find((item) => item.text.toLowerCase() === "brilliant");
    if (!label) return { ready: false };

    const rowCenter = label.y + label.height / 2;
    const rowTolerance = getRowTolerance(label);
    const rowNumbers = items
      .filter((item) => /^\d+$/.test(item.text))
      .filter((item) => Math.abs(item.y + item.height / 2 - rowCenter) <= rowTolerance)
      .filter((item) => item.x > label.x + 30)
      .sort((a, b) => a.x - b.x)
      .slice(0, 2)
      .map((item) => Number(item.text));

    if (rowNumbers.length < 2) return { ready: false };

    const classificationSummary = summarizeCoordinateClassifications(items);
    if (classificationSummary.rowsSeen > 0 && classificationSummary.total === 0) {
      if (!isLikelyAbortedReview(accuracyResult, classificationSummary)) {
        return {
          ready: false,
          hint: "Chess.com move classifications are visible but still all zero."
        };
      }
    }

    const leftCount = rowNumbers[0];
    const rightCount = rowNumbers[1];
    const brilliantCount = userColor === "black" ? rightCount : leftCount;
    const lowerUsername = username.toLowerCase();
    const playerNameSeen = items.some((item) => item.text.toLowerCase() === lowerUsername);

    return {
      ready: true,
      brilliantCount,
      leftCount,
      rightCount,
      method: "coordinate",
      playerNameSeen,
      leftAccuracy: accuracyResult.leftAccuracy,
      rightAccuracy: accuracyResult.rightAccuracy,
      classificationTotal: classificationSummary.total,
      reviewAborted: isLikelyAbortedReview(accuracyResult, classificationSummary)
    };
  }

  function extractByTextOrder(username, userColor, lines, accuracyResult) {
    const brilliantIndex = lines.findIndex((line) => line.toLowerCase() === "brilliant");
    if (brilliantIndex === -1) return { ready: false };

    const nextNumbers = [];
    for (const line of lines.slice(brilliantIndex + 1, brilliantIndex + 10)) {
      if (/^\d+$/.test(line)) nextNumbers.push(Number(line));
      if (nextNumbers.length === 2) break;
    }

    if (nextNumbers.length < 2) return { ready: false };

    const classificationSummary = summarizeTextClassifications(lines);
    if (classificationSummary.rowsSeen > 0 && classificationSummary.total === 0) {
      if (!isLikelyAbortedReview(accuracyResult, classificationSummary)) {
        return {
          ready: false,
          hint: "Chess.com move classifications are visible but still all zero."
        };
      }
    }

    const leftCount = nextNumbers[0];
    const rightCount = nextNumbers[1];
    const brilliantCount = userColor === "black" ? rightCount : leftCount;

    return {
      ready: true,
      brilliantCount,
      leftCount,
      rightCount,
      method: "text",
      playerNameSeen: lines.some((line) => line.toLowerCase() === username.toLowerCase()),
      leftAccuracy: accuracyResult.leftAccuracy,
      rightAccuracy: accuracyResult.rightAccuracy,
      classificationTotal: classificationSummary.total,
      reviewAborted: isLikelyAbortedReview(accuracyResult, classificationSummary)
    };
  }

  function summarizeCoordinateClassifications(items) {
    let rowsSeen = 0;
    let total = 0;

    for (const item of items) {
      if (!isMoveClassificationLabel(item.text)) continue;

      const rowCenter = item.y + item.height / 2;
      const rowTolerance = getRowTolerance(item);
      const rowNumbers = items
        .filter((candidate) => /^\d+$/.test(candidate.text))
        .filter((candidate) => Math.abs(candidate.y + candidate.height / 2 - rowCenter) <= rowTolerance)
        .filter((candidate) => candidate.x > item.x + 30)
        .sort((a, b) => a.x - b.x)
        .slice(0, 2)
        .map((candidate) => Number(candidate.text));

      if (rowNumbers.length < 2) continue;

      rowsSeen += 1;
      total += rowNumbers[0] + rowNumbers[1];
    }

    return { rowsSeen, total };
  }

  function summarizeTextClassifications(lines) {
    let rowsSeen = 0;
    let total = 0;

    for (let index = 0; index < lines.length; index += 1) {
      if (!isMoveClassificationLabel(lines[index])) continue;

      const rowNumbers = [];
      for (const line of lines.slice(index + 1, index + 10)) {
        if (isMoveClassificationLabel(line)) break;
        if (/^\d+$/.test(line)) rowNumbers.push(Number(line));
        if (rowNumbers.length === 2) break;
      }

      if (rowNumbers.length < 2) continue;

      rowsSeen += 1;
      total += rowNumbers[0] + rowNumbers[1];
    }

    return { rowsSeen, total };
  }

  function isMoveClassificationLabel(text) {
    return [
      "brilliant",
      "great",
      "great move",
      "best",
      "excellent",
      "good",
      "book",
      "inaccuracy",
      "mistake",
      "miss",
      "blunder"
    ].includes(text.toLowerCase().replace(/\s+/g, " ").trim());
  }

  function isAccuracyValue(text) {
    const value = parseAccuracy(text);
    return Number.isFinite(value) && value >= 0 && value <= 100;
  }

  function parseAccuracy(text) {
    const normalized = String(text).trim().replace(/\s*%$/, "");
    if (!/^\d{1,3}(?:\.\d{1,2})?$/.test(normalized)) return NaN;
    return Number(normalized);
  }

  function isLikelyAbortedReview(accuracyResult, classificationSummary) {
    return (
      classificationSummary.rowsSeen > 0 &&
      classificationSummary.total === 0 &&
      accuracyResult.leftAccuracy === 100 &&
      accuracyResult.rightAccuracy === 100
    );
  }

  function normalizeText(text) {
    return String(text).toLowerCase().replace(/\s+/g, " ").trim();
  }

  function getRowTolerance(item) {
    return Math.max(8, Math.min(18, item.height * 1.1));
  }

  function getVisibleTextItems() {
    const items = [];
    if (!document.body) return items;

    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);

    while (walker.nextNode()) {
      const node = walker.currentNode;
      const text = node.nodeValue.replace(/\s+/g, " ").trim();
      if (!text || text.length > 80) continue;

      const parent = node.parentElement;
      if (!parent) continue;

      const style = window.getComputedStyle(parent);
      if (
        style.display === "none" ||
        style.visibility === "hidden" ||
        Number(style.opacity) === 0
      ) {
        continue;
      }

      const range = document.createRange();
      range.selectNodeContents(node);
      const rect = Array.from(range.getClientRects()).find((candidate) => {
        return candidate.width > 0 && candidate.height > 0;
      });
      range.detach();

      if (!rect) continue;

      items.push({
        text,
        x: rect.left,
        y: rect.top,
        width: rect.width,
        height: rect.height
      });
    }

    return items;
  }

  function extractBrilliantMoves(username, userColor) {
    const candidates = [];
    const seen = new Set();
    const nodes = Array.from(document.querySelectorAll("button, div, span, a, li"));

    for (const node of nodes) {
      if (!isVisibleElement(node)) continue;

      const text = normalizeMoveText(node.innerText || node.textContent || "");
      const aria = node.getAttribute("aria-label") || "";
      const title = node.getAttribute("title") || "";
      const className = String(node.className || "");
      const descriptor = `${aria} ${title} ${className}`.toLowerCase();

      if (!/brilliant|!!|move-classification-brilliant|classification-brilliant/.test(descriptor)) {
        continue;
      }

      const moveText = findMoveTextNear(node) || text;
      const move = parseMoveText(moveText);
      const contextText = collectNearbyText(node);
      const key = `${move.moveNumber || ""}:${move.san || moveText}:${contextText.slice(0, 80)}`;

      if (!move.san || seen.has(key)) continue;
      seen.add(key);

      candidates.push({
        moveNumber: move.moveNumber,
        san: move.san,
        color: inferMoveColor(move, userColor),
        userColor,
        source: "dom",
        labelText: compactText(`${aria} ${title}`),
        contextText: compactText(contextText)
      });
    }

    return candidates.filter((move) => !move.color || move.color === userColor);
  }

  function findMoveTextNear(node) {
    const own = normalizeMoveText(node.innerText || node.textContent || "");
    if (parseMoveText(own).san) return own;

    let current = node;
    for (let depth = 0; depth < 4 && current; depth += 1) {
      const currentText = normalizeMoveText(current.innerText || current.textContent || "");
      if (parseMoveText(currentText).san) return currentText;

      const siblings = [
        current.previousElementSibling,
        current.nextElementSibling,
        current.parentElement?.previousElementSibling,
        current.parentElement?.nextElementSibling
      ].filter(Boolean);

      for (const sibling of siblings) {
        const text = normalizeMoveText(sibling.innerText || sibling.textContent || "");
        if (parseMoveText(text).san) return text;
      }

      current = current.parentElement;
    }

    return "";
  }

  function parseMoveText(text) {
    const compact = compactText(text);
    const moveNumberMatch = compact.match(/\b(\d{1,3})\s*(?:\.{1,3})\s*([O0]-[O0](?:-[O0])?|[KQRBN]?[a-h]?[1-8]?x?[a-h][1-8](?:=[QRBN])?[+#]?)/);
    if (moveNumberMatch) {
      return {
        moveNumber: Number(moveNumberMatch[1]),
        san: normalizeSan(moveNumberMatch[2]),
        blackMove: /\.{3}/.test(moveNumberMatch[0])
      };
    }

    const sanMatch = compact.match(/\b([O0]-[O0](?:-[O0])?|[KQRBN]?[a-h]?[1-8]?x?[a-h][1-8](?:=[QRBN])?[+#]?)\b/);
    return {
      moveNumber: null,
      san: sanMatch ? normalizeSan(sanMatch[1]) : null,
      blackMove: null
    };
  }

  function inferMoveColor(move, fallbackColor) {
    if (move.blackMove === true) return "black";
    if (move.blackMove === false) return "white";
    return fallbackColor || null;
  }

  function normalizeSan(value) {
    return String(value || "").replaceAll("0", "O").trim();
  }

  function normalizeMoveText(value) {
    return String(value || "")
      .replace(/\u2026/g, "...")
      .replace(/\s+/g, " ")
      .trim();
  }

  function collectNearbyText(node) {
    const parts = [];
    let current = node;

    for (let depth = 0; depth < 3 && current; depth += 1) {
      parts.push(current.innerText || current.textContent || "");
      current = current.parentElement;
    }

    return parts.map(compactText).filter(Boolean).join(" | ");
  }

  function compactText(value) {
    return String(value || "").replace(/\s+/g, " ").trim().slice(0, 300);
  }

  function isVisibleElement(element) {
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;

    const style = window.getComputedStyle(element);
    return (
      style.display !== "none" &&
      style.visibility !== "hidden" &&
      Number(style.opacity) !== 0
    );
  }
}
