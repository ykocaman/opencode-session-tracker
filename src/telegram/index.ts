import { 
  initTelegram as init, 
  stopTelegramBot,
  updateCurrentSessionId as updateId, 
  notifyTelegram as notify, 
  notifyTelegramQuestion as notifyQuestion, 
  registerQuestionRequest as regQuestion, 
  registerPermissionRequest as regPerm
} from './bot';

import {
  saveSessionStatus,
  saveSessionModel,
  saveSessionAgent,
  savePromptStatus,
  savePromptResponse,
  updatePromptResponseMeta,
  getPromptStatusPath,
  triggerSessionsMenuUpdate,
  logDebug as debug
} from './state';

import { readState } from './state';

export {
  saveSessionStatus,
  saveSessionModel,
  saveSessionAgent,
  savePromptStatus,
  savePromptResponse,
  updatePromptResponseMeta,
  getPromptStatusPath,
  triggerSessionsMenuUpdate
};

export {
  notifySessionIdle
} from './tracking';

export const initTelegram = init;
export const getTelegramStatus = () => {
  try {
    const configPath = require('path').join(require('os').homedir(), '.config', 'opencode', 'telegram.json');
    if (!require('fs').existsSync(configPath)) return 'missing';
    const state = readState();
    return state.telegramStatus || 'ok';
  } catch(e) {
    return 'failed';
  }
};

export const updateCurrentSessionId = updateId;
export const notifyTelegram = notify;
export const notifyTelegramQuestion = notifyQuestion;
export const registerQuestionRequest = regQuestion;
export const registerPermissionRequest = regPerm;
export const logDebug = debug;
