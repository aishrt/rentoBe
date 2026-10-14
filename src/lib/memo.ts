/*
 * A short in-memory cache per backend task (plan §4.1): homepage content, featured vehicles, filter
 * options and the street addresses searched for, never availability. Each task keeps its own copy for
 * up to `ttlMs`.
 */

const store = new Map<string, { value: Promise<unknown>; expiresAt: number }>();

/** Values kept per task: each street address searched for adds one, so the oldest make way. */
const MAX_ENTRIES = 1_000;

/** Clears out expired values, then the oldest while there are still too many. */
function prune(now = Date.now()) {
  for (const [key, entry] of store) if (entry.expiresAt <= now) store.delete(key);
  for (const key of store.keys()) {
    if (store.size <= MAX_ENTRIES) break;
    store.delete(key);
  }
}

/** The cached value for `key`, loading it when missing or expired. A failed load isn't kept. */
export function memo<T>(key: string, ttlMs: number, load: () => PromiseLike<T>): Promise<T> {
  const hit = store.get(key);
  if (hit && hit.expiresAt > Date.now()) return hit.value as Promise<T>;
  // A Mongoose query runs again each time it's awaited; a promise settles once.
  const value = Promise.resolve(load());
  // Set again rather than updated, so the store stays oldest first.
  store.delete(key);
  store.set(key, { value, expiresAt: Date.now() + ttlMs });
  if (store.size > MAX_ENTRIES) prune();
  value.catch(() => {
    if (store.get(key)?.value === value) store.delete(key);
  });
  return value;
}

/** Forgets a cached value (after an admin edit), or everything (tests). */
export function forget(key?: string): void {
  if (key) store.delete(key);
  else store.clear();
}
