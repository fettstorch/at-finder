export const MAX_BODY_BYTES = 16 * 1024;
export const MAX_NAME_LENGTH = 200;
export const MAX_CONTEXT_LENGTH = 1_000;
export const MAX_CONTINUATION_LENGTH = 1_024;

export class RequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "RequestError";
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readLimitedText(request: Request) {
  const declaredLength = request.headers.get("content-length");
  if (declaredLength && Number(declaredLength) > MAX_BODY_BYTES) {
    throw new RequestError("Request body is too large.", 413);
  }
  if (!request.body) throw new RequestError("Request body must be JSON.", 400);

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) {
        await reader.cancel();
        throw new RequestError("Request body is too large.", 413);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(body);
}

/**
 * Reads the body through a byte limit before parsing and accepts only the
 * public API's exact JSON fields and bounded text/token values.
 */
export async function parseFindRequest(request: Request) {
  const contentType = request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
  if (contentType !== "application/json") {
    throw new RequestError("Content-Type must be application/json.", 415);
  }

  let body: unknown;
  try {
    body = JSON.parse(await readLimitedText(request));
  } catch (error) {
    if (error instanceof RequestError) throw error;
    throw new RequestError("Request body must be valid JSON.", 400);
  }
  if (!isPlainObject(body)) throw new RequestError("Request body must be a JSON object.", 400);
  const allowedKeys = new Set(["name", "context", "continuation"]);
  if (Object.keys(body).some((key) => !allowedKeys.has(key))) {
    throw new RequestError("Request contains unsupported fields.", 400);
  }

  const name = typeof body.name === "string" ? body.name.trim() : "";
  const context = typeof body.context === "string" ? body.context.trim() : "";
  const continuation = body.continuation;
  if (!name || name.length > MAX_NAME_LENGTH || /[\u0000-\u001f\u007f]/u.test(name)) {
    throw new RequestError("Provide a valid name (max 200 characters).", 400);
  }
  if (context.length > MAX_CONTEXT_LENGTH || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(context)) {
    throw new RequestError("Context must be at most 1000 characters.", 400);
  }
  if (
    continuation !== undefined
    && (typeof continuation !== "string" || !continuation || continuation.length > MAX_CONTINUATION_LENGTH)
  ) throw new RequestError("Continuation token is invalid.", 400);

  return { name, context, continuation: continuation as string | undefined };
}
