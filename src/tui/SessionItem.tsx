/** @jsxImportSource @opentui/solid */
import { Show } from "solid-js";
import type { TuiPluginApi } from "@opencode-ai/plugin/tui";
import { getStatusSignal } from "./signals";

export interface SessionItemProps {
  id: string;
  title: string;
  isSubagent?: boolean;
  isLastSubagent?: boolean;
  isExpired?: boolean;
  hasSubagents?: boolean;
  currentSessionId: () => string | undefined;
  setCurrentSessionId: (id: string | undefined) => void;
  expanded: () => Set<string>;
  toggleExpanded: (id: string) => void;
  api: TuiPluginApi;
}

export function SessionItem(props: SessionItemProps) {
  const [status] = getStatusSignal(props.id);
  const isCurrent = () => props.currentSessionId() === props.id;
  
  const statusIcon = () => {
    const s = status();
    if (s === "busy" || s === "running") return "[RUN]";
    if (s === "retry" || s === "waiting") return "[WAIT]";
    if (s === "ask") return "[ASK]";
    if (s === "perm") return "[PERM]";
    if (s === "idle") return "[IDLE]";
    return `[${s.toUpperCase().slice(0, 4)}]`;
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
    props.setCurrentSessionId(props.id);
    props.api.route.navigate("session", { sessionID: props.id });
  };
  
  const prefix = props.isSubagent ? (props.isLastSubagent ? " └─ " : " ├─ ") : "";
  const titleText = props.title?.slice(0, props.isSubagent ? 23 : 26) || props.id.slice(0, 8);
  
  return (
    <box flexDirection="row" gap={1} flexShrink={0}>
      <box flexDirection="row" gap={0}>
        <Show when={!props.isSubagent}>
          <text 
            fg={props.hasSubagents ? "cyan" : "gray"} 
            onMouseDown={props.hasSubagents ? () => props.toggleExpanded(props.id) : undefined}
          >
            {props.hasSubagents ? (props.expanded().has(props.id) ? "[-] " : "[+] ") : "[-] "}
          </text>
        </Show>
        <text fg={isCurrent() ? "white" : "gray"} onMouseDown={nav}>
          {prefix}{isCurrent() ? <b>{titleText}</b> : titleText}
        </text>
      </box>
      
      <text fg={props.isExpired ? "gray" : statusColor()} onMouseDown={nav}>
        {statusIcon()}
      </text>
    </box>
  );
}
