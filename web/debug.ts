import "./debug.css";
import type { Candidate } from "./main.js";

function normalizeHandle(value: string) {
  return value.trim().replace(/^@/u, "").toLocaleLowerCase();
}

function escapeHtml(value: unknown) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]!);
}

function metric(label: string, value: number | undefined, color: string) {
  if (value === undefined) return "";
  const score = Math.max(0, Math.min(10, value));
  return `<div class="debug-metric">
    <span>${escapeHtml(label)}</span>
    <i><i style="width:${score * 10}%;background:${color}"></i></i>
    <strong>${score.toFixed(1)}</strong>
  </div>`;
}

function candidateMetrics(candidate: Candidate) {
  const strategyMetrics = Object.entries(candidate.bioMatchScores ?? {}).flatMap(([name, scores]) => [
    metric(`${name} match`, scores.supportScore, "#63bd8a"),
    metric(`${name} mismatch`, scores.contradictionScore, "#dc7474"),
  ]).join("");
  return [
    metric("Overall", candidate.matchScore, "#8abf63"),
    metric("Name", candidate.nameScore, "#6488e8"),
    metric("Combined context match", candidate.contextSupportScore, "#63bd8a"),
    metric("Combined context mismatch", candidate.contextContradictionScore, "#dc7474"),
    strategyMetrics,
  ].join("");
}

export function createDebugUi(anchor: HTMLElement) {
  const panel = document.createElement("section");
  panel.className = "debug-panel";
  panel.innerHTML = `<div class="debug-heading">
      <div><span>Vite dev diagnostic</span><strong>Track an expected account</strong></div>
      <label>Target handle <input type="text" autocomplete="off" spellcheck="false" placeholder="@handle.example"></label>
    </div>
    <div class="debug-output"><p>Enter a handle to see its scores as soon as a raw batch contains it.</p></div>`;
  anchor.insertAdjacentElement("afterend", panel);

  const input = panel.querySelector<HTMLInputElement>("input")!;
  const output = panel.querySelector<HTMLElement>(".debug-output")!;
  const seen = new Map<string, { candidate: Candidate; testedCount: number }>();
  let testedCount = 0;

  function render() {
    const handle = normalizeHandle(input.value);
    if (!handle) {
      output.innerHTML = "<p>Enter a handle to see its scores as soon as a raw batch contains it.</p>";
      return;
    }
    const match = seen.get(handle);
    if (!match) {
      output.innerHTML = `<p>Waiting for <strong>@${escapeHtml(handle)}</strong> · ${testedCount.toLocaleString()} candidates inspected</p>`;
      return;
    }
    const { candidate, testedCount: foundAt } = match;
    const avatar = candidate.avatar
      ? `<img src="${escapeHtml(candidate.avatar)}" alt="">`
      : `<span class="debug-avatar-fallback">@</span>`;
    output.innerHTML = `<article class="debug-candidate">
      ${avatar}
      <div class="debug-candidate-copy">
        <div class="debug-candidate-title">
          <div><strong>${escapeHtml(candidate.displayName || candidate.handle)}</strong><a href="${escapeHtml(candidate.profileUrl)}" target="_blank" rel="noreferrer">@${escapeHtml(candidate.handle)}</a></div>
          <small>Found by ${foundAt.toLocaleString()} candidates</small>
        </div>
        <details class="debug-metrics-details">
          <summary>Score details</summary>
          <div class="debug-metrics">${candidateMetrics(candidate)}</div>
        </details>
        <p>${escapeHtml(candidate.description || "No profile bio")}</p>
      </div>
    </article>`;
  }

  input.addEventListener("input", render);

  return {
    addBatch(candidates: Candidate[], inspectedCount: number) {
      testedCount = inspectedCount;
      for (const candidate of candidates) {
        const handle = normalizeHandle(candidate.handle);
        if (!seen.has(handle)) seen.set(handle, { candidate, testedCount: inspectedCount });
      }
      render();
    },
    reset() {
      seen.clear();
      testedCount = 0;
      render();
    },
  };
}
