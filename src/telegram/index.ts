import fs from 'fs';
import os from 'os';
import path from 'path';
import { storeGet } from '../core/store';

export {
  saveSessionStatus,
  saveSessionModel,
  saveSessionAgent,
  savePromptStatus,
  savePromptResponse,
  updatePromptResponseMeta,
  getPromptStatusPath,
  getArchivedSessions,
  archiveSession,
} from '../core/status';
export { triggerSessionsMenuUpdate } from '../core/store';
export { logDebug } from '../core/runtime';

export { notifyTelegram } from './bot';
export { initTelegram } from './loop';
export { updateCurrentSessionId, registerQuestionRequest, registerPermissionRequest } from '../core/context';
export { notifyTelegramQuestion } from './forms';

export const getTelegramStatus = () => {
  try {
    const configPath = path.join(os.homedir(), '.config', 'opencode', 'telegram.json');
    if (!fs.existsSync(configPath)) return 'missing';
    return storeGet<string>('telegramStatus', 'ok') || 'ok';
  } catch {
    return 'failed';
  }
};
