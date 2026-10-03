import fs from 'fs';
import {
  bot, apiRef, setApiRef, isLeader, setIsLeader, leaderInterval, setLeaderInterval,
  LOCK_FILE, INSTANCE_ID, readState, updateState, loadConfig, updateActiveProjects,
  triggerSessionsMenuUpdate,
} from './state';
import { startTelegramBot, stopTelegramBot } from './bot';
import { closeFlowAnsweredInTerminal } from './questions';
import { pendingQuestions, qfMap, updateCurrentSessionId, buildPromptOpts } from './stores';

const LOCK_TTL_MS = 15000;
const LOCK_PID_CHECK_EVERY = 15; // ticks
const QUESTION_CHECK_EVERY = 30; // ticks

let lastSyncTimestamp = 0;
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

/** Handles a command another instance (the Telegram leader) queued for this directory. */
function handleSyncCommand(syncData: any) {
  const sId = syncData.sessionId;
  const dir = apiRef.state.path.directory;

  switch (syncData.type) {
    case 'navigate':
      updateCurrentSessionId(sId);
      if (sId === null) apiRef.route.navigate('home');
      else apiRef.route.navigate('session', { sessionID: sId });
      break;

    case 'prompt':
      if (sId) {
        const requestId = pendingQuestions.get(sId);
        if (requestId) {
          apiRef.client.question.reply({ requestID: requestId, answers: [[syncData.text]] }).catch(() => {});
          pendingQuestions.delete(sId);
        } else {
          updateCurrentSessionId(sId);
          apiRef.route.navigate('session', { sessionID: sId });
          apiRef.client.session.prompt(buildPromptOpts(sId, syncData.text, syncData.model)).catch(() => {});
        }
      } else {
        apiRef.client.session.create({ directory: dir }).then((createRes: any) => {
          const newSessionId = createRes.data?.id || createRes.id;
          if (!newSessionId) return;
          updateCurrentSessionId(newSessionId);
          apiRef.route.navigate('session', { sessionID: newSessionId });
          updateState('createdSession', { sessionId: newSessionId, timestamp: Date.now() });
          apiRef.client.session.prompt(buildPromptOpts(newSessionId, syncData.text, syncData.model)).catch(() => {});
        }).catch(() => {});
      }
      break;

    case 'model_change':
      if (sId) {
        apiRef.client.session.switchModel({
          sessionID: sId,
          model: { id: syncData.modelID, providerID: syncData.providerID },
        }).catch(() => {});
      }
      break;

    case 'agent_change':
      if (sId) {
        apiRef.client.session.switchAgent({ sessionID: sId, agent: syncData.agent }).catch(() => {});
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
      const pendingQs = apiRef?.state?.session?.question?.(flow.sessionId);
      if (pendingQs && pendingQs.length > 0) continue;

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
      if (syncData.targetDir === apiRef.state.path.directory) handleSyncCommand(syncData);
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
