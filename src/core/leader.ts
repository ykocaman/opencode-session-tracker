// Leader election + instance presence. Proven logic, kept as-is:
// - lock file {id, pid, timestamp}, 15s TTL, dead-pid takeover check
// - per-directory heartbeats (atomic tmp+rename), stale/dead pruned on read
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { STATE_DIR, LOCK_FILE, INSTANCE_ID, apiRef } from './runtime';

const LOCK_TTL_MS = 15000;
const LOCK_PID_CHECK_EVERY = 15;

let lockCheckTick = 0;

export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: any) {
    // EPERM means the process exists but belongs to another user.
    return e?.code === 'EPERM';
  }
}

function claimLock(now: number) {
  const tmp = `${LOCK_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ id: INSTANCE_ID, pid: process.pid, timestamp: now }));
  fs.renameSync(tmp, LOCK_FILE);
}

function readLock(): any {
  if (!fs.existsSync(LOCK_FILE)) return null;
  try {
    return JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8'));
  } catch {
    return null;
  }
}

export function electLeader(now: number): boolean {
  let lockData: any = null;
  try {
    lockData = readLock();
  } catch {
    return false;
  }
  const expired = !lockData || now - lockData.timestamp > LOCK_TTL_MS;
  if (lockData?.id === INSTANCE_ID || expired) {
    try {
      claimLock(now);
    } catch {
      return false;
    }
    return true;
  }
  if (++lockCheckTick % LOCK_PID_CHECK_EVERY === 0 && !alive(lockData.pid)) {
    try {
      claimLock(now);
    } catch {
      return false;
    }
    return true;
  }
  return false;
}

// --- Presence heartbeats ---

function heartbeatPath(dir: string): string {
  const hash = crypto.createHash('sha1').update(dir).digest('hex').slice(0, 12);
  return path.join(STATE_DIR, `heartbeat-${hash}.json`);
}

export function updateActiveProjects() {
  let dir = '';
  try {
    dir = apiRef?.data?.location?.default?.()?.directory || '';
  } catch {}
  if (!dir) return;
  const target = heartbeatPath(dir);
  const tmp = `${target}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify({ dir, pid: process.pid, timestamp: Date.now() }));
    fs.renameSync(tmp, target);
  } catch (e) {
    console.error('[Telegram] Failed to write heartbeat:', e);
  }
}

export function readActiveProjects(maxAgeMs = 45000): Record<string, { timestamp: number; pid: number }> {
  const out: Record<string, { timestamp: number; pid: number }> = {};
  let files: string[] = [];
  try {
    files = fs.readdirSync(STATE_DIR);
  } catch {
    return out;
  }
  const now = Date.now();
  for (const f of files) {
    if (!f.startsWith('heartbeat-')) continue;
    const fp = path.join(STATE_DIR, f);
    try {
      const h = JSON.parse(fs.readFileSync(fp, 'utf8'));
      if (now - h.timestamp > maxAgeMs || !alive(h.pid)) {
        try {
          fs.unlinkSync(fp);
        } catch {}
        continue;
      }
      out[h.dir] = { timestamp: h.timestamp, pid: h.pid };
    } catch {
      try {
        fs.unlinkSync(fp);
      } catch {}
    }
  }
  return out;
}

export function readProjectPid(dir: string): number | null {
  try {
    return readActiveProjects(45000)[dir]?.pid ?? null;
  } catch {
    return null;
  }
}

/** True when the instance owning `dir` wrote a fresh heartbeat. */
export function isHeartbeatFresh(dir: string, maxAgeMs = 45000): boolean {
  if (!dir) return false;
  try {
    return !!readActiveProjects(maxAgeMs)[dir];
  } catch {
    return false;
  }
}
