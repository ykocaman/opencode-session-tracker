// OpenCode v2 accessors shared by the Telegram integration.
//
// The plugin context (`ctx`) is stored as `apiRef` (see state.ts) so existing
// call sites keep working. These helpers translate the v1 access patterns
// (`api.state.path.directory`, `api.state.session.*`, `api.route.*`) to their
// v2 equivalents (`ctx.data.*`, `ctx.ui.router.*`), with best-effort
// fallbacks so nothing throws when the local store has no data.
import { apiRef } from './state';

/** Working directory of this TUI instance. */
export function workdir(): string {
  try {
    const dir = apiRef?.data?.location?.default?.()?.directory;
    if (dir) return dir;
  } catch (e) {}
  try {
    const dir = apiRef?.state?.path?.directory;
    if (dir) return dir;
  } catch (e) {}
  return '';
}

/** Pending form (question) requests for a session, from the local store. */
export function pendingForms(sessionId: string): any[] {
  try {
    return apiRef?.data?.session?.form?.list?.(sessionId) || [];
  } catch (e) {
    return [];
  }
}

/** Pending permission requests for a session, from the local store. */
export function pendingPermissions(sessionId: string): any[] {
  try {
    return apiRef?.data?.session?.permission?.list?.(sessionId) || [];
  } catch (e) {
    return [];
  }
}

/** 'idle' | 'running' (v2 vocabulary) for a session, never throws. */
export function localRunStatus(sessionId: string): string {
  try {
    return apiRef?.data?.session?.status?.(sessionId) || 'idle';
  } catch (e) {
    return 'idle';
  }
}

/** Session title from the local store, '' when unknown. */
export function localSessionTitle(sessionId: string): string {
  try {
    return apiRef?.data?.session?.get?.(sessionId)?.title || '';
  } catch (e) {
    return '';
  }
}

/** Directory a session belongs to: local store first, then the API. */
export async function sessionDirectory(sessionId: string): Promise<string> {
  try {
    const dir = apiRef?.data?.session?.get?.(sessionId)?.location?.directory;
    if (dir) return dir;
  } catch (e) {}
  try {
    const s = unwrapSession(await apiRef?.client?.session?.get({ sessionID: sessionId }));
    if (s?.location?.directory) return s.location.directory;
  } catch (e) {}
  return workdir();
}

export function navigateHome() {
  try {
    if (apiRef?.ui?.router?.navigate) return apiRef.ui.router.navigate({ type: 'home' });
    return apiRef?.route?.navigate('home');
  } catch (e) {}
}

export function navigateSession(sessionId: string) {
  try {
    if (apiRef?.ui?.router?.navigate) return apiRef.ui.router.navigate({ type: 'session', sessionID: sessionId });
    return apiRef?.route?.navigate('session', { sessionID: sessionId });
  } catch (e) {}
}

/** Current route as { type: 'home' | 'session', sessionID? }. */
export function currentRoute(): { type: string; sessionID?: string } {
  try {
    if (apiRef?.ui?.router?.current) {
      const r = apiRef.ui.router.current();
      if (r) return r;
    }
  } catch (e) {}
  try {
    const r = apiRef?.route?.current;
    if (r) return { type: r.name, sessionID: r.params?.sessionID };
  } catch (e) {}
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

/** Directory of a session object (v2 `location.directory`, v1 `directory`). */
export function sessionDirOf(s: any): string {
  return s?.location?.directory || s?.directory || '';
}
