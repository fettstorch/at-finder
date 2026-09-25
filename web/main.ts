import "./styles.css";
import { debounce, synchronize } from "@fettstorch/jule";
import { tokenizeEnglishKeywords, tokenizeTerms } from "../src/english-stopwords.js";
import type { NameAnalysis } from "../src/name-match.js";
import { CandidateSelection } from "./candidate-selection.js";
import { nextBatchDelay } from "./pacing.js";

export type Candidate = {
  did: string;
  handle: string;
  displayName?: string;
  description?: string;
  avatar?: string;
  profileUrl: string;
  nameScore: number;
  contextSupportScore?: number;
  contextContradictionScore?: number;
  bioMatchScores?: Record<string, {
    supportScore?: number;
    contradictionScore?: number;
  }>;
  matchScore: number;
};

const form = document.querySelector<HTMLFormElement>("#search-form")!;
const nameInput = document.querySelector<HTMLInputElement>("#person-name")!;
const contextInput = document.querySelector<HTMLInputElement>("#person-context")!;
const nameInterpretation = document.querySelector<HTMLElement>("#name-interpretation")!;
const contextInterpretation = document.querySelector<HTMLElement>("#context-interpretation")!;
const resultsSection = document.querySelector<HTMLElement>("#results-section")!;
const results = document.querySelector<HTMLElement>("#results")!;
const resultCount = document.querySelector<HTMLElement>("#result-count")!;
const searchStatus = document.querySelector<HTMLElement>("#search-status")!;
const searchSpinner = document.querySelector<HTMLElement>("#search-spinner")!;
const searchToggle = document.querySelector<HTMLButtonElement>("#search-toggle")!;
const scoreDetailsToggle = document.querySelector<HTMLButtonElement>("#score-details-toggle")!;
const debounceLock = {};
const searchLock = {};
const contextDebounceLock = {};
const contextLock = {};
const nameDebounceLock = {};
const nameLock = {};
const INPUT_DEBOUNCE_MS = 300;
const CANDIDATE_COUNT_ANIMATION_MS = 1_800;
const SEARCH_EXAMPLES = [
  { name: "zoe", context: "streams on stream.place" },
  { name: "alex", context: "developer does something with void" },
  { name: "florian", context: "the guy that made blento" },
  { name: "eli", context: "the guy from stream.place" },
  { name: "brooke", context: "created a platform for blogging" },
  { name: "sam", context: "has a cool dev blog" },
] as const;
let searchRevision = 0;
let contextRevision = 0;
let nameRevision = 0;
let activeRequest: AbortController | undefined;
let activeContextRequest: AbortController | undefined;
let activeNameRequest: AbortController | undefined;
let nextContinuation: string | undefined;
let pagingActive = false;
let nextBatchTimer: ReturnType<typeof setTimeout> | undefined;
let totalTested = 0;
let displayedCandidateCount = 0;
let candidateCountAnimation: number | undefined;
let candidateReelAnimations: Animation[] = [];
let nameHighlightTerms: string[] = [];
let contextHighlightTerms: string[] = [];
let bioMatchWeights: { keyword: number; jev: number } | undefined;
let showScoreDetails = true;
type ContextInterpretation = { keywordProbability: number; freeTextProbability: number };
type ContextAnalysis = {
  contextInterpretation: ContextInterpretation;
  bioMatchWeights: { keyword: number; jev: number };
};
type NameAnalysisResponse = NameAnalysis;
let currentContextAnalysis: { context: string; promise: Promise<ContextAnalysis | undefined> } | undefined;
let currentNameAnalysis: { name: string; promise: Promise<NameAnalysis | undefined> } | undefined;
let resolvePendingContext: ((value: ContextAnalysis | undefined) => void) | undefined;
let resolvePendingName: ((value: NameAnalysis | undefined) => void) | undefined;
const candidateSelection = new CandidateSelection<Candidate>();
const debugUi = import.meta.env?.DEV
  ? import("./debug.js").then(({ createDebugUi }) => createDebugUi(
      document.querySelector<HTMLElement>(".search-panel")!,
    ))
  : undefined;

const placeholderExample = SEARCH_EXAMPLES[Math.floor(Math.random() * SEARCH_EXAMPLES.length)];
nameInput.placeholder = `e.g. ${placeholderExample.name}`;
contextInput.placeholder = `e.g. ${placeholderExample.context}`;

const escapeHtml = (value: unknown) => String(value).replace(/[&<>"']/g, (character) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
})[character]!);

function highlightText(value: string) {
  const highlightTerms = [...new Set([...nameHighlightTerms, ...contextHighlightTerms])]
    .sort((left, right) => right.length - left.length);
  if (!highlightTerms.length) return escapeHtml(value);
  const pattern = new RegExp(
    `(${highlightTerms.map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`,
    "giu",
  );
  return value.split(pattern).map((part) => {
    const normalized = part.toLocaleLowerCase();
    if (nameHighlightTerms.includes(normalized)) return `<mark>${escapeHtml(part)}</mark>`;
    if (contextHighlightTerms.includes(normalized)) {
      return `<mark class="context-highlight" style="--highlight-opacity:${bioMatchWeights?.keyword ?? 1}">${escapeHtml(part)}</mark>`;
    }
    return escapeHtml(part);
  }).join("");
}

function meterColor(score: number) {
  const hue = Math.max(0, Math.min(125, score * 12.5));
  return `hsl(${hue} 68% 64%)`;
}

function updateSearchToggle() {
  const label = pagingActive ? "Pause search" : "Resume search";
  searchSpinner.classList.toggle("is-paused", !pagingActive);
  searchToggle.textContent = pagingActive ? "Pause" : "Resume";
  searchToggle.setAttribute("aria-label", label);
  searchToggle.title = label;
}

function updateScoreDetailsToggle() {
  const label = showScoreDetails ? "Hide score details" : "Show score details";
  scoreDetailsToggle.setAttribute("aria-pressed", String(showScoreDetails));
  scoreDetailsToggle.setAttribute("aria-label", label);
  scoreDetailsToggle.title = label;
}

function updateResultCount(bestMatches: number, lockedMatches: number, candidateCount: number) {
  if (candidateCountAnimation !== undefined) cancelAnimationFrame(candidateCountAnimation);
  candidateReelAnimations.forEach((animation) => animation.cancel());
  candidateReelAnimations = [];

  const prefix = `${bestMatches} best matches${lockedMatches ? ` + ${lockedMatches} locked` : ""} across `;
  const suffix = " candidates";
  const visual = document.createElement("span");
  visual.setAttribute("aria-hidden", "true");
  visual.append(prefix);
  const counter = document.createElement("span");
  counter.className = "candidate-count";
  visual.append(counter, suffix);
  const announcement = document.createElement("span");
  announcement.className = "sr-only";
  announcement.textContent = `${prefix}${candidateCount}${suffix}`;
  resultCount.replaceChildren(visual, announcement);

  const startCount = displayedCandidateCount;
  const shouldAnimate = candidateCount > startCount
    && !matchMedia("(prefers-reduced-motion: reduce)").matches;
  const reelStartCount = shouldAnimate ? startCount : candidateCount;
  if (shouldAnimate) counter.classList.add("is-rolling");
  const digitCount = Math.max(String(reelStartCount).length, String(candidateCount).length);
  for (let digitIndex = digitCount - 1; digitIndex >= 0; digitIndex -= 1) {
    const place = 10 ** digitIndex;
    const startTurns = Math.floor(reelStartCount / place);
    const endTurns = Math.floor(candidateCount / place);
    const turns = endTurns - startTurns;
    const reel = document.createElement("span");
    reel.className = "candidate-digit";
    const track = document.createElement("span");
    track.className = "candidate-digit-track";
    for (let turn = turns + 1; turn >= -1; turn -= 1) {
      const absoluteTurn = startTurns + turn;
      const digit = ((absoluteTurn % 10) + 10) % 10;
      const valueAtTurn = absoluteTurn * place;
      const cell = document.createElement("span");
      cell.textContent = valueAtTurn < place && digitIndex > 0 ? "\u00a0" : String(digit);
      track.append(cell);
    }
    reel.append(track);
    counter.append(reel);
    if (shouldAnimate && turns) {
      candidateReelAnimations.push(track.animate(
        [
          { transform: `translateY(-${turns + 1}em)` },
          { transform: "translateY(-1em)" },
        ],
        { duration: CANDIDATE_COUNT_ANIMATION_MS, easing: "linear", fill: "forwards" },
      ));
    } else {
      track.style.transform = "translateY(-1em)";
    }
  }

  if (!shouldAnimate) {
    displayedCandidateCount = candidateCount;
    return;
  }

  const startedAt = performance.now();
  const animate = (now: number) => {
    const progress = Math.min((now - startedAt) / CANDIDATE_COUNT_ANIMATION_MS, 1);
    displayedCandidateCount = Math.floor(startCount + (candidateCount - startCount) * progress);
    if (progress < 1) {
      candidateCountAnimation = requestAnimationFrame(animate);
    } else {
      candidateCountAnimation = undefined;
      candidateReelAnimations.forEach((animation) => {
        animation.commitStyles();
        animation.cancel();
      });
      candidateReelAnimations = [];
      displayedCandidateCount = candidateCount;
      counter.classList.remove("is-rolling");
    }
  };
  candidateCountAnimation = requestAnimationFrame(animate);
}

function showContextInterpretation(
  interpretation?: ContextInterpretation,
) {
  if (!contextInput.value.trim()) {
    contextInterpretation.hidden = true;
    contextInterpretation.textContent = "";
    return;
  }
  contextInterpretation.hidden = false;
  contextInterpretation.textContent = interpretation
    ? interpretation.keywordProbability >= interpretation.freeTextProbability
      ? "Keywords"
      : "Description"
    : "Reading context…";
}

function showNameInterpretation(analysis?: NameAnalysis, failed = false) {
  const name = nameInput.value.trim();
  if (!name) {
    nameInterpretation.hidden = true;
    nameInterpretation.textContent = "";
    return;
  }
  nameInterpretation.hidden = false;
  nameInterpretation.textContent = failed
    ? "Name enrichment unavailable"
    : analysis
      ? analysis.abbreviations.length
        ? `Adding: ${analysis.abbreviations.join(", ")}`
        : "No name enrichment needed"
      : "Reading name…";
}

const analyzeName = synchronize(async (
  revision: number,
  name: string,
): Promise<NameAnalysis | undefined> => {
  if (revision !== nameRevision) return undefined;
  activeNameRequest = new AbortController();
  try {
    const response = await fetch("/api/name", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name }),
      signal: activeNameRequest.signal,
    });
    const body = await response.json() as NameAnalysisResponse & { error?: string };
    if (!response.ok) throw new Error(body.error || "Name analysis failed");
    if (revision !== nameRevision) return undefined;
    showNameInterpretation(body);
    return body;
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") return undefined;
    if (revision === nameRevision) showNameInterpretation(undefined, true);
    return undefined;
  } finally {
    if (revision === nameRevision) activeNameRequest = undefined;
  }
}, nameLock);

function scheduleNameAnalysis() {
  const revision = ++nameRevision;
  activeNameRequest?.abort();
  resolvePendingName?.(undefined);
  resolvePendingName = undefined;
  const name = nameInput.value.trim();
  if (!name) {
    showNameInterpretation();
    currentNameAnalysis = { name, promise: Promise.resolve(undefined) };
    return;
  }
  showNameInterpretation();
  let resolveAnalysis!: (value: NameAnalysis | undefined) => void;
  const promise = new Promise<NameAnalysis | undefined>((resolve) => {
    resolveAnalysis = resolve;
  });
  resolvePendingName = resolveAnalysis;
  currentNameAnalysis = { name, promise };
  debounce(
    () => void (async () => {
      try {
        resolveAnalysis(await analyzeName(revision, name));
      } catch {
        resolveAnalysis(undefined);
      } finally {
        if (revision === nameRevision) resolvePendingName = undefined;
      }
    })(),
    INPUT_DEBOUNCE_MS,
    nameDebounceLock,
  );
}

function nameAnalysisFor(name: string) {
  if (currentNameAnalysis?.name === name) return currentNameAnalysis.promise;
  scheduleNameAnalysis();
  return currentNameAnalysis?.promise ?? Promise.resolve(undefined);
}

const analyzeContext = synchronize(async (
  revision: number,
  context: string,
): Promise<ContextAnalysis | undefined> => {
  if (revision !== contextRevision) return undefined;
  activeContextRequest = new AbortController();
  try {
    const response = await fetch("/api/context", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ context }),
      signal: activeContextRequest.signal,
    });
    const body = await response.json() as ContextAnalysis & { error?: string };
    if (!response.ok) throw new Error(body.error || "Context analysis failed");
    if (revision !== contextRevision) return undefined;
    showContextInterpretation(body.contextInterpretation);
    bioMatchWeights = body.bioMatchWeights;
    return body;
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") return undefined;
    if (revision === contextRevision) {
      contextInterpretation.hidden = false;
      contextInterpretation.textContent = "Context analysis failed";
    }
    // The search endpoint can classify context itself if the early request fails.
    return undefined;
  } finally {
    if (revision === contextRevision) activeContextRequest = undefined;
  }
}, contextLock);

function scheduleContextAnalysis() {
  const revision = ++contextRevision;
  activeContextRequest?.abort();
  resolvePendingContext?.(undefined);
  resolvePendingContext = undefined;
  const context = contextInput.value.trim();
  bioMatchWeights = undefined;
  if (!context) {
    showContextInterpretation();
    currentContextAnalysis = { context, promise: Promise.resolve(undefined) };
    return;
  }
  showContextInterpretation();
  let resolveAnalysis!: (value: ContextAnalysis | undefined) => void;
  const promise = new Promise<ContextAnalysis | undefined>((resolve) => {
    resolveAnalysis = resolve;
  });
  resolvePendingContext = resolveAnalysis;
  currentContextAnalysis = { context, promise };
  debounce(
    () => void (async () => {
      try {
        resolveAnalysis(await analyzeContext(revision, context));
      } catch {
        resolveAnalysis(undefined);
      } finally {
        if (revision === contextRevision) resolvePendingContext = undefined;
      }
    })(),
    INPUT_DEBOUNCE_MS,
    contextDebounceLock,
  );
}

function contextAnalysisFor(context: string) {
  if (currentContextAnalysis?.context === context) return currentContextAnalysis.promise;
  scheduleContextAnalysis();
  return currentContextAnalysis?.promise ?? Promise.resolve(undefined);
}

function signalBar(label: string, score: number, color: string, factor?: number) {
  const safeScore = Math.max(0, Math.min(10, score));
  return `<div class="signal" role="listitem">
    <span class="signal-label">${label}${factor === undefined ? "" : ` <small class="weight-badge">×${factor.toFixed(2)}</small>`}</span>
    <span class="signal-track" role="meter" aria-label="${label}" aria-valuemin="0" aria-valuemax="10" aria-valuenow="${safeScore.toFixed(1)}" aria-valuetext="${safeScore.toFixed(1)} out of 10"><span style="width:${safeScore * 10}%;background:${color}"></span></span>
    <strong>${safeScore.toFixed(1)}</strong>
  </div>`;
}

function strategyLabel(name: string) {
  return name === "jev" ? "Jev" : name.charAt(0).toUpperCase() + name.slice(1);
}

function bioMatchSignalBars(candidate: Candidate) {
  if (!candidate.bioMatchScores) return "";
  return Object.entries(candidate.bioMatchScores).map(([name, scores]) => {
    const label = strategyLabel(name);
    const factor = name === "keyword" && bioMatchWeights && bioMatchWeights.keyword < bioMatchWeights.jev
      ? bioMatchWeights.keyword
      : undefined;
    return `${scores.supportScore === undefined ? "" : signalBar(`${label} match`, scores.supportScore, "#63bd8a", factor)}
      ${scores.contradictionScore === undefined ? "" : signalBar(`${label} mismatch`, scores.contradictionScore, "#dc7474")}`;
  }).join("");
}

function renderCandidate(candidate: Candidate, locked: boolean) {
  const score = Math.max(0, Math.min(10, candidate.matchScore));
  const candidateName = candidate.displayName || candidate.handle;
  const avatar = candidate.avatar
    ? `<img class="avatar" src="${escapeHtml(candidate.avatar)}" alt="" loading="lazy">`
    : `<div class="avatar avatar-fallback" aria-hidden="true">@</div>`;

  return `
    <article class="profile-card${locked ? " is-locked" : ""}" data-candidate-did="${escapeHtml(candidate.did)}">
      <div class="confidence-track" role="meter" aria-label="${escapeHtml(candidateName)} match score" aria-valuemin="0" aria-valuemax="10" aria-valuenow="${score.toFixed(1)}" aria-valuetext="${score.toFixed(1)} out of 10">
        <div class="confidence-fill" style="width:${score * 10}%;background:${meterColor(score)}"></div>
      </div>
      <div class="card-body">
        <div class="profile-main">
          ${avatar}
          <div class="profile-copy">
            <div class="profile-title">
              <div>
                <h3>${highlightText(candidateName)}</h3>
                <a href="${escapeHtml(candidate.profileUrl)}" target="_blank" rel="noreferrer" aria-label="@${escapeHtml(candidate.handle)} on Bluesky (opens in a new tab)">@${highlightText(candidate.handle)}</a>
              </div>
              <div class="profile-controls">
                <div class="score" style="--score-color:${meterColor(score)}">
                  <strong>${score.toFixed(1)}</strong><span>/10</span>
                </div>
              </div>
            </div>
            ${showScoreDetails ? `<div class="metrics-details">
              <div class="signal-bars" role="list" aria-label="Score breakdown">
                ${signalBar("Name", candidate.nameScore, "#6488e8")}
                ${candidate.bioMatchScores
                  ? bioMatchSignalBars(candidate)
                  : `${candidate.contextSupportScore === undefined ? "" : signalBar("Context match", candidate.contextSupportScore, "#63bd8a")}
                    ${candidate.contextContradictionScore === undefined ? "" : signalBar("Context contradiction", candidate.contextContradictionScore, "#dc7474")}`}
              </div>
            </div>` : ""}
            <p class="bio">${highlightText(candidate.description || "No profile bio")}</p>
          </div>
        </div>
      </div>
    </article>`;
}

function renderCandidateResults() {
  const focusedElement = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
  const focusedDid = focusedElement?.closest<HTMLElement>("[data-candidate-did]")?.dataset.candidateDid;
  const focusedKind = focusedElement?.matches("a")
    ? "profile"
    : undefined;
  const { locked, rotating } = candidateSelection.view(10);
  scoreDetailsToggle.hidden = !locked.length && !rotating.length;
  updateResultCount(rotating.length, locked.length, totalTested);

  if (!locked.length && !rotating.length) {
    results.innerHTML = `<div class="empty"><h3>No candidates found</h3><p>Try adding an employer, role, location, or topic.</p></div>`;
    return;
  }

  const lockedSection = locked.length ? `
    <section class="candidate-group locked-group" aria-labelledby="locked-candidates-heading">
      <h3 id="locked-candidates-heading" class="sr-only">Locked candidates</h3>
      <div class="locked-group-marker" aria-hidden="true">🔒</div>
      <div class="candidate-list">${locked.map((candidate) => renderCandidate(candidate, true)).join("")}</div>
    </section>` : "";
  const rotatingSection = rotating.length ? `
    <section class="candidate-group" aria-labelledby="rotating-candidates-heading">
      <h3 id="rotating-candidates-heading" class="sr-only">Unlocked candidates</h3>
      ${locked.length ? `<div class="candidate-separator" aria-hidden="true"></div>` : ""}
      <div class="candidate-list">${rotating.map((candidate) => renderCandidate(candidate, false)).join("")}</div>
    </section>` : "";
  results.innerHTML = lockedSection + rotatingSection;
  if (focusedDid && focusedKind) focusCandidateControl(focusedDid);
}

function focusCandidateControl(did: string) {
  const card = [...results.querySelectorAll<HTMLElement>("[data-candidate-did]")]
    .find((candidateCard) => candidateCard.dataset.candidateDid === did);
  const control = card?.querySelector<HTMLAnchorElement>("a");
  if (control) control.focus();
  else document.querySelector<HTMLElement>("#matches-heading")?.focus();
}

function toggleCandidateLock(did: string) {
  candidateSelection.toggle(did);
  renderCandidateResults();
}

const search = synchronize(async (
  revision: number,
  name: string,
  context: string,
  continuation?: string,
) => {
  if (revision !== searchRevision) return;

  if (!continuation) searchStatus.textContent = "Search started.";
  activeRequest = new AbortController();
  resultsSection.hidden = false;
  if (!candidateSelection.size) {
    results.innerHTML = `<div class="loading"><span class="running-spinner" aria-hidden="true">🌀</span><p>Searching AT Protocol and comparing profiles…</p></div>`;
  }
  if (!totalTested) resultCount.textContent = "";

  try {
    const [nameAnalysis, contextAnalysis] = await Promise.all([
      nameAnalysisFor(name),
      contextAnalysisFor(context),
    ]);
    if (revision !== searchRevision) return;

    const response = await fetch("/api/find", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name,
        context,
        continuation,
        contextInterpretation: contextAnalysis?.contextInterpretation,
        nameAnalysis,
      }),
      signal: activeRequest.signal,
    });
    const body = await response.json() as {
      candidates?: Candidate[];
      debugCandidates?: Candidate[];
      testedCount?: number;
      continuation?: string;
      contextInterpretation?: ContextInterpretation;
      bioMatchWeights?: { keyword: number; jev: number };
      nameAnalysis?: NameAnalysis;
      error?: string;
    };
    if (!response.ok) throw new Error(body.error || "Search failed");
    if (revision !== searchRevision) return;
    showContextInterpretation(body.contextInterpretation);
    if (body.nameAnalysis) showNameInterpretation(body.nameAnalysis);
    bioMatchWeights = body.bioMatchWeights;
    candidateSelection.upsert(body.candidates ?? []);
    totalTested += body.testedCount ?? 0;
    void debugUi?.then((ui) => ui.addBatch(body.debugCandidates ?? [], totalTested));
    nextContinuation = body.continuation;
    if (!nextContinuation) pagingActive = false;
    if (!nextContinuation) searchStatus.textContent = `Search complete. ${totalTested} candidates checked.`;
    searchToggle.hidden = !nextContinuation;
    updateSearchToggle();
    renderCandidateResults();

    if (pagingActive && nextContinuation) {
      const delay = nextBatchDelay(totalTested);
      nextBatchTimer = setTimeout(() => {
        void search(revision, name, context, nextContinuation);
      }, delay);
    }
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") return;
    if (revision !== searchRevision) return;
    pagingActive = false;
    searchToggle.hidden = !nextContinuation;
    updateSearchToggle();
    searchStatus.textContent = `Search failed. ${error instanceof Error ? error.message : "Please try again."}`;
    if (!candidateSelection.size) {
      results.innerHTML = `<div class="error" role="alert"><h3>Search failed</h3><p>${escapeHtml(error instanceof Error ? error.message : "Please try again.")}</p></div>`;
    }
  } finally {
    if (revision === searchRevision) activeRequest = undefined;
  }
}, searchLock);

function scheduleSearch() {
  const revision = ++searchRevision;
  activeRequest?.abort();
  if (nextBatchTimer) clearTimeout(nextBatchTimer);
  nextContinuation = undefined;
  candidateSelection.reset();
  scoreDetailsToggle.hidden = true;
  void debugUi?.then((ui) => ui.reset());
  totalTested = 0;
  if (candidateCountAnimation !== undefined) cancelAnimationFrame(candidateCountAnimation);
  candidateReelAnimations.forEach((animation) => animation.cancel());
  candidateCountAnimation = undefined;
  candidateReelAnimations = [];
  displayedCandidateCount = 0;
  bioMatchWeights = undefined;
  pagingActive = true;
  searchToggle.hidden = false;
  updateSearchToggle();
  const name = nameInput.value.trim();
  const context = contextInput.value.trim();
  nameHighlightTerms = tokenizeTerms(name).sort((left, right) => right.length - left.length);
  contextHighlightTerms = tokenizeEnglishKeywords(context).sort((left, right) => right.length - left.length);

  if (name.length < 2) {
    searchStatus.textContent = "";
    resultsSection.hidden = true;
    results.replaceChildren();
    searchToggle.hidden = true;
    pagingActive = false;
    updateSearchToggle();
    return;
  }

  debounce(() => void search(revision, name, context), INPUT_DEBOUNCE_MS, debounceLock);
}

searchToggle.addEventListener("click", () => {
  pagingActive = !pagingActive;
  updateSearchToggle();
  searchStatus.textContent = pagingActive
    ? `Search resumed. ${totalTested} candidates checked so far.`
    : `Search paused. ${totalTested} candidates checked so far.`;
  const { locked, rotating } = candidateSelection.view(10);
  updateResultCount(rotating.length, locked.length, totalTested);
  if (nextBatchTimer) clearTimeout(nextBatchTimer);
  if (pagingActive && nextContinuation && !activeRequest) {
    void search(
      searchRevision,
      nameInput.value.trim(),
      contextInput.value.trim(),
      nextContinuation,
    );
  }
});

scoreDetailsToggle.addEventListener("click", () => {
  showScoreDetails = !showScoreDetails;
  updateScoreDetailsToggle();
  renderCandidateResults();
});

results.addEventListener("click", (event) => {
  const target = event.target;
  if (!(target instanceof Element)) return;
  if (target.closest("a, button")) return;
  const card = target.closest<HTMLElement>("[data-candidate-did]");
  if (card?.dataset.candidateDid) toggleCandidateLock(card.dataset.candidateDid);
});

nameInput.addEventListener("input", () => {
  scheduleNameAnalysis();
  scheduleSearch();
});
contextInput.addEventListener("input", () => {
  scheduleContextAnalysis();
  scheduleSearch();
});
form.addEventListener("submit", (event) => event.preventDefault());
