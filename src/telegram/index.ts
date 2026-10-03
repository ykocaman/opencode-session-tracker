import fs from 'fs';
import os from 'os';
import path from 'path';
import { readState } from './state';

export {
  saveSessionStatus,
  saveSessionModel,
  saveSessionAgent,
  savePromptStatus,
  savePromptResponse,
  updatePromptResponseMeta,
  getPromptStatusPath,
  triggerSessionsMenuUpdate,
  getArchivedSessions,
  archiveSession,
  logDebug,
} from './state';

export { notifySessionIdle } from './tail';
export { notifyTelegram } from './bot';
export { initTelegram } from './sync';
export { updateCurrentSessionId, registerQuestionRequest, registerPermissionRequest } from './stores';
export { notifyTelegramQuestion } from './questions';

export const getTelegramStatus = () => {
  try {
    const configPath = path.join(os.homedir(), '.config', 'opencode', 'telegram.json');
    if (!fs.existsSync(configPath)) return 'missing';
    return readState().telegramStatus || 'ok';
  } catch (e) {
    return 'failed';
  }
};
