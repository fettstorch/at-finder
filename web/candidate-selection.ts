export type RankedCandidate = {
  did: string;
  matchScore: number;
};

export type CandidateView<T> = {
  locked: T[];
  rotating: T[];
};

/**
 * Tracks candidates and lock order for one search. Locked candidates remain in
 * insertion order and do not consume slots from the rotating ranked results.
 */
export class CandidateSelection<T extends RankedCandidate> {
  private readonly candidates = new Map<string, T>();
  private lockedOrder: string[] = [];

  upsert(candidates: Iterable<T>) {
    for (const candidate of candidates) this.candidates.set(candidate.did, candidate);
  }

  toggle(did: string) {
    const lockedIndex = this.lockedOrder.indexOf(did);
    if (lockedIndex >= 0) {
      this.lockedOrder.splice(lockedIndex, 1);
      return false;
    }
    if (!this.candidates.has(did)) return false;
    this.lockedOrder.push(did);
    return true;
  }

  isLocked(did: string) {
    return this.lockedOrder.includes(did);
  }

  view(rotatingLimit = 10): CandidateView<T> {
    const lockedIds = new Set(this.lockedOrder);
    const locked = this.lockedOrder
      .map((did) => this.candidates.get(did))
      .filter((candidate): candidate is T => Boolean(candidate));
    const rotating = [...this.candidates.values()]
      .filter((candidate) => !lockedIds.has(candidate.did))
      .sort((left, right) => right.matchScore - left.matchScore)
      .slice(0, rotatingLimit);
    return { locked, rotating };
  }

  reset() {
    this.candidates.clear();
    this.lockedOrder = [];
  }

  get size() {
    return this.candidates.size;
  }
}
