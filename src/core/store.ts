// Durable per-key store. Replaces the old single session-tracker.json
// read-modify-write cycle, which lost updates when N instances wrote
// concurrently (last-writer-wins on the WHOLE file: heartbeats, tails and
// question answers could wipe each other's keys).
//
// Each key lives in its own file (store-<key>.json), written atomically
// via tmp+rename. The legacy single JSON is kept as a READ-ONLY fallback
// so pre-rewrite state (statuses, flows, archived, ...) migrates
// transparently on first read. New writes never touch the legacy file.
import fs from 'fs';
import path from 'path';
import { STATE_DIR, LEGACY_STATE_FILE } from './runtime';

function keyPath(key: string): string {
  // Sanitize: keys are internal constants, but never trust a filename.
  const safe = key.replace(/[^a-zA-Z0-9_-]/g, '_');
  return path.join(STATE_DIR, `store-${safe}.json`);
}

function atomicWriteJson(filePath: string, data: any) {
  const tmp = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data));
  fs.renameSync(tmp, filePath);
}

function readLegacy(): any {
  try {
    if (!fs.existsSync(LEGACY_STATE_FILE)) return {};
    return JSON.parse(fs.readFileSync(LEGACY_STATE_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function readKeyFile(key: string): { found: boolean; value: any } {
  try {
    const fp = keyPath(key);
    if (!fs.existsSync(fp)) return { found: false, value: undefined };
    return { found: true, value: JSON.parse(fs.readFileSync(fp, 'utf8')) };
  } catch {
    return { found: false, value: undefined };
  }
}

export function storeGet<T>(key: string, fallback: T): T {
  const hit = readKeyFile(key);
  if (hit.found && hit.value !== undefined) return hit.value as T;
  try {
    const legacy = readLegacy();
    if (legacy && legacy[key] !== undefined) return legacy[key] as T;
  } catch {}
  return fallback;
}

export function storeSet(key: string, value: any) {
  try {
    atomicWriteJson(keyPath(key), value);
  } catch (e) {
    console.error(`[store] failed to write ${key}:`, e);
  }
}

export function storeUpdate<T>(key: string, fn: (current: T) => T, init: T) {
  try {
    const current = storeGet<T>(key, init);
    storeSet(key, fn(current));
  } catch (e) {
    console.error(`[store] failed to update ${key}:`, e);
  }
}

// Disk-backed key/value map. Every operation re-reads the key file so
// multiple instances stay in sync (last-writer-wins PER KEY, not per file).
export function createStore<V>(key: string) {
  const read = (): Record<string, V> => storeGet<Record<string, V>>(key, {});
  return {
    get(k: string): V | undefined {
      try {
        return read()[k];
      } catch {
        return undefined;
      }
    },
    set(k: string, val: V) {
      try {
        const all = read();
        all[k] = val;
        storeSet(key, all);
      } catch {}
    },
    delete(k: string): boolean {
      try {
        const all = read();
        if (all && k in all) {
          delete all[k];
          storeSet(key, all);
          return true;
        }
      } catch {}
      return false;
    },
    entries(): [string, V][] {
      try {
        return Object.entries(read());
      } catch {
        return [];
      }
    },
    values(): V[] {
      try {
        return Object.values(read());
      } catch {
        return [];
      }
    },
  };
}

// --- Legacy-compatible whole-state access (transitional) ---

const KNOWN_KEYS = [
  'statuses', 'sessionModels', 'sessionAgents', 'activeSessions',
  'messageSessions', 'permissionRequests', 'pendingQuestions', 'qfMap',
  'archivedSessions', 'projectStatusOverrides', 'telegramStatus',
  'syncError', 'lastNotify', 'menuUpdateTimestamp', 'queue', 'queueErrors',
];

/** Assembles the old state shape from per-key files (+ legacy fallback). */
export function readState(): any {
  const out: any = readLegacy();
  try {
    for (const key of KNOWN_KEYS) {
      const hit = readKeyFile(key);
      if (hit.found && hit.value !== undefined) out[key] = hit.value;
    }
  } catch {}
  return out;
}

/** Splits a whole-state write into per-key atomic writes. */
export function writeState(data: any) {
  try {
    for (const [key, value] of Object.entries(data || {})) {
      if (key === 'sync') continue; // dead slot, never persist again
      storeSet(key, value);
    }
  } catch {}
}

export function updateState(key: string, value: any) {
  storeSet(key, value);
}

// --- Shared primitives ---

export function triggerSessionsMenuUpdate() {
  storeSet('menuUpdateTimestamp', Date.now());
}

export function setProjectStatusOverride(dir: string, status: string) {
  storeUpdate<Record<string, { status: string; timestamp: number }>>(
    'projectStatusOverrides',
    (all) => ({ ...all, [dir]: { status, timestamp: Date.now() } }),
    {},
  );
}

export function clearProjectStatusOverride(dir: string) {
  storeUpdate<Record<string, { status: string; timestamp: number }>>(
    'projectStatusOverrides',
    (all) => {
      const next = { ...all };
      delete next[dir];
      return next;
    },
    {},
  );
}

export function setTelegramStatus(status: 'ok' | 'missing' | 'failed') {
  storeSet('telegramStatus', status);
}

export function cleanupStaleCacheFiles() {
  try {
    if (!fs.existsSync(STATE_DIR)) return;
    const now = Date.now();
    const EXPIRY_MS = 24 * 60 * 60 * 1000;
    for (const file of fs.readdirSync(STATE_DIR)) {
      if (!file.startsWith('prompt-status-') || !file.endsWith('.json')) continue;
      try {
        const fp = path.join(STATE_DIR, file);
        if (now - fs.statSync(fp).mtimeMs > EXPIRY_MS) fs.unlinkSync(fp);
      } catch {}
    }
  } catch {}
}
