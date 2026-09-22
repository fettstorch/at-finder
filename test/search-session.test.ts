import assert from "node:assert/strict";
import test from "node:test";
import {
  claimSearchSession,
  initializeSearchSession,
  InvalidSearchSessionError,
  SearchSession,
  type StoredSearchSession,
} from "../worker/search-session.js";

const input = { name: "Jane Smith", context: "Acme" };

test("search sessions enforce ordered, input-bound claims and sliding expiry", () => {
  const initialized = initializeSearchSession(input, 1_000);
  assert.equal(initialized.sequence, 0);
  assert.ok(initialized.search.searches.length > 0);

  const claimed = claimSearchSession(initialized, input, 0, 2_000);
  assert.equal(claimed.sequence, 1);
  assert.ok(claimed.expiresAt > initialized.expiresAt);
  assert.throws(
    () => claimSearchSession(claimed, input, 0, 3_000),
    InvalidSearchSessionError,
  );
  assert.throws(
    () => claimSearchSession(claimed, { ...input, context: "Different" }, 1, 3_000),
    InvalidSearchSessionError,
  );
});

test("search sessions reject expired state", () => {
  const session = initializeSearchSession(input, 1_000);
  assert.throws(
    () => claimSearchSession(session, input, 0, session.expiresAt),
    (error: unknown) => error instanceof InvalidSearchSessionError && error.expired,
  );
});

test("Durable Object alarms reschedule active state and clean expired storage", async () => {
  let stored: StoredSearchSession | undefined = initializeSearchSession(input, Date.now());
  const alarms: number[] = [];
  let deleted = false;
  const storage = {
    get: async <T>() => stored as T | undefined,
    put: async <T>(_key: string, value: T) => { stored = value as StoredSearchSession; },
    setAlarm: async (time: number | Date) => { alarms.push(Number(time)); },
    deleteAlarm: async () => {},
    deleteAll: async () => { deleted = true; stored = undefined; },
    sql: {
      exec: <T extends Record<string, unknown>>() => ({
        one: () => ({ count: 0 }) as unknown as T,
        toArray: () => [] as T[],
      }),
    },
  };
  const object = new SearchSession({ storage }, { TYPESAFE_API_KEY: "test" });

  await object.alarm();
  assert.deepEqual(alarms, [stored?.expiresAt]);
  assert.equal(deleted, false);

  stored = { ...initializeSearchSession(input, 0), expiresAt: Date.now() - 1 };
  await object.alarm();
  assert.equal(deleted, true);
  assert.equal(stored, undefined);
});
