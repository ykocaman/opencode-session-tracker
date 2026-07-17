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

  api.event.on("session.status", (e: any) => {
    const payload = e.data || e.properties || e;
    const st = payload?.status;
    updateStatusSafe(payload?.sessionID, typeof st === "string" ? st : (st?.type || "idle"));
  });
  
  api.event.on("session.idle", (e: any) => {
    const payload = e.data || e.properties || e;
    const sId = payload?.sessionID;
    updateStatusSafe(sId, "idle");
    if (sId) notifySessionIdle(sId);
  });
  
  api.event.on("session.next.model.switched", (e: any) => {
    const payload = e.data || e.properties || e;
    const sId = payload?.sessionID;
    const model = payload?.model;
    if (sId && model?.id && model?.providerID) {
      saveSessionModel(sId, model.providerID, model.id);
    }
  });
  
  api.event.on("session.next.agent.switched", (e: any) => {
    const payload = e.data || e.properties || e;
    const sId = payload?.sessionID;
    const agent = payload?.agent;
    if (sId && agent) {
      saveSessionAgent(sId, agent);
    }
  });
  
  const sessionMeta = new Map<string, { agent?: string; model?: string; stepStartTime?: number; textBuf?: string }>();

  api.event.on("session.next.step.started", (e: any) => {
    const payload = e.data || e.properties || e;
    const sId = payload?.sessionID;
    if (!sId) return;
    const agent = payload?.agent || '';
    const model = (payload?.model as any)?.modelID || (payload?.model as any)?.id || '';
    sessionMeta.set(sId, { agent, model, stepStartTime: Date.now(), textBuf: '' });
  });

  api.event.on("session.next.tool.input.started", (e: any) => {
    const payload = e.data || e.properties || e;
    const sId = payload?.sessionID;
    const name: string = payload?.name || '';
    if (!sId || !name) return;
    savePromptStatus(sId, `⚙️ ${name}...`);
  });

  api.event.on("session.next.tool.called", (e: any) => {
    const payload = e.data || e.properties || e;
    const sId = payload?.sessionID;
    const toolName: string = payload?.tool || payload?.name || '';
    const inputObj = (payload?.input || payload?.arguments || {}) as Record<string, unknown>;
    if (!sId || !toolName) return;

    let inputLabel = '';
    if (toolName === 'bash' || toolName === 'run_command' || toolName === 'execute_command') {
      inputLabel = String(inputObj.CommandLine || inputObj.command || inputObj.cmd || '').split('\n')[0].slice(0, 120);
    } else if (toolName === 'read_file' || toolName === 'view_file') {
      inputLabel = String(inputObj.path || inputObj.file_path || inputObj.AbsolutePath || inputObj.filePath || '').slice(0, 80);
    } else if (toolName === 'write_file' || toolName === 'create_file' || toolName === 'edit_file'
               || toolName === 'replace_file_content' || toolName === 'multi_replace_file_content') {
      inputLabel = String(inputObj.path || inputObj.file_path || inputObj.TargetFile || inputObj.filePath || '').slice(0, 80);
    } else if (toolName === 'web_search' || toolName === 'search_web') {
      inputLabel = String(inputObj.query || inputObj.q || '').slice(0, 80);
    } else if (toolName === 'grep_search') {
      inputLabel = String(inputObj.Query || inputObj.query || inputObj.pattern || '').slice(0, 80);
    } else if (toolName === 'list_dir') {
      inputLabel = String(inputObj.DirectoryPath || inputObj.path || inputObj.dir || '').slice(0, 80);
    }

    let statusLine: string;
    if (toolName === 'bash' || toolName === 'run_command' || toolName === 'execute_command') {
      statusLine = `⚡ \`$ ${inputLabel}\``;
    } else if (toolName === 'read_file' || toolName === 'view_file') {
      statusLine = `📄 ${inputLabel || toolName}`;
    } else if (toolName === 'write_file' || toolName === 'create_file' || toolName === 'edit_file'
               || toolName === 'replace_file_content' || toolName === 'multi_replace_file_content') {
      statusLine = `✏️ ${inputLabel || toolName}`;
    } else if (toolName === 'web_search' || toolName === 'search_web') {
      statusLine = `🔍 ${inputLabel || 'searching...'}`;
    } else if (toolName === 'grep_search') {
      statusLine = `🔍 grep: ${inputLabel}`;
    } else if (toolName === 'list_dir') {
      statusLine = `📁 ${inputLabel || toolName}`;
    } else {
      statusLine = `🔧 ${toolName}`;
    }

    const meta = sessionMeta.get(sId) || {};
    meta.textBuf = '';
    sessionMeta.set(sId, meta);
    savePromptStatus(sId, statusLine);
  });

  api.event.on("session.next.reasoning.started", (e: any) => {
    const payload = e.data || e.properties || e;
    const sId = payload?.sessionID;
    if (!sId) return;
    const meta = sessionMeta.get(sId) || {};
    meta.textBuf = '';
    sessionMeta.set(sId, meta);
    savePromptStatus(sId, '🧠 Thinking...');
  });

  api.event.on("session.next.reasoning.delta", (e: any) => {
    const payload = e.data || e.properties || e;
    const sId = payload?.sessionID;
    const delta: string = payload?.delta || '';
    if (!sId || !delta) return;
    savePromptStatus(sId, '🧠 Thinking...');
  });

  api.event.on("session.next.text.started", (e: any) => {
    const payload = e.data || e.properties || e;
    const sId = payload?.sessionID;
    if (!sId) return;
    const meta = sessionMeta.get(sId) || {};
    meta.textBuf = '';
    sessionMeta.set(sId, meta);
    savePromptStatus(sId, '💬 Writing...');
  });

  api.event.on("session.next.text.delta", (e: any) => {
    const payload = e.data || e.properties || e;
    const sId = payload?.sessionID;
    const delta: string = payload?.delta || '';
    if (!sId || !delta) return;
    const meta = sessionMeta.get(sId) || {};
    meta.textBuf = (meta.textBuf || '') + delta;
    sessionMeta.set(sId, meta);
    const buf = meta.textBuf;
    const preview = buf.length > 600 ? '...' + buf.slice(-600) : buf;
    savePromptStatus(sId, preview);
  });

  api.event.on("session.next.text.ended", (e: any) => {
    const payload = e.data || e.properties || e;
    const sId = payload?.sessionID;
    if (!sId) return;
    const meta = sessionMeta.get(sId) || {};
    const text = payload?.text || meta.textBuf || '';
    if (!sId || !text) return;

    const sessionData = api.state.session.get(sId);
    const info: any = {};
    if (meta.agent) info.agent = meta.agent;
    if (meta.model) info.model = meta.model;
    if (sessionData?.title) info.title = sessionData.title;
    if (meta.stepStartTime) info.duration = Math.round((Date.now() - meta.stepStartTime) / 1000);

    savePromptResponse(sId, text, info);
    savePromptStatus(sId, '✅ Done');
  });

  api.event.on("session.next.step.ended", (e: any) => {
    const payload = e.data || e.properties || e;
    const sId = payload?.sessionID;
    if (!sId) return;
    const cost = payload?.cost || 0;
    const tokens = payload?.tokens || {};
    const totalTokens = (tokens?.input || payload?.tokens_input || payload?.tokensInput || 0) + (tokens?.output || payload?.tokens_output || payload?.tokensOutput || 0) + (tokens?.reasoning || 0);
    if (cost > 0 || totalTokens > 0) {
      updatePromptResponseMeta(sId, cost > 0 ? cost : undefined, totalTokens > 0 ? totalTokens : undefined);
    }
  });
  
  api.event.on("question.asked", (e: any) => {
    // SDK may use e.properties (old) or e.data (new)
    const props = e.properties || e.data || {};
    if (props.sessionID && props.questions?.length > 0) {
      updateStatusSafe(props.sessionID, "ask");
      const requestId = props.id;
      registerQuestionRequest(props.sessionID, requestId);
      const title = api.state.session.get(props.sessionID)?.title || props.sessionID.slice(0,8);
      notifyTelegramQuestion(requestId, props.sessionID, props.questions, title);
    }
  });

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
