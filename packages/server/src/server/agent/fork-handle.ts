/** A persisted fork handle that a provider will not delete from: retrying can never succeed. */
export class ForkHandleRefusedError extends Error {
  constructor(reason: string) {
    super(`Refusing to discard fork: ${reason}`);
    this.name = "ForkHandleRefusedError";
  }
}

const SAFE_NATIVE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Ids in a handle end up in file paths and provider calls. The handle comes from a file on disk,
 * so a damaged or hand-edited record must never reach outside the provider's own state.
 */
export function requireSafeNativeId(id: string | undefined, what: string): string {
  if (!id || !SAFE_NATIVE_ID.test(id) || id.includes("..")) {
    throw new ForkHandleRefusedError(`${what} is not a plain id`);
  }
  return id;
}

export function requireUuid(id: string | undefined, what: string): string {
  if (!id || !UUID.test(id)) throw new ForkHandleRefusedError(`${what} is not a UUID`);
  return id;
}
