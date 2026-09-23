import "./styles.css";
import { debounce, synchronize } from "@fettstorch/jule";
import { tokenizeEnglishKeywords, tokenizeTerms } from "../src/english-stopwords.js";
import { CandidateSelection, isCandidateToggleKey } from "./candidate-selection.js";
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
const contextInterpretation = document.querySelector<HTMLElement>("#context-interpretation")!;
const resultsSection = document.querySelector<HTMLElement>("#results-section")!;
const results = document.querySelector<HTMLElement>("#results")!;
const resultCount = document.querySelector<HTMLElement>("#result-count")!;
const searchToggle = document.querySelector<HTMLButtonElement>("#search-toggle")!;
const debounceLock = {};
const searchLock = {};
const contextDebounceLock = {};
const contextLock = {};
const INPUT_DEBOUNCE_MS = 300;
let searchRevision = 0;
let contextRevision = 0;
let activeRequest: AbortController | undefined;
let activeContextRequest: AbortController | undefined;
let nextContinuation: string | undefined;
let pagingActive = false;
let nextBatchTimer: ReturnType<typeof setTimeout> | undefined;
let totalTested = 0;
let nameHighlightTerms: string[] = [];
let contextHighlightTerms: string[] = [];
let bioMatchWeights: { keyword: number; jev: number } | undefined;
type ContextInterpretation = { keywordProbability: number; freeTextProbability: number };
type ContextAnalysis = {
  contextInterpretation: ContextInterpretation;
  bioMatchWeights: { keyword: number; jev: number };
};
let currentContextAnalysis: { context: string; promise: Promise<ContextAnalysis | undefined> } | undefined;
let resolvePendingContext: ((value: ContextAnalysis | undefined) => void) | undefined;
const candidateSelection = new CandidateSelection<Candidate>();
const debugUi = import.meta.env?.DEV
  ? import("./debug.js").then(({ createDebugUi }) => createDebugUi(
      document.querySelector<HTMLElement>(".search-panel")!,
    ))
  : undefined;

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
  searchToggle.textContent = pagingActive ? "⏸" : "▶";
  searchToggle.setAttribute("aria-label", label);
  searchToggle.title = label;
}

function updateResultCount(message: string) {
  resultCount.innerHTML = pagingActive
    ? `<span class="running-spinner" aria-hidden="true">🌀</span>${message}`
    : message;
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
  return `<div class="signal">
    <span class="signal-label">${label}${factor === undefined ? "" : ` <small class="weight-badge">×${factor.toFixed(2)}</small>`}</span>
    <span class="signal-track"><span style="width:${safeScore * 10}%;background:${color}"></span></span>
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
    <article class="profile-card${locked ? " is-locked" : ""}" data-candidate-did="${escapeHtml(candidate.did)}"
      role="button" tabindex="0" aria-pressed="${locked}"
      aria-label="${locked ? "Unlock" : "Lock"} candidate ${escapeHtml(candidateName)}">
      <div class="confidence-track" role="meter" aria-label="Match score" aria-valuemin="0" aria-valuemax="10" aria-valuenow="${score}">
        <div class="confidence-fill" style="width:${score * 10}%;background:${meterColor(score)}"></div>
      </div>
      <div class="card-body">
        <div class="profile-main">
          ${avatar}
          <div class="profile-copy">
            <div class="profile-title">
              <div>
                <h3>${highlightText(candidateName)}</h3>
                <a href="${escapeHtml(candidate.profileUrl)}" target="_blank" rel="noreferrer">@${highlightText(candidate.handle)}</a>
              </div>
              <div class="profile-controls">
                <div class="score" style="--score-color:${meterColor(score)}">
                  <strong>${score.toFixed(1)}</strong><span>/10</span>
                </div>
              </div>
            </div>
            <details class="metrics-details">
              <summary>Score details</summary>
              <div class="signal-bars" aria-label="Score breakdown">
                ${signalBar("Name", candidate.nameScore, "#6488e8")}
                ${candidate.bioMatchScores
                  ? bioMatchSignalBars(candidate)
                  : `${candidate.contextSupportScore === undefined ? "" : signalBar("Context match", candidate.contextSupportScore, "#63bd8a")}
                    ${candidate.contextContradictionScore === undefined ? "" : signalBar("Context contradiction", candidate.contextContradictionScore, "#dc7474")}`}
              </div>
            </details>
            <p class="bio">${highlightText(candidate.description || "No profile bio")}</p>
          </div>
        </div>
      </div>
    </article>`;
}

function renderCandidateResults() {
  const focusedElement = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
  const focusedDid = focusedElement?.closest<HTMLElement>("[data-candidate-did]")?.dataset.candidateDid;
  const focusedKind = focusedElement?.matches("a") ? "profile" : "card";
  const { locked, rotating } = candidateSelection.view(10);
  updateResultCount(
    `${rotating.length} best matches${locked.length ? ` + ${locked.length} locked` : ""} across ${totalTested} candidates`,
  );

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
  if (focusedDid) focusCandidateControl(focusedDid, focusedKind);
}

function focusCandidateControl(did: string, kind: "card" | "profile" = "card") {
  const card = [...results.querySelectorAll<HTMLElement>("[data-candidate-did]")]
    .find((candidateCard) => candidateCard.dataset.candidateDid === did);
  const control = kind === "profile"
    ? card?.querySelector<HTMLAnchorElement>("a")
    : card;
  if (control) control.focus();
  else document.querySelector<HTMLElement>("#matches-heading")?.focus();
}

function toggleCandidateLock(did: string, restoreFocus = false) {
  candidateSelection.toggle(did);
  renderCandidateResults();
  if (restoreFocus) focusCandidateControl(did);
}

const search = synchronize(async (
  revision: number,
  name: string,
  context: string,
  continuation?: string,
) => {
  if (revision !== searchRevision) return;

  activeRequest = new AbortController();
  resultsSection.hidden = false;
  if (!candidateSelection.size) {
    results.innerHTML = `<div class="loading"><span class="running-spinner" aria-hidden="true">🌀</span><p>Searching AT Protocol and comparing profiles…</p></div>`;
  }
  if (!totalTested) resultCount.textContent = "";

  try {
    const contextAnalysis = await contextAnalysisFor(context);
    if (revision !== searchRevision) return;

    const response = await fetch("/api/find", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name,
        context,
        continuation,
        contextInterpretation: contextAnalysis?.contextInterpretation,
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
      error?: string;
    };
    if (!response.ok) throw new Error(body.error || "Search failed");
    if (revision !== searchRevision) return;
    showContextInterpretation(body.contextInterpretation);
    bioMatchWeights = body.bioMatchWeights;
    candidateSelection.upsert(body.candidates ?? []);
    totalTested += body.testedCount ?? 0;
    void debugUi?.then((ui) => ui.addBatch(body.debugCandidates ?? [], totalTested));
    nextContinuation = body.continuation;
    if (!nextContinuation) pagingActive = false;
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
    if (!candidateSelection.size) {
      results.innerHTML = `<div class="error"><h3>Search failed</h3><p>${escapeHtml(error instanceof Error ? error.message : "Please try again.")}</p></div>`;
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
  void debugUi?.then((ui) => ui.reset());
  totalTested = 0;
  bioMatchWeights = undefined;
  pagingActive = true;
  searchToggle.hidden = false;
  updateSearchToggle();
  const name = nameInput.value.trim();
  const context = contextInput.value.trim();
  nameHighlightTerms = tokenizeTerms(name).sort((left, right) => right.length - left.length);
  contextHighlightTerms = tokenizeEnglishKeywords(context).sort((left, right) => right.length - left.length);

  if (name.length < 2) {
    resultsSection.hidden = true;
    results.replaceChildren();
    searchToggle.hidden = true;
    pagingActive = false;
    return;
  }

  debounce(() => void search(revision, name, context), INPUT_DEBOUNCE_MS, debounceLock);
}

searchToggle.addEventListener("click", () => {
  pagingActive = !pagingActive;
  updateSearchToggle();
  const { locked, rotating } = candidateSelection.view(10);
  updateResultCount(`${rotating.length} best matches${locked.length ? ` + ${locked.length} locked` : ""} across ${totalTested} candidates`);
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

results.addEventListener("click", (event) => {
  const target = event.target;
  if (!(target instanceof Element)) return;
  if (target.closest("a, details")) return;
  const card = target.closest<HTMLElement>("[data-candidate-did]");
  if (card?.dataset.candidateDid) toggleCandidateLock(card.dataset.candidateDid, true);
});

results.addEventListener("keydown", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement) || !target.matches("[data-candidate-did]")) return;
  if (!isCandidateToggleKey(event.key) || !target.dataset.candidateDid) return;
  event.preventDefault();
  toggleCandidateLock(target.dataset.candidateDid, true);
});

nameInput.addEventListener("input", scheduleSearch);
contextInput.addEventListener("input", () => {
  scheduleContextAnalysis();
  scheduleSearch();
});
form.addEventListener("submit", (event) => event.preventDefault());
