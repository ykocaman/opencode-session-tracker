import fs from 'fs';
import {
  bot, apiRef, setApiRef, isLeader, setIsLeader, leaderInterval, setLeaderInterval,
  LOCK_FILE, INSTANCE_ID, readState, updateState, loadConfig, updateActiveProjects,
  triggerSessionsMenuUpdate,
} from './state';
import { startTelegramBot, stopTelegramBot, notifyTelegram } from './bot';
import { closeFlowAnsweredInTerminal, answerFlowWithText } from './questions';
import { pendingQuestions, qfMap, updateCurrentSessionId, buildPromptOpts } from './stores';
import { workdir, navigateHome, navigateSession, pendingForms, unwrapSessionId } from './ctx';

const LOCK_TTL_MS = 15000;
const LOCK_PID_CHECK_EVERY = 15; // ticks
const QUESTION_CHECK_EVERY = 30; // ticks

let lastSyncTimestamp = 0;
let lastSyncErrorTimestamp = 0;
let lastMenuUpdateTimestamp = 0;
let syncLoopRunning = false;
let lockCheckTick = 0;
let questionFlowCheckTick = 0;

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (e: any) { return e.code === 'EPERM'; }
}

function claimLock(now: number) {
  fs.writeFileSync(LOCK_FILE, JSON.stringify({ id: INSTANCE_ID, pid: process.pid, timestamp: now }));
}

function readLock(): any {
  if (!fs.existsSync(LOCK_FILE)) return null;
  try { return JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8')); } catch (e) { return null; }
}

/** Records a cross-instance delivery failure so the leader can report it to Telegram. */
function reportSyncError(action: string, err: any) {
  try {
    const detail = String(err?.message || err).slice(0, 300);
    updateState('syncError', { action, detail, timestamp: Date.now() });
  } catch (e) {}
}

/** Handles a command another instance (the Telegram leader) queued for this directory. */
function handleSyncCommand(syncData: any) {
  const sId = syncData.sessionId;
  const dir = workdir();

  switch (syncData.type) {
    case 'navigate':
      updateCurrentSessionId(sId);
      if (sId === null) navigateHome();
      else navigateSession(sId);
      break;

    case 'prompt':
      if (sId) {
        const formId = pendingQuestions.get(sId);
        if (formId && answerFlowWithText(sId, formId, syncData.text)) {
          pendingQuestions.delete(sId);
        } else {
          updateCurrentSessionId(sId);
          navigateSession(sId);
          apiRef.client.session.prompt(buildPromptOpts(sId, syncData.text)).catch((e: any) => {
            reportSyncError(`prompt "${syncData.text}"`, e);
          });
        }
      } else {
        apiRef.client.session.create({ location: { directory: dir } }).then((createRes: any) => {
          const newSessionId = unwrapSessionId(createRes);
          if (!newSessionId) return;
          updateCurrentSessionId(newSessionId);
          navigateSession(newSessionId);
          updateState('createdSession', { sessionId: newSessionId, timestamp: Date.now() });
          apiRef.client.session.prompt(buildPromptOpts(newSessionId, syncData.text)).catch((e: any) => {
            reportSyncError(`prompt "${syncData.text}"`, e);
          });
        }).catch((e: any) => {
          reportSyncError('create session', e);
        });
      }
      break;

    case 'model_change':
      if (sId) {
        apiRef.client.session.switchModel({
          sessionID: sId,
          model: { id: syncData.modelID, providerID: syncData.providerID },
        }).catch((e: any) => {
          reportSyncError('model change', e);
        });
      }
      break;

    case 'agent_change':
      if (sId) {
        apiRef.client.session.switchAgent({ sessionID: sId, agent: syncData.agent }).catch((e: any) => {
          reportSyncError('agent change', e);
        });
      }
      break;
  }
}

/** Lock-file leader election; returns whether this instance should run the bot. */
function electLeader(now: number): boolean {
  const lockData = readLock();
  const lockExpired = !lockData || now - lockData.timestamp > LOCK_TTL_MS;

  if (lockData?.id === INSTANCE_ID || lockExpired) {
    claimLock(now);
    return true;
  }
  if (++lockCheckTick % LOCK_PID_CHECK_EVERY === 0 && !alive(lockData.pid)) {
    claimLock(now);
    return true;
  }
  return false;
}

/** Closes Telegram messages of questions that were answered externally (terminal). */
function closeExternallyAnsweredQuestions() {
  for (const [requestId, flow] of qfMap.entries()) {
    if (!flow.chatId || !flow.messageId) continue;
    try {
      const pending = pendingForms(flow.sessionId);
      if (pending.some((f: any) => f.id === requestId)) continue;

      closeFlowAnsweredInTerminal(flow);
      qfMap.delete(requestId);
      pendingQuestions.delete(flow.sessionId);
    } catch (e) {
      // skip on error (e.g. session gone, API not available)
    }
  }
}

async function syncLoop() {
  if (syncLoopRunning) return;
  syncLoopRunning = true;
  try {
    const now = Date.now();
    updateActiveProjects();
    const state = readState();

    const syncData = state.sync;
    if (syncData && syncData.timestamp > lastSyncTimestamp) {
      lastSyncTimestamp = syncData.timestamp;
      // consumedAt: a (re)starting instance must not replay an already-handled command.
      if (!syncData.consumedAt && syncData.targetDir === workdir()) {
        handleSyncCommand(syncData);
        try {
          const cur = readState();
          if (cur.sync && cur.sync.timestamp === syncData.timestamp && !cur.sync.consumedAt) {
            updateState('sync', { ...syncData, consumedAt: Date.now(), consumedBy: INSTANCE_ID });
          }
        } catch (e) {}
      }
    }

    if (isLeader && state.menuUpdateTimestamp && state.menuUpdateTimestamp > lastMenuUpdateTimestamp) {
      lastMenuUpdateTimestamp = state.menuUpdateTimestamp;
      triggerSessionsMenuUpdate();
    }

    if (electLeader(now)) {
      if (!isLeader) {
        setIsLeader(true);
        startTelegramBot();
      } else if (!bot) {
        startTelegramBot();
      }
    } else if (isLeader) {
      setIsLeader(false);
      stopTelegramBot();
    }

    if (isLeader && bot && ++questionFlowCheckTick % QUESTION_CHECK_EVERY === 0) {
      closeExternallyAnsweredQuestions();
    }

    const syncErr: any = state.syncError;
    if (isLeader && bot && syncErr && syncErr.timestamp > lastSyncErrorTimestamp) {
      lastSyncErrorTimestamp = syncErr.timestamp;
      try { notifyTelegram(`❌ ${syncErr.action} failed: ${syncErr.detail || 'unknown error'}`); } catch (e) {}
      try { updateState('syncError', null); } catch (e) {}
    }
  } catch (e) {
    console.error('[Telegram] syncLoop error:', e);
  } finally {
    syncLoopRunning = false;
  }
}

export function initTelegram(api: any) {
  setApiRef(api);
  const config = loadConfig();
  if (!config) {
    updateState('telegramStatus', 'missing');
    return;
  }

  if (!leaderInterval) {
    syncLoop();
    setLeaderInterval(setInterval(syncLoop, 1000));
  }
}
