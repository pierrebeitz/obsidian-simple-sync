/** Discriminated union for fallible operations — no throws needed. */
export type Result<T, E = Error> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: E };

export function ok<T>(value: T): Result<T, never> {
  return { ok: true, value };
}

export function err<E = Error>(error: E): Result<never, E> {
  return { ok: false, error };
}

/** Normalize an unknown thrown value to an Error instance. */
export function toError(e: unknown): Error {
  return e instanceof Error ? e : new Error(String(e));
}

/** Wrap a promise-returning function into a Result. */
export async function tryAsync<T>(fn: () => Promise<T>): Promise<Result<T>> {
  try {
    return ok(await fn());
  } catch (e: unknown) {
    return err(toError(e));
  }
}

/** Extract the value or return a fallback. */
export function unwrapOr<T>(result: Result<T>, fallback: T): T {
  return result.ok ? result.value : fallback;
}
