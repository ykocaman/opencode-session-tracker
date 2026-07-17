/** @jsxImportSource @opentui/solid */
import type { TuiPlugin, TuiPluginModule, TuiPluginApi, TuiSlotProps } from "@opencode-ai/plugin/tui";
import { createResource, onCleanup, For, Show, createSignal } from "solid-js";
import { initTelegram, updateCurrentSessionId, notifyTelegram, notifyTelegramQuestion, registerQuestionRequest, registerPermissionRequest, triggerSessionsMenuUpdate, saveSessionStatus, saveSessionModel, saveSessionAgent, savePromptStatus, savePromptResponse, notifySessionIdle, updatePromptResponseMeta, logDebug } from "./telegram";
import fs from 'fs';
import os from 'os';
import path from 'path';

const statusSignals = new Map<string, ReturnType<typeof createSignal<string>>>();

function getStatusSignal(sessionID: string) {
  if (!statusSignals.has(sessionID)) {
    statusSignals.set(sessionID, createSignal<string>("idle"));
  }
  return statusSignals.get(sessionID)!;
}

function SessionSidebar(props: TuiSlotProps<"sidebar_content"> & { api: TuiPluginApi }) {
  const { api } = props;
  
  // Keep telegram in sync with the TUI's active session
  updateCurrentSessionId(props.session_id || null);
  const [expanded, setExpanded] = createSignal<Set<string>>(new Set());
  const [currentSessionId, setCurrentSessionId] = createSignal<string | undefined>(props.session_id);

  const toggleExpanded = (id: string) => {
      const newSet = new Set(expanded());
      if (newSet.has(id)) newSet.delete(id);
      else newSet.add(id);
      setExpanded(newSet);
  };

  const fetchSessions = async () => {
    try {
      const activeDir = api.state.path.directory;
      const response = await (api.client.session as any).list({ query: { directory: activeDir, limit: 30 } });
      return response.data || [];
    } catch (err) {
      return [];
    }
  };

  const [rawSessions, { refetch }] = createResource(fetchSessions);
  
  const interval = setInterval(() => {
    refetch();
    // Sync active session from route (slot session_id may not be reactive)
    const currentRoute = api.route.current as any;
    if (currentRoute.name === "session" && currentRoute.params?.sessionID) {
      setCurrentSessionId(currentRoute.params.sessionID);
    }
  }, 3000);
  onCleanup(() => clearInterval(interval));
  
  const displaySessions = () => {
      let sessions = rawSessions() || [];
      const now = Date.now();
      const EXPIRY_MS = 24 * 60 * 60 * 1000; // 24 hours since last update = expired
      const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
      
      const isExpired = (s: any) => {
         const updatedTime = typeof s.time?.updated === 'number' ? s.time.updated : 0;
         return now - updatedTime >= EXPIRY_MS;
      };
      
      sessions = sessions.filter((s: any) => {
         if (s.status === "deleted") return false;
         if (!s.title || s.title.trim() === "") return false;
         const updatedTime = typeof s.time?.updated === 'number' ? s.time.updated : 0;
         return now - updatedTime < WEEK_MS;
      });
      
      sessions.sort((a: any, b: any) => (b.time?.updated || 0) - (a.time?.updated || 0));
      
      const sessionsMap = new Map();
      sessions.forEach((s: any) => {
          s.subagents = [];
          sessionsMap.set(s.id, s);
      });

      const findUltimateParent = (s: any) => {
          let current = s;
          let lastVisible = null;
          const visited = new Set();
          while (current.parentID && !visited.has(current.id)) {
              visited.add(current.id);
              const parent = sessionsMap.get(current.parentID);
              if (!parent) break;
              lastVisible = parent;
              current = parent;
          }
          return lastVisible;
      };

      const parents: any[] = [];
      sessions.forEach((s: any) => {
          const p = findUltimateParent(s);
          if (p) {
              p.subagents.push(s);
          } else {
              parents.push(s);
          }
      });
      
      parents.sort((a: any, b: any) => {
          let aActive = false;
          let bActive = false;
          
          const checkActive = (session: any) => {
              const [status] = getStatusSignal(session.id);
              const st = status();
              return st !== "idle" && st !== "done" && st !== "error";
          };
          
          if (checkActive(a)) aActive = true;
          a.subagents?.forEach((sub: any) => { if (checkActive(sub)) aActive = true; });
          
          if (checkActive(b)) bActive = true;
          b.subagents?.forEach((sub: any) => { if (checkActive(sub)) bActive = true; });
          
          if (aActive && !bActive) return -1;
          if (!aActive && bActive) return 1;
          return (b.time?.updated || 0) - (a.time?.updated || 0);
      });
      
      const list: any[] = [];
      parents.forEach((p: any) => {
          const hasSubs = p.subagents && p.subagents.length > 0;
          list.push({ ...p, isSubagent: false, hasSubagents: hasSubs, isExpired: isExpired(p) });
          
          const isExpanded = expanded().has(p.id);
          
          p.subagents.sort((a: any, b: any) => (b.time?.updated || 0) - (a.time?.updated || 0));
          
          const visibleSubs = p.subagents.filter((sub: any) => {
              if (isExpanded) return true;
              const [status] = getStatusSignal(sub.id);
              const questions = api.state.session.question(sub.id) || [];
              const permissions = api.state.session.permission(sub.id) || [];
              const st = api.state.session.status(sub.id);
              const apiType = questions.length > 0 ? "ask" : permissions.length > 0 ? "perm" : (typeof st === "string" ? st : (st?.type || "idle"));
              
              return status() !== "idle" || apiType !== "idle";
          });
          
          visibleSubs.forEach((sub: any, index: number) => {
              const isLast = index === visibleSubs.length - 1;
              list.push({ ...sub, isSubagent: true, isLastSubagent: isLast, isExpired: isExpired(p) });
          });
      });
      
      list.forEach((s: any) => {
        const [status, setStatus] = getStatusSignal(s.id);
        // Only initialize from API state if no event has set this session's status yet.
        // Events (session.status, session.idle, question.asked, permission.requested)
        // are the primary update mechanism and take precedence.
        if (status() !== "idle") return;
        
        const questions = api.state.session.question(s.id) || [];
        const permissions = api.state.session.permission(s.id) || [];
        
        let currentType = "idle";
        if (questions.length > 0) {
            currentType = "ask";
        } else if (permissions.length > 0) {
            currentType = "perm";
        } else {
            const st = api.state.session.status(s.id);
            currentType = typeof st === "string" ? st : (st?.type || "idle");
        }
        
        setStatus(currentType);
      });
      
      return list;
  };
  
  const SessionItem = (session: any) => {
    const [status] = getStatusSignal(session.id);
    const isCurrent = () => currentSessionId() === session.id;
    
    const statusIcon = () => {
      const s = status();
      if (s === "busy" || s === "running") return "[RUN]";
      if (s === "retry" || s === "waiting") return "[WAIT]";
      if (s === "ask") return "[ASK]";
      if (s === "perm") return "[PERM]";
      if (s === "idle") return "[IDLE]";
      return `[${s.toUpperCase().slice(0,4)}]`;
    };
    
    const statusColor = () => {
      const s = status();
      if (s === "busy" || s === "running") return "green";
      if (s === "retry" || s === "waiting") return "yellow";
      if (s === "ask" || s === "perm") return "magenta";
      if (s === "idle") return "gray";
      return "white";
    };
    
    const nav = () => {
      setCurrentSessionId(session.id);
      api.route.navigate("session", { sessionID: session.id });
    };
    
    const prefix = session.isSubagent ? (session.isLastSubagent ? " └─ " : " ├─ ") : "";
    const titleText = session.title?.slice(0, session.isSubagent ? 20 : 23) || session.id.slice(0,8);
    
    return (
      <box flexDirection="row" gap={1} flexShrink={0}>
        <box flexDirection="row" gap={0}>
          <Show when={!session.isSubagent}>
            <text 
              fg={session.hasSubagents ? "cyan" : "gray"} 
              onMouseDown={session.hasSubagents ? () => toggleExpanded(session.id) : undefined}
            >
              {session.hasSubagents ? (expanded().has(session.id) ? "[-] " : "[+] ") : "[-] "}
            </text>
          </Show>
          <text fg={isCurrent() ? "white" : "gray"} onMouseDown={nav}>{prefix}{isCurrent() ? <b>{titleText}</b> : titleText}</text>
        </box>
        
        <text fg={session.isExpired ? "gray" : statusColor()} onMouseDown={nav}>{statusIcon()}</text>
      </box>
    );
  };
  
  const allSessions = () => displaySessions() || [];
  const activeSessions = () => allSessions().filter((s: any) => !s.isExpired);
  const expiredSessions = () => allSessions().filter((s: any) => s.isExpired);
  
  return (
    <box flexDirection="column" marginTop={1} flexShrink={0}>
      <text fg="white"><b>Sessions</b></text>
      <Show when={activeSessions().length === 0 && expiredSessions().length === 0}>
        <text fg="gray">No sessions found</text>
      </Show>
      <For each={activeSessions()}>
        {(session: any) => <SessionItem {...session} />}
      </For>
      <Show when={expiredSessions()?.length > 0}>
        <box marginTop={1}>
          <text fg="gray"><b>History</b></text>
        </box>
        <For each={expiredSessions()}>
          {(session: any) => <SessionItem {...session} />}
        </For>
      </Show>
    </box>
  );
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

  api.event.on("session.status", (e: any) => {
    const payload = e.data || e.properties || e;
    const st = payload?.status;
    updateStatusSafe(payload?.sessionID, typeof st === "string" ? st : (st?.type || "idle"));
  });
  
  api.event.on("session.idle", (e: any) => {
    const payload = e.data || e.properties || e;
    const sId = payload?.sessionID;
    updateStatusSafe(sId, "idle");
    // Trigger finalization of any active Telegram tracking for this session.
    // (session.idle does NOT arrive via apiRef.client.event.subscribe raw SSE)
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
   
   // Per-session tracking state: captures step agent/model for metadata
   const sessionMeta = new Map<string, { agent?: string; model?: string; stepStartTime?: number; textBuf?: string }>();

   // Correct field: properties.tool (NOT properties.name)
   // Correct field: properties.input is an OBJECT { [key: string]: unknown }
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
     logDebug('tool called event: ' + JSON.stringify(payload));

     const sId = payload?.sessionID;
     const toolName: string = payload?.tool || payload?.name || '';
     const inputObj = (payload?.input || payload?.arguments || {}) as Record<string, unknown>;
     if (!sId || !toolName) return;

     // Extract a human-readable label from the input object
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
     // Show thinking is happening without streaming the text itself
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
     // Show last 600 chars of accumulated text as live preview
     const buf = meta.textBuf;
     const preview = buf.length > 600 ? '...' + buf.slice(-600) : buf;
     savePromptStatus(sId, preview);
   });

   api.event.on("session.next.text.ended", (e: any) => {
     const payload = e.data || e.properties || e;
     const sId = payload?.sessionID;
     if (!sId) return;
     const meta = sessionMeta.get(sId) || {};
     // Only overwrite text if properties.text is explicitly given (SDK v2)
     // Otherwise fall back to accumulated buffer.
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
    if (e.properties?.sessionID && e.properties?.questions?.length > 0) {
      updateStatusSafe(e.properties.sessionID, "ask");
      const requestId = e.properties.id;
      registerQuestionRequest(e.properties.sessionID, requestId);
      
      const title = api.state.session.get(e.properties.sessionID)?.title || e.properties.sessionID.slice(0,8);
      
      notifyTelegramQuestion(requestId, e.properties.sessionID, e.properties.questions, title);
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
