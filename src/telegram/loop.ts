// Cross-instance loop: heartbeat, durable queue consumption, leader
// election, and leader-only duties (Telegram bot, error flush, external
// answer cleanup, menu updates). 1s cadence, reentrancy-guarded.
//
// Restart-safe by construction: job claims are durable (no in-memory
// dedupe), so a TUI restart can never replay a consumed job.
import {
  apiRef, bot, isLeader, setIsLeader, leaderInterval, setLeaderInterval,
  bindSetup, TelegramConfig,
} from '../core/runtime';
import { storeGet, storeSet, setTelegramStatus, cleanupStaleCacheFiles } from '../core/store';
import { electLeader, updateActiveProjects } from '../core/leader';
import { workdir } from '../core/ctx';
import { INSTANCE_ID } from '../core/runtime';
import { claimDue, ack, handleJob, takeSyncError, clearSyncError, reportError } from '../core/queue';
import { startTelegramBot, stopTelegramBot, notifyTelegram } from './bot';
import { triggerSessionsMenuUpdate } from '../core/store';
import { closeExternallyAnsweredQuestions } from './forms';

const QUESTION_CHECK_EVERY = 30;
const ERROR_FLUSH_STAMP_KEY = 'lastSyncErrorTimestamp';

let loopRunning = false;
let tick = 0;

async function loop() {
  if (loopRunning) return;
  loopRunning = true;
  try {
    const now = Date.now();
    updateActiveProjects();

    // Consume this instance's queued jobs.
    const dir = workdir();
    if (dir) {
      for (const job of claimDue(dir, INSTANCE_ID)) {
        try {
          await handleJob(job);
          ack(job.id);
        } catch {
          ack(job.id, 'failed'); // error already reported via reportError
        }
      }
    }

    // Leader menu-update trigger.
    if (isLeader) {
      try {
        const ts = storeGet<number>('menuUpdateTimestamp', 0);
        const last = storeGet<number>('lastMenuFlush', 0);
        if (ts > last) {
          storeSet('lastMenuFlush', now);
          triggerSessionsMenuUpdate();
        }
      } catch {}
    }

    // Election.
    let elected = false;
    try {
      elected = electLeader(now);
    } catch (e) {
      console.error('[Telegram] electLeader error:', e);
    }
    if (elected) {
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

    if (isLeader && bot) {
      // External answer cleanup (every ~30s).
      if (++tick % QUESTION_CHECK_EVERY === 0) {
        try {
          closeExternallyAnsweredQuestions();
        } catch (e) {
          console.error('[Telegram] closeExternallyAnsweredQuestions error:', e);
        }
      }
      // Flush execution errors to Telegram (clear-after-send).
      try {
        const err = takeSyncError();
        if (err && err.timestamp > storeGet<number>(ERROR_FLUSH_STAMP_KEY, 0)) {
          storeSet(ERROR_FLUSH_STAMP_KEY, err.timestamp);
          await notifyTelegram(`❌ ${err.action} failed: ${err.detail || 'unknown error'}`);
          clearSyncError();
        }
      } catch (e) {
        console.error('[Telegram] syncError flush failed:', e);
      }
    }
  } catch (e) {
    console.error('[Telegram] loop error:', e);
  } finally {
    loopRunning = false;
  }
}

/**
 * Plugin entry for the Telegram integration. Binds ctx (reloading config
 * every time, including hot reloads) and starts the loop once per setup.
 */
export function initTelegram(ctx: any) {
  const cfg: TelegramConfig | null = bindSetup(ctx);
  if (!cfg) {
    setTelegramStatus('missing');
    return;
  }
  setTelegramStatus('ok');
  cleanupStaleCacheFiles();
  if (!leaderInterval) {
    void loop();
    setLeaderInterval(setInterval(loop, 1000));
  }
}

export { apiRef };
