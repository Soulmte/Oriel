/**
 * One-time migration from the pre-rename storage keys.
 *
 * The project was called "Mac Explorer" before it became Oriel; preferences are
 * carried over so a rename does not silently reset appearance, layout or the
 * context menu configuration.
 */

const LEGACY_PREFIX = "mac-explorer:";
const PREFIX = "oriel:";

export function migrateStorageKeys(): void {
  try {
    const legacy: string[] = [];
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      if (key?.startsWith(LEGACY_PREFIX)) legacy.push(key);
    }

    for (const key of legacy) {
      const next = `${PREFIX}${key.slice(LEGACY_PREFIX.length)}`;
      const value = localStorage.getItem(key);
      if (value !== null && localStorage.getItem(next) === null) {
        localStorage.setItem(next, value);
      }
      localStorage.removeItem(key);
    }
  } catch {
    // Storage disabled: nothing to migrate.
  }
}
