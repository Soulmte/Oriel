/**
 * Persistent cache for Windows shell icons.
 *
 * Extracting an icon costs a PowerShell round-trip (hundreds of milliseconds),
 * so the data URLs are kept in IndexedDB and reused on the next launch. Entries
 * are keyed by path and validated against the file's mtime, which means a
 * replaced shortcut refreshes itself while everything else renders instantly.
 */

const DB_NAME = "mac-explorer";
const DB_VERSION = 1;
const STORE = "shell-icons";
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

export interface CachedShellIcon {
  path: string;
  mtimeMs: number;
  value: string;
  savedAt: number;
}

let dbPromise: Promise<IDBDatabase | null> | null = null;

function openDb(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve) => {
    if (typeof indexedDB === "undefined") {
      resolve(null);
      return;
    }

    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: "path" });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
    request.onblocked = () => resolve(null);
  });

  return dbPromise;
}

function done(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => resolve();
    transaction.onabort = () => resolve();
  });
}

export async function readCachedIcons(
  paths: string[],
): Promise<Map<string, CachedShellIcon>> {
  const result = new Map<string, CachedShellIcon>();
  if (paths.length === 0) return result;

  const db = await openDb();
  if (!db) return result;

  try {
    const transaction = db.transaction(STORE, "readonly");
    const store = transaction.objectStore(STORE);
    const deadline = Date.now() - MAX_AGE_MS;

    await Promise.all(
      paths.map(
        (target) =>
          new Promise<void>((resolve) => {
            const request = store.get(target);
            request.onsuccess = () => {
              const record = request.result as CachedShellIcon | undefined;
              if (record && record.value && record.savedAt > deadline) {
                result.set(target, record);
              }
              resolve();
            };
            request.onerror = () => resolve();
          }),
      ),
    );

    await done(transaction);
  } catch {
    return result;
  }

  return result;
}

export async function writeCachedIcons(
  items: CachedShellIcon[],
): Promise<void> {
  if (items.length === 0) return;

  const db = await openDb();
  if (!db) return;

  try {
    const transaction = db.transaction(STORE, "readwrite");
    const store = transaction.objectStore(STORE);
    for (const item of items) store.put(item);
    await done(transaction);
  } catch {
    // A full or unavailable quota only costs us a slower next launch.
  }
}

/** Drops records that have not been used for a long time. */
export async function pruneCachedIcons(): Promise<void> {
  const db = await openDb();
  if (!db) return;

  try {
    const transaction = db.transaction(STORE, "readwrite");
    const store = transaction.objectStore(STORE);
    const deadline = Date.now() - MAX_AGE_MS;
    const request = store.openCursor();

    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return;
      const record = cursor.value as CachedShellIcon;
      if (!record.savedAt || record.savedAt < deadline) cursor.delete();
      cursor.continue();
    };

    await done(transaction);
  } catch {
    // Best effort only.
  }
}

export interface IconCacheStats {
  count: number;
  /** Approximate, measured from the length of the stored data URLs. */
  bytes: number;
}

export async function iconCacheStats(): Promise<IconCacheStats> {
  const db = await openDb();
  if (!db) return { count: 0, bytes: 0 };

  const stats: IconCacheStats = { count: 0, bytes: 0 };
  try {
    const transaction = db.transaction(STORE, "readonly");
    const request = transaction.objectStore(STORE).openCursor();

    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return;
      const record = cursor.value as CachedShellIcon;
      stats.count += 1;
      stats.bytes += record.value?.length ?? 0;
      cursor.continue();
    };

    await done(transaction);
    return stats;
  } catch {
    return stats;
  }
}

export async function clearCachedIcons(): Promise<void> {
  const db = await openDb();
  if (!db) return;

  try {
    const transaction = db.transaction(STORE, "readwrite");
    transaction.objectStore(STORE).clear();
    await done(transaction);
  } catch {
    // Nothing worth reporting: the cache only saves time.
  }
}
