// OpenCode v2 accessors. Pure v2 (no v1 fallbacks — the rewrite rule);
// every helper never throws.
import { apiRef } from './runtime';

/** Working directory of this TUI instance. */
export function workdir(): string {
  try {
    return apiRef?.data?.location?.default?.()?.directory || '';
  } catch {
    return '';
  }
}

/** Pending form (question) requests for a session, from the local store. */
export function pendingForms(sessionId: string): any[] {
  try {
    return apiRef?.data?.session?.form?.list?.(sessionId) || [];
  } catch {
    return [];
  }
}

/** Pending permission requests for a session, from the local store. */
export function pendingPermissions(sessionId: string): any[] {
  try {
    return apiRef?.data?.session?.permission?.list?.(sessionId) || [];
  } catch {
    return [];
  }
}

/** 'idle' | 'running' (v2 vocabulary) for a session, never throws. */
export function localRunStatus(sessionId: string): string {
  try {
    return apiRef?.data?.session?.status?.(sessionId) || 'idle';
  } catch {
    return 'idle';
  }
}

/** Session title from the local store, '' when unknown. */
export function localSessionTitle(sessionId: string): string {
  try {
    return apiRef?.data?.session?.get?.(sessionId)?.title || '';
  } catch {
    return '';
  }
}

/** Directory a session belongs to: local store first, then the API. */
export async function sessionDirectory(sessionId: string): Promise<string> {
  try {
    const dir = apiRef?.data?.session?.get?.(sessionId)?.location?.directory;
    if (dir) return dir;
  } catch {}
  try {
    const s = unwrapSession(await apiRef?.client?.session?.get({ sessionID: sessionId }));
    if (s?.location?.directory) return s.location.directory;
  } catch {}
  return workdir();
}

export function navigateHome() {
  try {
    apiRef?.ui?.router?.navigate({ type: 'home' });
  } catch {}
}

export function navigateSession(sessionId: string) {
  try {
    apiRef?.ui?.router?.navigate({ type: 'session', sessionID: sessionId });
  } catch {}
}

/** Current route as { type: 'home' | 'session', sessionID? }. */
export function currentRoute(): { type: string; sessionID?: string } {
  try {
    const r = apiRef?.ui?.router?.current?.();
    if (r) return r;
  } catch {}
  return { type: 'home' };
}

/** session.list output -> SessionInfo[]. Handles {data} and bare arrays. */
export function unwrapSessionList(res: any): any[] {
  const list = res?.data ?? res ?? [];
  return Array.isArray(list) ? list : [];
}

/** session.get output -> SessionInfo. v2 returns it directly (no .data wrap). */
export function unwrapSession(res: any): any {
  if (res && typeof res.id === 'string') return res;
  return res?.data ?? res ?? {};
}

/** session.create output -> new session id. */
export function unwrapSessionId(res: any): string {
  return unwrapSession(res)?.id || '';
}

/** Directory of a session object (v2 `location.directory`). */
export function sessionDirOf(s: any): string {
  return s?.location?.directory || s?.directory || '';
}

/**
 * message.list messages -> ascending by creation time.
 * The server's default order is oldest-first, so `limit` alone returns a
 * STALE window on long sessions; callers must pass `order: "desc"` and then
 * normalize here, so the logic below never depends on server ordering.
 */
export function sortMessagesAsc(msgs: any[]): any[] {
  const ms = (m: any) => {
    const t = m?.time?.created ?? m?.timeCreated ?? 0;
    const n = typeof t === 'number' ? t : Number(t);
    return Number.isFinite(n) ? n : 0;
  };
  return [...msgs].sort((a, b) => ms(a) - ms(b));
}
