// Session status model: durable statuses, model/agent memory, archive set,
// prompt progress files, and the stale-status reconciler.
import fs from 'fs';
import path from 'path';
import { STATE_DIR, apiRef } from './runtime';
import { storeGet, storeSet, storeUpdate, triggerSessionsMenuUpdate } from './store';
import { localRunStatus, pendingForms, pendingPermissions } from './ctx';
import { isHeartbeatFresh } from './leader';

export interface SavedSessionStatus {
  status: string;
  dir?: string;
  timestamp?: number;
}

export const ACTIVE_STATUSES = new Set(['busy', 'running', 'retry', 'waiting']);

function ownerDir(): string {
  try {
    return apiRef?.data?.location?.default?.()?.directory || '';
  } catch {
    return '';
  }
}

export function saveSessionStatus(sessionId: string, status: string) {
  try {
    storeUpdate<Record<string, SavedSessionStatus>>(
      'statuses',
      (all) => ({ ...all, [sessionId]: { status, dir: ownerDir(), timestamp: Date.now() } }),
      {},
    );
    triggerSessionsMenuUpdate();
  } catch {}
}

/** statuses map normalized to objects; tolerates pre-rewrite bare strings. */
export function readSavedStatuses(): Record<string, SavedSessionStatus> {
  const out: Record<string, SavedSessionStatus> = {};
  try {
    const statuses = storeGet<Record<string, any>>('statuses', {});
    for (const [id, v] of Object.entries(statuses)) {
      if (typeof v === 'string') out[id] = { status: v };
      else if (v && typeof v.status === 'string') out[id] = { status: v.status, dir: v.dir, timestamp: v.timestamp };
    }
  } catch {}
  return out;
}

export function saveSessionModel(sessionId: string, providerID: string, modelID: string) {
  try {
    storeUpdate<Record<string, { providerID: string; modelID: string; timestamp: number }>>(
      'sessionModels',
      (all) => ({ ...all, [sessionId]: { providerID, modelID, timestamp: Date.now() } }),
      {},
    );
    triggerSessionsMenuUpdate();
  } catch {}
}

export function saveSessionAgent(sessionId: string, agent: string) {
  try {
    storeUpdate<Record<string, string>>('sessionAgents', (all) => ({ ...all, [sessionId]: agent }), {});
    triggerSessionsMenuUpdate();
  } catch {}
}

export function getArchivedSessions(): Set<string> {
  try {
    return new Set<string>(storeGet<string[]>('archivedSessions', []));
  } catch {
    return new Set();
  }
}

export function archiveSession(sessionId: string) {
  try {
    const archived = getArchivedSessions();
    archived.add(sessionId);
    storeSet('archivedSessions', Array.from(archived));
    triggerSessionsMenuUpdate();
  } catch {}
}

// --- Prompt progress files (live tail content per session) ---

export function getPromptStatusPath(sessionId: string): string {
  return path.join(STATE_DIR, `prompt-status-${sessionId}.json`);
}

export function savePromptStatus(sessionId: string, status: string) {
  try {
    fs.writeFileSync(getPromptStatusPath(sessionId), JSON.stringify({ status, timestamp: Date.now(), isComplete: false }));
  } catch {}
}

export function savePromptResponse(
  sessionId: string,
  text: string,
  info?: { title?: string; agent?: string; model?: string; duration?: number; tokens?: number; cost?: number },
) {
  try {
    fs.writeFileSync(getPromptStatusPath(sessionId), JSON.stringify({ text, info, timestamp: Date.now(), isComplete: true }));
  } catch {}
}

export function updatePromptResponseMeta(sessionId: string, cost?: number, tokens?: number) {
  try {
    const fp = getPromptStatusPath(sessionId);
    if (!fs.existsSync(fp)) return;
    const data = JSON.parse(fs.readFileSync(fp, 'utf8'));
    if (data.isComplete && data.info) {
      if (cost !== undefined) data.info.cost = cost;
      if (tokens !== undefined) data.info.tokens = tokens;
      fs.writeFileSync(fp, JSON.stringify(data));
    }
  } catch {}
}

// --- Status computation + reconciler ---

/** Final badge type: pending form/permission questions take precedence. */
export function computeStatus(sessionId: string, baseType?: string): string {
  let type = baseType || 'idle';
  try {
    if (pendingForms(sessionId).length > 0) type = 'ask';
    else if (pendingPermissions(sessionId).length > 0) type = 'perm';
  } catch {}
  return type;
}

/**
 * Repairs statuses wedged by a missed idle event (hot reload mid-run,
 * crash, dropped event). `apply` persists + updates the UI signal.
 * Truth order: live store (authoritative for known sessions) -> local
 * knowledge -> owning instance's heartbeat -> server existence check.
 */
export async function reconcileStaleStatuses(apply: (id: string, status: string) => void) {
  let saved: Record<string, SavedSessionStatus>;
  try {
    saved = readSavedStatuses();
  } catch {
    return;
  }
  const ids = Object.keys(saved).filter((id) => ACTIVE_STATUSES.has(saved[id]?.status));
  for (const id of ids) {
    try {
      const live = localRunStatus(id);
      if (live === 'running' || live === 'busy') continue;
      let known = false;
      try {
        known = !!apiRef?.data?.session?.get?.(id);
      } catch {}
      if (known) {
        apply(id, 'idle');
        continue;
      }
      let dir = saved[id]?.dir || '';
      let hbFresh = dir ? isHeartbeatFresh(dir) : false;
      if (!dir || !hbFresh) {
        try {
          const s: any = await apiRef?.client?.session?.get?.({ sessionID: id });
          const srvDir = s?.location?.directory || s?.directory || '';
          if (srvDir) {
            dir = srvDir;
            hbFresh = isHeartbeatFresh(srvDir);
          } else if (s?.id) {
            continue; // exists but owner unknown — don't touch
          } else {
            apply(id, 'idle');
            continue;
          }
        } catch {
          apply(id, 'idle'); // gone from server
          continue;
        }
      }
      if (!hbFresh) apply(id, 'idle');
    } catch {}
  }
}
