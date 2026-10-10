import { apiRef, activeProjectDir, readState, writeState, triggerSessionsMenuUpdate, selectedModel } from './state';

export interface QuestionFlow {
  requestId: string; // v2 form id
  sessionId: string;
  questions: any[]; // adapted form fields (see questions.ts)
  currentIndex: number;
  messageId?: number;
  chatId?: number;
  title: string;
}

export interface PermissionRequest {
  sessionId: string;
  permId: string;
}

type StoreKey = 'permissionRequests' | 'pendingQuestions' | 'qfMap';

// Disk-backed key/value map stored under a top-level key of the shared state file.
// Every operation re-reads the state so multiple OpenCode instances stay in sync.
function createStore<V>(key: StoreKey) {
  const read = (): Record<string, V> => readState()[key] || {};
  return {
    get(k: string): V | undefined {
      try { return read()[k]; } catch (e) { return undefined; }
    },
    set(k: string, val: V) {
      try {
        const state = readState();
        state[key] = state[key] || {};
        state[key][k] = val;
        writeState(state);
      } catch (e) {}
    },
    delete(k: string): boolean {
      try {
        const state = readState();
        if (state[key] && k in state[key]) {
          delete state[key][k];
          writeState(state);
          return true;
        }
      } catch (e) {}
      return false;
    },
    entries(): [string, V][] {
      try { return Object.entries(read()); } catch (e) { return []; }
    },
    values(): V[] {
      try { return Object.values(read()); } catch (e) { return []; }
    },
  };
}

export const permissionRequests = createStore<PermissionRequest>('permissionRequests');
export const pendingQuestions = createStore<string>('pendingQuestions');
export const qfMap = createStore<QuestionFlow>('qfMap');

export function registerQuestionRequest(sessionId: string, requestId: string) {
  pendingQuestions.set(sessionId, requestId);
}

export function registerPermissionRequest(sessionId: string, permId: string): string {
  const shortId = Math.random().toString(36).substring(2, 10);
  permissionRequests.set(shortId, { sessionId, permId });
  return shortId;
}

/** Directory the Telegram user is currently operating on. */
export function getTargetDir(): string {
  try {
    const dir = activeProjectDir || apiRef?.data?.location?.default?.()?.directory || apiRef?.state?.path?.directory;
    if (dir) return dir;
  } catch (e) {}
  return activeProjectDir || '';
}

/** Active session id for a directory (defaults to the current target dir). */
export function getActiveSessionId(dir: string = getTargetDir()): string | null {
  try { return readState().activeSessions?.[dir] || null; } catch (e) { return null; }
}

export function setActiveSessionId(dir: string, sessionId: string | null) {
  const state = readState();
  state.activeSessions = state.activeSessions || {};
  state.activeSessions[dir] = sessionId;
  writeState(state);
}

export function getSelectedModelRef(): { providerID: string; modelID: string } | undefined {
  return selectedModel ? { providerID: selectedModel.providerID, modelID: selectedModel.modelID } : undefined;
}

export function buildPromptOpts(sessionId: string, text: string) {
  // v2 session.prompt takes flat { sessionID, text } — no parts[] or model override.
  return { sessionID: sessionId, text };
}

/** Records the session currently shown in this instance's TUI. */
export function updateCurrentSessionId(id: string | null) {
  if (id === null) return;
  let dir = '';
  try {
    dir = apiRef?.data?.location?.default?.()?.directory || apiRef?.state?.path?.directory || '';
  } catch (e) {}
  if (!dir) return;
  try {
    const state = readState();
    const activeSessions = state.activeSessions || {};
    if (activeSessions[dir] !== id) {
      activeSessions[dir] = id;
      state.activeSessions = activeSessions;
      writeState(state);
      triggerSessionsMenuUpdate();
    }
  } catch (e) {}
}
