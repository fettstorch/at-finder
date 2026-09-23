import type { FindActorsInput } from "./find-actors.js";

const TOKEN_VERSION = 2;
export const CONTINUATION_TTL_MS = 15 * 60 * 1_000;
const MAX_TOKEN_LENGTH = 1_024;

type TokenEnvelope = {
  v: number;
  exp: number;
  sid: string;
  seq: number;
  bind: string;
};

export type ContinuationClaims = {
  sessionId: string;
  sequence: number;
};

export class InvalidContinuationError extends Error {
  constructor() {
    super("Invalid continuation token");
    this.name = "InvalidContinuationError";
  }
}

function encodeBase64Url(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function decodeBase64Url(value: string) {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new InvalidContinuationError();
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "="));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function signingKey(secret: string) {
  if (secret.length < 32) throw new Error("CONTINUATION_SECRET must be at least 32 characters");
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

async function inputBinding(input: FindActorsInput) {
  const bytes = new Uint8Array(await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify([input.name, input.context ?? ""])),
  ));
  return encodeBase64Url(bytes);
}

/**
 * Signs a fixed-size reference to server-side search state. Search input is
 * represented only by a digest, so token size cannot grow with pagination.
 */
export async function createContinuation(
  claims: ContinuationClaims,
  input: FindActorsInput,
  secret: string,
  now = Date.now(),
  ttlMs = CONTINUATION_TTL_MS,
) {
  const envelope: TokenEnvelope = {
    v: TOKEN_VERSION,
    exp: Math.floor((now + ttlMs) / 1_000),
    sid: claims.sessionId,
    seq: claims.sequence,
    bind: await inputBinding(input),
  };
  const payload = encodeBase64Url(new TextEncoder().encode(JSON.stringify(envelope)));
  const signature = new Uint8Array(await crypto.subtle.sign(
    "HMAC",
    await signingKey(secret),
    new TextEncoder().encode(payload),
  ));
  return `${payload}.${encodeBase64Url(signature)}`;
}

/** Verifies signature, expiry, shape, and normalized-input binding. */
export async function readContinuation(
  token: string,
  input: FindActorsInput,
  secret: string,
  now = Date.now(),
): Promise<ContinuationClaims> {
  try {
    if (token.length > MAX_TOKEN_LENGTH) throw new InvalidContinuationError();
    const [payload, signature, extra] = token.split(".");
    if (!payload || !signature || extra) throw new InvalidContinuationError();
    const validSignature = await crypto.subtle.verify(
      "HMAC",
      await signingKey(secret),
      decodeBase64Url(signature),
      new TextEncoder().encode(payload),
    );
    if (!validSignature) throw new InvalidContinuationError();

    const envelope = JSON.parse(new TextDecoder().decode(decodeBase64Url(payload))) as Partial<TokenEnvelope>;
    if (
      envelope.v !== TOKEN_VERSION
      || typeof envelope.exp !== "number"
      || envelope.exp <= Math.floor(now / 1_000)
      || typeof envelope.sid !== "string"
      || !/^[0-9a-f-]{36}$/i.test(envelope.sid)
      || !Number.isSafeInteger(envelope.seq)
      || (envelope.seq ?? -1) < 1
      || typeof envelope.bind !== "string"
      || envelope.bind !== await inputBinding(input)
    ) throw new InvalidContinuationError();
    return { sessionId: envelope.sid, sequence: envelope.seq } as ContinuationClaims;
  } catch (error) {
    if (error instanceof InvalidContinuationError) throw error;
    throw new InvalidContinuationError();
  }
}
