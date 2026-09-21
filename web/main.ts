import "./styles.css";
import { debounce, synchronize } from "@fettstorch/jule";

type Candidate = {
  did: string;
  handle: string;
  displayName?: string;
  description?: string;
  avatar?: string;
  profileUrl: string;
  nameScore: number;
  contextSupportScore?: number;
  contextContradictionScore?: number;
  matchScore: number;
};

const form = document.querySelector<HTMLFormElement>("#search-form")!;
const nameInput = document.querySelector<HTMLInputElement>("#person-name")!;
const contextInput = document.querySelector<HTMLInputElement>("#person-context")!;
const resultsSection = document.querySelector<HTMLElement>("#results-section")!;
const results = document.querySelector<HTMLElement>("#results")!;
const resultCount = document.querySelector<HTMLElement>("#result-count")!;
const searchToggle = document.querySelector<HTMLButtonElement>("#search-toggle")!;
const debounceLock = {};
const searchLock = {};
let searchRevision = 0;
let activeRequest: AbortController | undefined;
let nextContinuation: string | undefined;
let pagingActive = false;
let nextBatchTimer: ReturnType<typeof setTimeout> | undefined;
let totalTested = 0;
let completedBatches = 0;
let highlightTerms: string[] = [];
const accumulatedCandidates = new Map<string, Candidate>();

const escapeHtml = (value: unknown) => String(value).replace(/[&<>"']/g, (character) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
})[character]!);

function getHighlightTerms(name: string, context: string) {
  return [...new Set(`${name} ${context}`.toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])]
    .sort((left, right) => right.length - left.length);
}

function highlightText(value: string) {
  if (!highlightTerms.length) return escapeHtml(value);
  const pattern = new RegExp(
    `(${highlightTerms.map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`,
    "giu",
  );
  return value.split(pattern).map((part) =>
    highlightTerms.includes(part.toLocaleLowerCase())
      ? `<mark>${escapeHtml(part)}</mark>`
      : escapeHtml(part)
  ).join("");
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

function signalBar(label: string, score: number, color: string) {
  const safeScore = Math.max(0, Math.min(10, score));
  return `<div class="signal">
    <span class="signal-label">${label}</span>
    <span class="signal-track"><span style="width:${safeScore * 10}%;background:${color}"></span></span>
    <strong>${safeScore.toFixed(1)}</strong>
  </div>`;
}

function renderCandidate(candidate: Candidate) {
  const score = Math.max(0, Math.min(10, candidate.matchScore));
  const avatar = candidate.avatar
    ? `<img class="avatar" src="${escapeHtml(candidate.avatar)}" alt="" loading="lazy">`
    : `<div class="avatar avatar-fallback" aria-hidden="true">@</div>`;

  return `
    <article class="profile-card">
      <div class="confidence-track" role="meter" aria-label="Match score" aria-valuemin="0" aria-valuemax="10" aria-valuenow="${score}">
        <div class="confidence-fill" style="width:${score * 10}%;background:${meterColor(score)}"></div>
      </div>
      <div class="card-body">
        <div class="profile-main">
          ${avatar}
          <div class="profile-copy">
            <div class="profile-title">
              <div>
                <h3>${highlightText(candidate.displayName || candidate.handle)}</h3>
                <a href="${escapeHtml(candidate.profileUrl)}" target="_blank" rel="noreferrer">@${highlightText(candidate.handle)}</a>
              </div>
              <div class="score" style="--score-color:${meterColor(score)}">
                <strong>${score.toFixed(1)}</strong><span>/10</span>
              </div>
            </div>
            <div class="signal-bars" aria-label="Score breakdown">
              ${signalBar("Name", candidate.nameScore, "#6488e8")}
              ${candidate.contextSupportScore === undefined ? "" : signalBar("Context match", candidate.contextSupportScore, "#63bd8a")}
              ${candidate.contextContradictionScore === undefined ? "" : signalBar("Context contradiction", candidate.contextContradictionScore, "#dc7474")}
            </div>
            <p class="bio">${highlightText(candidate.description || "No profile bio")}</p>
          </div>
        </div>
      </div>
    </article>`;
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
  if (!accumulatedCandidates.size) {
    results.innerHTML = `<div class="loading"><span class="running-spinner" aria-hidden="true">🌀</span><p>Searching AT Protocol and comparing profiles…</p></div>`;
  }
  if (!totalTested) resultCount.textContent = "";

  try {
    const response = await fetch("/api/find", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name, context, continuation }),
      signal: activeRequest.signal,
    });
    const body = await response.json() as {
      candidates?: Candidate[];
      testedCount?: number;
      continuation?: string;
      error?: string;
    };
    if (!response.ok) throw new Error(body.error || "Search failed");
    if (revision !== searchRevision) return;
    for (const candidate of body.candidates ?? []) {
      accumulatedCandidates.set(candidate.did, candidate);
    }
    const candidates = [...accumulatedCandidates.values()]
      .sort((a, b) => b.matchScore - a.matchScore)
      .slice(0, 10);
    totalTested += body.testedCount ?? 0;
    completedBatches += 1;
    nextContinuation = body.continuation;
    if (!nextContinuation) pagingActive = false;
    searchToggle.hidden = !nextContinuation;
    updateSearchToggle();
    updateResultCount(`${candidates.length} best matches across ${totalTested} candidates`);
    results.innerHTML = candidates.length
      ? candidates.map(renderCandidate).join("")
      : `<div class="empty"><h3>No candidates found</h3><p>Try adding an employer, role, location, or topic.</p></div>`;

    if (pagingActive && nextContinuation) {
      const delay = (1 + Math.floor(completedBatches / 5)) * 1_000;
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
    if (!accumulatedCandidates.size) {
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
  accumulatedCandidates.clear();
  totalTested = 0;
  completedBatches = 0;
  pagingActive = true;
  searchToggle.hidden = false;
  updateSearchToggle();
  const name = nameInput.value.trim();
  const context = contextInput.value.trim();
  highlightTerms = getHighlightTerms(name, context);

  if (name.length < 2) {
    resultsSection.hidden = true;
    results.replaceChildren();
    searchToggle.hidden = true;
    pagingActive = false;
    return;
  }

  debounce(() => void search(revision, name, context), 150, debounceLock);
}

searchToggle.addEventListener("click", () => {
  pagingActive = !pagingActive;
  updateSearchToggle();
  updateResultCount(`${Math.min(10, accumulatedCandidates.size)} best matches across ${totalTested} candidates`);
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

nameInput.addEventListener("input", scheduleSearch);
contextInput.addEventListener("input", scheduleSearch);
form.addEventListener("submit", (event) => event.preventDefault());
