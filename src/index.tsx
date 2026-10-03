/** @jsxImportSource @opentui/solid */
import type { TuiPlugin, TuiPluginModule } from "@opencode-ai/plugin/tui";
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

const tui: TuiPlugin = async (api) => {
  logDebug('plugin loaded');
  try {
    initTelegram(api);
  } catch (e: any) {
    console.error("Telegram init error:", e);
  }

  const updateStatusSafe = (sessionID: string, baseType?: string) => {
    if (!sessionID) return;
    const questions = api.state.session.question(sessionID) || [];
    const permissions = api.state.session.permission(sessionID) || [];
    
    let type = baseType || "idle";
    if (questions.length > 0) type = "ask";
    else if (permissions.length > 0) type = "perm";
    
    const [, setStatus] = getStatusSignal(sessionID);
    setStatus(type);
    saveSessionStatus(sessionID, type);
  };

  // Most events wrap their data in `data` or `properties`; unwrap once here.
  const onEvent = (name: string, handler: (payload: any) => void) =>
    api.event.on(name as any, (e: any) => handler(e.data || e.properties || e));

  onEvent("session.status", (payload) => {
    const st = payload?.status;
    updateStatusSafe(payload?.sessionID, typeof st === "string" ? st : (st?.type || "idle"));
  });
  
  onEvent("session.idle", (payload) => {
    const sId = payload?.sessionID;
    updateStatusSafe(sId, "idle");
    if (sId) notifySessionIdle(sId);
  });
  
  onEvent("session.next.model.switched", (payload) => {
    const sId = payload?.sessionID;
    const model = payload?.model;
    if (sId && model?.id && model?.providerID) {
      saveSessionModel(sId, model.providerID, model.id);
    }
  });

  onEvent("session.next.agent.switched", (payload) => {
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

  onEvent("session.next.step.started", (payload) => {
    const sId = payload?.sessionID;
    if (!sId) return;
    const agent = payload?.agent || '';
    const model = payload?.model?.modelID || payload?.model?.id || '';
    sessionMeta.set(sId, { agent, model, stepStartTime: Date.now(), textBuf: '' });
  });

  onEvent("session.next.tool.input.started", (payload) => {
    const sId = payload?.sessionID;
    const name: string = payload?.name || '';
    if (!sId || !name) return;
    savePromptStatus(sId, `⚙️ ${name}...`);
  });

  onEvent("session.next.tool.called", (payload) => {
    const sId = payload?.sessionID;
    const toolName: string = payload?.tool || payload?.name || '';
    const input = (payload?.input || payload?.arguments || {}) as Record<string, unknown>;
    if (!sId || !toolName) return;

    resetTextBuf(sId);
    savePromptStatus(sId, toolStatusLine(toolName, input));
  });

  onEvent("session.next.reasoning.started", (payload) => {
    const sId = payload?.sessionID;
    if (!sId) return;
    resetTextBuf(sId);
    savePromptStatus(sId, '🧠 Thinking...');
  });

  onEvent("session.next.reasoning.delta", (payload) => {
    const sId = payload?.sessionID;
    if (!sId || !payload?.delta) return;
    savePromptStatus(sId, '🧠 Thinking...');
  });

  onEvent("session.next.text.started", (payload) => {
    const sId = payload?.sessionID;
    if (!sId) return;
    resetTextBuf(sId);
    savePromptStatus(sId, '💬 Writing...');
  });

  onEvent("session.next.text.delta", (payload) => {
    const sId = payload?.sessionID;
    const delta: string = payload?.delta || '';
    if (!sId || !delta) return;
    const meta = getMeta(sId);
    const buf = (meta.textBuf || '') + delta;
    meta.textBuf = buf;
    sessionMeta.set(sId, meta);
    savePromptStatus(sId, buf.length > 600 ? '...' + buf.slice(-600) : buf);
  });

  onEvent("session.next.text.ended", (payload) => {
    const sId = payload?.sessionID;
    if (!sId) return;
    const meta = getMeta(sId);
    const text = payload?.text || meta.textBuf || '';
    if (!text) return;

    const sessionData = api.state.session.get(sId);
    const info: any = {};
    if (meta.agent) info.agent = meta.agent;
    if (meta.model) info.model = meta.model;
    if (sessionData?.title) info.title = sessionData.title;
    if (meta.stepStartTime) info.duration = Math.round((Date.now() - meta.stepStartTime) / 1000);

    savePromptResponse(sId, text, info);
    savePromptStatus(sId, '✅ Done');
  });

  onEvent("session.next.step.ended", (payload) => {
    const sId = payload?.sessionID;
    if (!sId) return;
    const cost = payload?.cost || 0;
    const tokens = payload?.tokens || {};
    const totalTokens = (tokens?.input || payload?.tokens_input || payload?.tokensInput || 0) + (tokens?.output || payload?.tokens_output || payload?.tokensOutput || 0) + (tokens?.reasoning || 0);
    if (cost > 0 || totalTokens > 0) {
      updatePromptResponseMeta(sId, cost > 0 ? cost : undefined, totalTokens > 0 ? totalTokens : undefined);
    }
  });

  // Helper to handle both question.asked and question.v2.asked
  function handleQuestionAsked(e: any, isV2: boolean) {
    const props = e.properties || e.data || {};
    if (props.sessionID && props.questions?.length > 0) {
      updateStatusSafe(props.sessionID, "ask");
      const requestId = props.id;
      registerQuestionRequest(props.sessionID, requestId);
      const title = api.state.session.get(props.sessionID)?.title || props.sessionID.slice(0,8);
      notifyTelegramQuestion(requestId, props.sessionID, props.questions, title, isV2);
    }
  }

  api.event.on("question.asked", (e: any) => handleQuestionAsked(e, false));
  api.event.on("question.v2.asked", (e: any) => handleQuestionAsked(e, true));

  api.event.on("permission.asked", (e: any) => {
    if (e.properties?.sessionID) {
      updateStatusSafe(e.properties.sessionID, "perm");
      const permId = e.properties.id;
      const shortId = registerPermissionRequest(e.properties.sessionID, permId);
      const title = api.state.session.get(e.properties.sessionID)?.title || e.properties.sessionID.slice(0,8);
      notifyTelegram(`🔐 **Permission Requested**\nSeans \`${title}\` is asking for permission.\n\n${e.properties.permission || "Approve action?"}`, [
        { text: "✅ Allow", callback_data: `perm_allow_${shortId}` },
        { text: "❌ Deny", callback_data: `perm_deny_${shortId}` }
      ]);
    }
  });

  api.slots.register({
    order: 10,
    slots: {
      sidebar_content: (_context, props) => <SessionSidebar {...(props as any)} api={api} />
    }
  });
};

const plugin: TuiPluginModule & { id: string } = {
  id: "opencode-session-tracker",
  tui,
};

export default plugin;
