import { apiRef } from '../core/runtime';
import { readState, writeState } from '../core/store';
import { cleanAndConvert, cleanCommand, cleanPath } from './textClean';

const SHELL_TOOLS = new Set(['bash', 'run_command', 'execute_command']);
const QUESTION_TOOLS = new Set(['question', 'ask', 'ask_question']);

/** Normalizes second- or millisecond-based timestamps to milliseconds. */
export function toMs(ts: any): number {
  if (!ts) return 0;
  const num = Number(ts);
  if (isNaN(num)) return 0;
  return num < 10000000000 ? num * 1000 : num;
}

/** "12.3s" under a minute, "2m 5s" otherwise. */
export function formatDuration(totalSeconds: number): string {
  return totalSeconds < 60
    ? `${totalSeconds.toFixed(1)}s`
    : `${Math.floor(totalSeconds / 60)}m ${Math.round(totalSeconds % 60)}s`;
}

export function escapeHtml(text: string): string {
  const escaped = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  return cleanAndConvert(escaped);
}

export function formatThinkingText(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return '';

  const cleanParts = trimmed.split(/(?<=[.?!])\s+|\n+/).map(p => p.trim()).filter(Boolean);

  if (cleanParts.length <= 2) {
    return trimmed.length > 250 ? trimmed.slice(0, 120) + ' ... ' + trimmed.slice(-120) : trimmed;
  }

  const first = cleanParts[0];
  const last = cleanParts[cleanParts.length - 1];

  const maxPartLen = 150;
  const safeFirst = first.length > maxPartLen ? first.slice(0, maxPartLen) + '...' : first;
  const safeLast = last.length > maxPartLen ? last.slice(-maxPartLen) : last;

  return `${safeFirst}\n...\n${safeLast}`;
}

function parseToolInput(input: any): any {
  if (typeof input === 'object') return input;
  if (typeof input === 'string') {
    const trimmed = input.trim();
    if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
      try { return JSON.parse(trimmed); } catch (e) {}
    }
  }
  return null;
}

function getToolInputLabel(name: string, input: any): string {
  if (!input) return '';
  const n = name.toLowerCase();
  const obj = parseToolInput(input);

  if (obj) {
    if (SHELL_TOOLS.has(n)) {
      return cleanCommand(String(obj.CommandLine || obj.command || obj.cmd || ''));
    }

    // Question / ask tool — extract question text
    if (QUESTION_TOOLS.has(n)) {
      const qText = obj.question || obj.text || obj.title || obj.prompt || '';
      return String(qText).slice(0, 80) || 'Question';
    }

    // Case-insensitive key check for paths/files, then queries/patterns
    const keys = Object.keys(obj);
    const findKey = (match: (k: string) => boolean) => keys.find(k => match(k.toLowerCase()));

    const pathKey = findKey(k => ['path', 'file', 'dir', 'target'].some(s => k.includes(s)));
    const pathVal = pathKey ? String(obj[pathKey]) : '';
    if (pathVal) return cleanPath(pathVal);

    const queryKey = findKey(k => ['query', 'pattern', 'glob'].some(s => k.includes(s)) || k === 'q');
    if (queryKey) return String(obj[queryKey]);
  }

  const rawStr = String(input);
  if (rawStr === '[object Object]') return '';
  if (SHELL_TOOLS.has(n)) return cleanCommand(rawStr);
  if (rawStr.startsWith('/') || rawStr.includes('/Users/')) return cleanPath(rawStr);
  return rawStr;
}

// Icon and action label per tool name; unknown tools use 🔧 and their own name.
const TOOL_STYLES: Record<string, { icon: string; action: string }> = {};
const defineToolStyle = (names: string[], icon: string, action: string) =>
  names.forEach(n => { TOOL_STYLES[n] = { icon, action }; });

defineToolStyle([...SHELL_TOOLS], '⚡', '');
defineToolStyle(['read_file', 'view_file', 'read'], '📄', 'Read');
defineToolStyle(
  ['write_file', 'create_file', 'edit_file', 'replace_file_content', 'multi_replace_file_content', 'write_to_file', 'edit', 'write'],
  '✏️', 'Write',
);
defineToolStyle(['web_search', 'search_web', 'grep_search', 'grep'], '🔍', 'Search');
defineToolStyle(['list_dir', 'list'], '📁', 'List');
defineToolStyle(['glob', 'glob_search'], '🔎', 'Glob');
defineToolStyle([...QUESTION_TOOLS], '❓', 'Asked');
defineToolStyle(['generate_image', 'image'], '🖼️', 'Image');

const STATUS_ICONS: Record<string, string> = { running: '⏳', streaming: '⏳', complete: '✅', completed: '✅', error: '❌' };

export function formatToolLine(name: string, input: any, status: string | undefined): string {
  const label = getToolInputLabel(name, input);
  const cmd = label.split('\n')[0].slice(0, 60);
  const hasMore = label.length > 60 || label.includes('\n');
  const showCmd = escapeHtml(cmd) + (hasMore ? '...' : '');

  const { icon, action } = TOOL_STYLES[name.toLowerCase()] || { icon: '🔧', action: name };

  const prefix = showCmd
    ? action ? `${icon} <code>${action}: ${showCmd}</code>` : `${icon} <code>${showCmd}</code>`
    : `${icon} <code>${name}</code>`;

  const statusIcon = status && STATUS_ICONS[status];
  return statusIcon ? `${prefix} ${statusIcon}` : prefix;
}

export function buildStatusFromParts(parts: any[]): string {
  const lines: string[] = [];

  for (const p of (parts || []).filter(p => p.type !== 'text')) {
    if (p.type === 'reasoning') {
      const text = (p.text || '').trim();
      if (text) {
        lines.push(`🧠 <i>Thinking: ${escapeHtml(formatThinkingText(text))}</i>`);
      }
    } else if (p.type === 'tool' || p.type === 'tool_call') {
      const name = p.tool || p.name || '';
      const status = p.state?.status || (p.type === 'tool_call' ? 'running' : 'complete');
      // question/ask tools are sent as separate interactive Telegram messages by notifyTelegramQuestion
      // — just show a static indicator here, don't parse the object input
      if (QUESTION_TOOLS.has(name.toLowerCase())) {
        lines.push(`❓ <code>Question asked</code> ${STATUS_ICONS[status] || '✅'}`);
      } else {
        lines.push(formatToolLine(name, p.state?.input ?? p.input ?? {}, status));
      }
    }
  }

  const textContent = (parts || []).filter(p => p.type === 'text').map(p => p.text || '').join('').trim();
  if (textContent) {
    const esc = escapeHtml(textContent);
    lines.push(esc.length > 3000
      ? `${esc.slice(0, 300)}\n\n... <i>(truncated)</i> ...\n\n${esc.slice(-2650)}`
      : esc);
  }

  return lines.join('\n\n').trim();
}

const MAX_MESSAGE_SESSIONS = 200;

export function registerMessageSession(messageId: number, sessionId: string, directory: string) {
  try {
    const state = readState();
    state.messageSessions = state.messageSessions || {};
    state.messageSessions[messageId] = { sessionId, directory, timestamp: Date.now() };

    // Keep only the most recent mappings so the state file doesn't grow forever
    const keys = Object.keys(state.messageSessions);
    if (keys.length > MAX_MESSAGE_SESSIONS) {
      const newest = keys
        .map(k => ({ key: k, ts: state.messageSessions[k].timestamp || 0 }))
        .sort((a, b) => b.ts - a.ts)
        .slice(0, MAX_MESSAGE_SESSIONS);
      const kept: Record<string, any> = {};
      for (const { key } of newest) kept[key] = state.messageSessions[key];
      state.messageSessions = kept;
    }
    writeState(state);
  } catch (e) {}
}

const MODEL_DISPLAY_NAMES: Record<string, string> = {
  'deepseek-v4-flash': 'DeepSeek V4 Flash',
  'deepseek-v4-pro': 'DeepSeek V4 Pro',
  'claude-3-5-sonnet': 'Claude 3.5 Sonnet',
};
const MODEL_ACRONYMS: Record<string, string> = { gpt: 'GPT', v4: 'V4', mcp: 'MCP' };

export function formatModelName(modelId: string): string {
  if (!modelId) return '';
  const name = modelId.split('/').pop() || modelId;
  const known = MODEL_DISPLAY_NAMES[name.toLowerCase()];
  if (known) return known;

  return name
    .split(/[-_]/)
    .map(word => MODEL_ACRONYMS[word.toLowerCase()] || (word.charAt(0).toUpperCase() + word.slice(1)))
    .join(' ');
}

export async function buildMessageWithHeaderAndFooter(
  sessionId: string,
  bodyText: string,
  lastAssistant: any,
  promptTimestamp: number,
  durationOverride?: string
): Promise<string> {
  let sessionTitle = '';
  try {
    const sRes: any = await apiRef.client.session.get({ sessionID: sessionId });
    sessionTitle = (sRes && typeof sRes.id === 'string' ? sRes : sRes?.data)?.title || '';
  } catch (e) {}
  const header = sessionTitle ? `📌 <b>${escapeHtml(sessionTitle)}</b>\n\n` : '';

  // v2 assistant messages carry agent/model/tokens/cost at top level (v1 nested under .info).
  const info = lastAssistant?.info || lastAssistant || {};
  const metaParts: string[] = [];

  const agentVal = info?.agent || readStateValue(s => s.sessionAgents?.[sessionId]);
  if (agentVal) metaParts.push(agentVal.split('-')[0].trim());

  const modelVal = info?.model?.modelID || info?.model?.id || info?.modelID || readStateValue(s => s.sessionModels?.[sessionId]?.modelID);
  if (modelVal) metaParts.push(formatModelName(modelVal));

  metaParts.push(durationOverride || formatDuration((Date.now() - promptTimestamp) / 1000));

  // Tokens & cost display are currently disabled per user preference to reduce footer noise.
  // KEEP THIS CODE: Do not delete, it will be re-enabled when requested.
  /*
  const tok = info?.tokens?.total ||
              ((info?.tokens?.input || 0) + (info?.tokens?.output || 0)) ||
              ((info?.tokens_input || info?.tokensInput || 0) + (info?.tokens_output || info?.tokensOutput || 0));
  if (tok > 0) metaParts.push(`${(tok/1000).toFixed(1)}K`);
  if (info?.cost > 0) metaParts.push(`$${info.cost.toFixed(2)}`);
  */

  const footer = `\n\n<i>${metaParts.join(' · ')}</i>`;
  return `${header}${bodyText}${footer}`;
}

function readStateValue(pick: (state: any) => any): any {
  try { return pick(readState()); } catch (e) { return undefined; }
}
