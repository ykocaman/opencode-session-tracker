// Shared session/request context: durable question + permission maps,
// target/active session tracking, prompt option builders.
import { apiRef, activeProjectDir, selectedModel } from './runtime';
import { createStore, storeGet, storeSet, triggerSessionsMenuUpdate } from './store';
import { workdir } from './ctx';

export interface QuestionFlow {
  requestId: string; // v2 form id
  sessionId: string;
  questions: any[]; // adapted fields: { key, question, options?: [{ value, label }], userAnswer }
  currentIndex: number;
  messageId?: number;
  chatId?: number;
  title: string;
}

export interface PermissionRequest {
  sessionId: string;
  permId: string;
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
    const dir = activeProjectDir || apiRef?.data?.location?.default?.()?.directory;
    if (dir) return dir;
  } catch {}
  return activeProjectDir || '';
}

/** Active session id for a directory (defaults to the current target dir). */
export function getActiveSessionId(dir: string = getTargetDir()): string | null {
  try {
    return storeGet<Record<string, string | null>>('activeSessions', {})[dir] || null;
  } catch {
    return null;
  }
}

export function setActiveSessionId(dir: string, sessionId: string | null) {
  try {
    const all = storeGet<Record<string, string | null>>('activeSessions', {});
    all[dir] = sessionId;
    storeSet('activeSessions', all);
  } catch {}
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
  const dir = workdir();
  if (!dir) return;
  try {
    const all = storeGet<Record<string, string | null>>('activeSessions', {});
    if (all[dir] !== id) {
      all[dir] = id;
      storeSet('activeSessions', all);
      triggerSessionsMenuUpdate();
    }
  } catch {}
}
