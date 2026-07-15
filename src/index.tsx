/** @jsxImportSource @opentui/solid */
import type { TuiPlugin, TuiPluginModule, TuiPluginApi, TuiSlotProps } from "@opencode-ai/plugin/tui";
import { createResource, onCleanup, For, Show, createSignal } from "solid-js";
import { Box, Text } from "@opentui/solid";

const statusSignals = new Map<string, ReturnType<typeof createSignal<string>>>();

function getStatusSignal(sessionID: string) {
  if (!statusSignals.has(sessionID)) {
    statusSignals.set(sessionID, createSignal<string>("idle"));
  }
  return statusSignals.get(sessionID)!;
}

function SessionSidebar(props: TuiSlotProps<"sidebar_content"> & { api: TuiPluginApi }) {
  const { api } = props;
  const [expanded, setExpanded] = createSignal<Set<string>>(new Set());

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
  
  const interval = setInterval(refetch, 3000);
  onCleanup(() => clearInterval(interval));
  
  const displaySessions = () => {
      let sessions = rawSessions() || [];
      const now = Date.now();
      const ONE_DAY = 24 * 60 * 60 * 1000;
      
      sessions = sessions.filter((s: any) => {
         if (s.status === "deleted") return false;
         if (!s.title || s.title.trim() === "") return false;
         const updatedTime = typeof s.time?.updated === 'number' ? s.time.updated : 0;
         return now - updatedTime < ONE_DAY;
      });
      
      sessions.sort((a: any, b: any) => (b.time?.updated || 0) - (a.time?.updated || 0));
      
      const parents = sessions.filter((s: any) => !s.parentID);
      const parentMap = new Map();
      parents.forEach((p: any) => {
          p.subagents = [];
          parentMap.set(p.id, p);
      });
      
      sessions.filter((s: any) => s.parentID).forEach((s: any) => {
          const parent = parentMap.get(s.parentID);
          if (parent) {
              parent.subagents.push(s);
          } else {
              s.subagents = [];
              parents.push(s); 
              parentMap.set(s.id, s);
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
      parents.slice(0, 10).forEach((p: any) => {
          const hasSubs = p.subagents && p.subagents.length > 0;
          list.push({ ...p, isSubagent: false, hasSubagents: hasSubs });
          
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
              list.push({ ...sub, isSubagent: true, isLastSubagent: isLast });
          });
      });
      
      list.forEach((s: any) => {
        const [, setStatus] = getStatusSignal(s.id);
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
        
        setTimeout(() => setStatus(currentType), 0);
      });
      
      return list;
  };
  
  return (
    <box flexDirection="column" marginTop={1} flexShrink={0}>
      <text bold fg="white">Sessions</text>
      <Show when={displaySessions()?.length === 0}>
        <text fg="gray">No sessions found</text>
      </Show>
      <For each={displaySessions()}>
        {(session: any) => {
           const [status] = getStatusSignal(session.id);
           const isCurrent = () => props.session_id === session.id;
           
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
           
           const nav = () => api.route.navigate("session", { sessionID: session.id });
           
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
                 <text fg={isCurrent() ? "white" : "gray"} onMouseDown={nav}>{prefix}{titleText}</text>
               </box>
               
               <text fg={statusColor()} onMouseDown={nav}>{statusIcon()}</text>
             </box>
           );
        }}
      </For>

    </box>
  );
}

const tui: TuiPlugin = async (api) => {
  const updateStatusSafe = (sessionID: string, baseType?: string) => {
    if (!sessionID) return;
    const questions = api.state.session.question(sessionID) || [];
    const permissions = api.state.session.permission(sessionID) || [];
    
    let type = baseType || "idle";
    if (questions.length > 0) type = "ask";
    else if (permissions.length > 0) type = "perm";
    
    const [, setStatus] = getStatusSignal(sessionID);
    setStatus(type);
  };

  api.event.on("session.status", (e: any) => {
    const st = e.properties?.status;
    updateStatusSafe(e.properties?.sessionID, typeof st === "string" ? st : (st?.type || "idle"));
  });
  
  api.event.on("session.idle", (e: any) => {
    updateStatusSafe(e.properties?.sessionID, "idle");
  });
  
  api.event.on("question.asked", (e: any) => {
    if (e.properties?.sessionID) updateStatusSafe(e.properties.sessionID, "ask");
  });

  api.event.on("permission.requested", (e: any) => {
    if (e.properties?.sessionID) updateStatusSafe(e.properties.sessionID, "perm");
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
