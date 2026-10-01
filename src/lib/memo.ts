/*
 * A short in-memory cache per backend task (plan §4.1): homepage content, featured vehicles and
 * filter options, never availability. Each task keeps its own copy for up to `ttlMs`.
 */

const store = new Map<string, { value: Promise<unknown>; expiresAt: number }>();

/** The cached value for `key`, loading it when missing or expired. A failed load isn't kept. */
export function memo<T>(key: string, ttlMs: number, load: () => PromiseLike<T>): Promise<T> {
  const hit = store.get(key);
  if (hit && hit.expiresAt > Date.now()) return hit.value as Promise<T>;
  // A Mongoose query runs again each time it's awaited; a promise settles once.
  const value = Promise.resolve(load());
  store.set(key, { value, expiresAt: Date.now() + ttlMs });
  value.catch(() => store.delete(key));
  return value;
}

/** Forgets a cached value (after an admin edit), or everything (tests). */
export function forget(key?: string): void {
  if (key) store.delete(key);
  else store.clear();
}
