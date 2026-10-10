/** @jsxImportSource @opentui/solid */
import { Plugin } from "@opencode/plugin/tui";
import {
  initTelegram,
  saveSessionStatus,
  saveSessionModel,
  saveSessionAgent,
  savePromptStatus,
  savePromptResponse,
  notifySessionIdle,
  updatePromptResponseMeta,
  registerQuestionRequest,
  registerPermissionRequest,
  notifyTelegramQuestion,
  notifyTelegram,
  logDebug
} from "./telegram";
import { localRunStatus, localSessionTitle, pendingForms, pendingPermissions } from "./telegram/ctx";
import { pendingQuestions, permissionRequests, qfMap } from "./telegram/stores";
import { leaderInterval, setLeaderInterval, readSavedStatuses, isHeartbeatFresh } from "./telegram/state";
import { getStatusSignal } from "./tui/signals";
import { SessionSidebar } from "./tui/SessionSidebar";

const SHELL_TOOLS = ['bash', 'run_command', 'execute_command'];
const READ_TOOLS = ['read_file', 'view_file'];
const WRITE_TOOLS = ['write_file', 'create_file', 'edit_file', 'replace_file_content', 'multi_replace_file_content'];
const WEB_SEARCH_TOOLS = ['web_search', 'search_web'];

const firstKey = (input: Record<string, unknown>, keys: string[]): string =>
  String(keys.map(k => input[k]).find(Boolean) || '');

/** One-line Telegram status for a tool call, e.g. "⚡ `$ npm test`". */
function toolStatusLine(toolName: string, input: Record<string, unknown>): string {
  if (SHELL_TOOLS.includes(toolName)) {
    const cmd = firstKey(input, ['CommandLine', 'command', 'cmd']).split('\n')[0].slice(0, 120);
    return `⚡ \`$ ${cmd}\``;
  }
  if (READ_TOOLS.includes(toolName)) {
    return `📄 ${firstKey(input, ['path', 'file_path', 'AbsolutePath', 'filePath']).slice(0, 80) || toolName}`;
  }
  if (WRITE_TOOLS.includes(toolName)) {
    return `✏️ ${firstKey(input, ['path', 'file_path', 'TargetFile', 'filePath']).slice(0, 80) || toolName}`;
  }
  if (WEB_SEARCH_TOOLS.includes(toolName)) {
    return `🔍 ${firstKey(input, ['query', 'q']).slice(0, 80) || 'searching...'}`;
  }
  if (toolName === 'grep_search') {
    return `🔍 grep: ${firstKey(input, ['Query', 'query', 'pattern']).slice(0, 80)}`;
  }
  if (toolName === 'list_dir') {
    return `📁 ${firstKey(input, ['DirectoryPath', 'path', 'dir']).slice(0, 80) || toolName}`;
  }
  return `🔧 ${toolName}`;
}

export default Plugin.define({
  id: "opencode-session-tracker",
  setup(ctx) {
    logDebug('plugin loaded');
    try {
      initTelegram(ctx);
    } catch (e: any) {
      console.error("Telegram init error:", e);
    }

    const updateStatusSafe = (sessionID: string, baseType?: string) => {
      if (!sessionID) return;
      // Pending form/permission questions take precedence over the run status.
      let type = baseType || "idle";
      if (pendingForms(sessionID).length > 0) type = "ask";
      else if (pendingPermissions(sessionID).length > 0) type = "perm";

      const [, setStatus] = getStatusSignal(sessionID);
      setStatus(type);
      saveSessionStatus(sessionID, type);
    };

    // v2 events arrive as { type, data, ... }; unwrap once here.
    const onEvent = (name: string, handler: (payload: any) => void) => {
      try {
        (ctx.data.on as any)(name, (e: any) => handler(e?.data ?? e?.properties ?? e));
      } catch (err) {
        console.error(`[session-tracker] failed to subscribe to ${name}:`, err);
      }
    };

    onEvent("session.status", (payload) => {
      const st = payload?.status;
      const t = typeof st === "string" ? st : (st?.type || "idle");
      updateStatusSafe(payload?.sessionID, t === "running" ? "busy" : t);
    });

    onEvent("session.idle", (payload) => {
      const sId = payload?.sessionID;
      updateStatusSafe(sId, "idle");
      if (sId) notifySessionIdle(sId);
    });

    onEvent("session.model.selected", (payload) => {
      const sId = payload?.sessionID;
      const model = payload?.model;
      if (sId && model?.id && model?.providerID) {
        saveSessionModel(sId, model.providerID, model.id);
      }
    });

    onEvent("session.agent.selected", (payload) => {
      const sId = payload?.sessionID;
      const agent = payload?.agent;
      if (sId && agent) {
        saveSessionAgent(sId, agent);
      }
    });

    const sessionMeta = new Map<string, { agent?: string; model?: string; stepStartTime?: number; textBuf?: string }>();

    const getMeta = (sId: string) => sessionMeta.get(sId) || {};
    const resetTextBuf = (sId: string) => {
      const meta = getMeta(sId);
      meta.textBuf = '';
      sessionMeta.set(sId, meta);
    };

    onEvent("session.step.started", (payload) => {
      const sId = payload?.sessionID;
      if (!sId) return;
      const agent = payload?.agent || '';
      const model = payload?.model?.id || '';
      sessionMeta.set(sId, { agent, model, stepStartTime: Date.now(), textBuf: '' });
    });

    // tool.called carries no name in v2 — remember names from input.started by tool id.
    const toolNames = new Map<string, string>();

    onEvent("session.tool.input.started", (payload) => {
      const sId = payload?.sessionID;
      const name: string = payload?.name || '';
      if (!sId || !name) return;
      if (payload?.id) toolNames.set(String(payload.id), name);
      savePromptStatus(sId, `⚙️ ${name}...`);
    });

    onEvent("session.tool.called", (payload) => {
      const sId = payload?.sessionID;
      const toolName: string = toolNames.get(String(payload?.id || '')) || '';
      const input = (payload?.input || {}) as Record<string, unknown>;
      if (!sId || !toolName) return;

      resetTextBuf(sId);
      savePromptStatus(sId, toolStatusLine(toolName, input));
    });

    onEvent("session.reasoning.started", (payload) => {
      const sId = payload?.sessionID;
      if (!sId) return;
      resetTextBuf(sId);
      savePromptStatus(sId, '🧠 Thinking...');
    });

    onEvent("session.reasoning.delta", (payload) => {
      const sId = payload?.sessionID;
      if (!sId || !payload?.delta) return;
      savePromptStatus(sId, '🧠 Thinking...');
    });

    onEvent("session.text.started", (payload) => {
      const sId = payload?.sessionID;
      if (!sId) return;
      resetTextBuf(sId);
      savePromptStatus(sId, '💬 Writing...');
    });

    onEvent("session.text.delta", (payload) => {
      const sId = payload?.sessionID;
      const delta: string = payload?.delta || '';
      if (!sId || !delta) return;
      const meta = getMeta(sId);
      const buf = (meta.textBuf || '') + delta;
      meta.textBuf = buf;
      sessionMeta.set(sId, meta);
      savePromptStatus(sId, buf.length > 600 ? '...' + buf.slice(-600) : buf);
    });

    onEvent("session.text.ended", (payload) => {
      const sId = payload?.sessionID;
      if (!sId) return;
      const meta = getMeta(sId);
      const text = payload?.text || meta.textBuf || '';
      if (!text) return;

      const info: any = {};
      if (meta.agent) info.agent = meta.agent;
      if (meta.model) info.model = meta.model;
      const title = localSessionTitle(sId);
      if (title) info.title = title;
      if (meta.stepStartTime) info.duration = Math.round((Date.now() - meta.stepStartTime) / 1000);

      savePromptResponse(sId, text, info);
      savePromptStatus(sId, '✅ Done');
    });

    onEvent("session.step.ended", (payload) => {
      const sId = payload?.sessionID;
      if (!sId) return;
      const cost = Number(payload?.cost) || 0;
      const tokens = payload?.tokens || {};
      const totalTokens = (tokens?.input || 0) + (tokens?.output || 0) + (tokens?.reasoning || 0);
      if (cost > 0 || totalTokens > 0) {
        updatePromptResponseMeta(sId, cost > 0 ? cost : undefined, totalTokens > 0 ? totalTokens : undefined);
      }
    });

    // v2 replaced question.asked with form.created: { form: { id, sessionID, title, fields } }
    onEvent("form.created", (payload) => {
      const form = payload?.form || {};
      const sessionID = form.sessionID || payload?.sessionID;
      if (!sessionID || !form.id) return;
      updateStatusSafe(sessionID, "ask");
      registerQuestionRequest(sessionID, form.id);
      const title = localSessionTitle(sessionID) || sessionID.slice(0, 8);
      notifyTelegramQuestion(form.id, sessionID, form.fields || [], title);
    });

    const clearQuestionFlow = (formId: string, sessionID: string) => {
      if (!sessionID) return;
      qfMap.delete(formId);
      pendingQuestions.delete(sessionID);
      updateStatusSafe(sessionID, localRunStatus(sessionID) === "running" ? "busy" : "idle");
    };

    onEvent("form.replied", (payload) => {
      clearQuestionFlow(payload?.id, payload?.sessionID);
    });

    onEvent("form.cancelled", (payload) => {
      clearQuestionFlow(payload?.id, payload?.sessionID);
    });

    onEvent("permission.asked", (payload) => {
      if (!payload?.sessionID) return;
      updateStatusSafe(payload.sessionID, "perm");
      const permId = payload.id;
      const shortId = registerPermissionRequest(payload.sessionID, permId);
      const title = localSessionTitle(payload.sessionID) || payload.sessionID.slice(0, 8);
      const desc = payload.message
        || (payload.action ? `${payload.action}: ${(payload.resources || []).join(', ')}` : 'Approve action?');
      notifyTelegram(`🔐 **Permission Requested**\nSeans \`${title}\` is asking for permission.\n\n${desc}`.slice(0, 1000), [
        { text: "✅ Allow", callback_data: `perm_allow_${shortId}` },
        { text: "❌ Deny", callback_data: `perm_deny_${shortId}` }
      ]);
    });

    onEvent("permission.replied", (payload) => {
      if (!payload?.sessionID) return;
      for (const [shortId, req] of permissionRequests.entries()) {
        if (req.permId === payload.requestID) permissionRequests.delete(shortId);
      }
      updateStatusSafe(payload.sessionID, localRunStatus(payload.sessionID) === "running" ? "busy" : "idle");
    });

    ctx.ui.slot({
      append: "sidebar.content",
      render: (input) => <SessionSidebar sessionID={input.sessionID} ctx={ctx} />
    });

    // A missed idle event (hot-reload mid-run, crash, dropped event) wedges
    // badges at RUN: the live store is authoritative for sessions this
    // instance knows, otherwise the owning instance's heartbeat decides.
    const ACTIVE_STATUSES = new Set(["busy", "running", "retry", "waiting"]);
    const reconcileStaleStatuses = async () => {
      let saved: Record<string, { status: string; dir?: string; timestamp?: number }>;
      try {
        saved = readSavedStatuses();
      } catch { return; }
      const ids = Object.keys(saved).filter((id) => ACTIVE_STATUSES.has(saved[id]?.status));
      for (const id of ids) {
        try {
          let live = "idle";
          try { live = localRunStatus(id); } catch {}
          if (live === "running" || live === "busy") continue;
          let known = false;
          try { known = !!(ctx as any).data?.session?.get?.(id); } catch {}
          if (known) {
            updateStatusSafe(id, "idle"); // rewrites disk + signal
            continue;
          }
          // Unknown locally: only trust it while the owning instance is alive.
          let dir = saved[id]?.dir || "";
          let hbFresh = dir ? isHeartbeatFresh(dir) : false;
          if (!dir || !hbFresh) {
            // Last resort: ask the server whether the session still exists.
            try {
              const s: any = await (ctx as any).client?.session?.get?.({ sessionID: id });
              const srvDir = s?.location?.directory || s?.directory || "";
              if (srvDir) {
                dir = srvDir;
                hbFresh = isHeartbeatFresh(srvDir);
              } else if (s?.id) {
                continue; // session exists but owner unknown — don't touch
              } else {
                updateStatusSafe(id, "idle");
                continue;
              }
            } catch {
              updateStatusSafe(id, "idle"); // session gone from server
              continue;
            }
          }
          if (!hbFresh) updateStatusSafe(id, "idle");
        } catch {}
      }
    };
    reconcileStaleStatuses();
    const reconcileInterval = setInterval(reconcileStaleStatuses, 10000);

    // Clears the Telegram sync loop on plugin hot-reload; setup re-creates it.
    return () => {
      try {
        clearInterval(reconcileInterval);
      } catch (e) {}
      try {
        if (leaderInterval) clearInterval(leaderInterval);
      } catch (e) {}
      try {
        setLeaderInterval(null);
      } catch (e) {}
    };
  },
});
