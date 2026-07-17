import path from 'path';
import fs from 'fs';
import os from 'os';
import { apiRef, readState, activeProjectDir } from './state';

function collapseDcpBlocks(text: string): string {
  if (!text) return '';
  
  const lines = text.split('\n');
  const resultLines: string[] = [];
  let inDcpBlock = false;
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    
    if (trimmed.includes('▣ DCP |')) {
      inDcpBlock = true;
      const details = trimmed.replace('▣ DCP |', '').trim();
      resultLines.push(`✂️ <b>DCP</b>: ${details}`);
      continue;
    }
    
    if (inDcpBlock) {
      // Ignore progress bars, compression lines, topics, items lines, and timestamps
      if (trimmed.startsWith('│') && trimmed.endsWith('│')) {
        continue;
      }
      if (trimmed.includes('▣ Compression')) {
        continue;
      }
      if (trimmed.startsWith('→ Topic:') || trimmed.startsWith('→ Items:')) {
        continue;
      }
      if (trimmed === '') {
        continue;
      }
      if (/^\d{1,2}:\d{2}\s*(?:AM|PM)?$/i.test(trimmed)) {
        continue;
      }
      
      inDcpBlock = false;
    }
    
    resultLines.push(line);
  }
  
  return resultLines.join('\n').trim();
}

function convertMarkdownToHtml(text: string): string {
  if (!text) return '';
  
  let formatted = text;
  
  // 1. Code blocks: ```language ... ``` -> <pre>...</pre>
  formatted = formatted.replace(/```(?:[a-zA-Z0-9+#-]+)?\n([\s\S]*?)```/g, '<pre>$1</pre>');
  formatted = formatted.replace(/```([\s\S]*?)```/g, '<pre>$1</pre>');
  
  // 2. Inline code: `code` -> <code>code</code>
  formatted = formatted.replace(/`([^`\n]+)`/g, '<code>$1</code>');
  
  // 3. Bold: **bold** -> <b>bold</b>
  formatted = formatted.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
  
  // 4. Italic: *italic* -> <i>italic</i>
  formatted = formatted.replace(/\*([^\*\s][^\*]*[^\*\s]|[^\*\s])\*/g, '<i>$1</i>');
  
  // 5. Bullet list items: * item -> • item
  formatted = formatted.replace(/^\s*\*\s+(.+)$/gm, '• $1');
  
  // 6. Headers: # Header -> <b>Header</b>
  formatted = formatted.replace(/^#+\s+(.+)$/gm, '<b>$1</b>');
  
  return formatted;
}

function parseAndFormatTable(tableLines: string[]): string {
  const headers = tableLines[0]
    .split('|')
    .map(h => h.trim())
    .filter((_, idx, arr) => idx > 0 && idx < arr.length - 1);
    
  const dataRows: string[] = [];
  for (let i = 2; i < tableLines.length; i++) {
    const cells = tableLines[i]
      .split('|')
      .map(c => c.trim())
      .filter((_, idx, arr) => idx > 0 && idx < arr.length - 1);
      
    if (cells.length === 0) continue;
    
    let rowText = '';
    const firstHeader = headers[0] || 'Key';
    const firstVal = cells[0] || '-';
    rowText += `▪️ <b>${firstHeader}:</b> ${firstVal}\n`;
    
    for (let j = 1; j < headers.length; j++) {
      const header = headers[j] || `Col ${j + 1}`;
      const value = cells[j] || '-';
      
      if (header.replace(/[-:]/g, '') === '') continue;
      
      rowText += `  • <b>${header}:</b> ${value}\n`;
    }
    if (rowText) {
      dataRows.push(rowText.trimEnd());
    }
  }
  
  return dataRows.join('\n\n');
}

function formatMarkdownTables(text: string): string {
  if (!text) return '';
  
  const lines = text.split('\n');
  const resultLines: string[] = [];
  let inTable = false;
  let tableLines: string[] = [];
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    
    if (trimmed.startsWith('|') && trimmed.endsWith('|')) {
      inTable = true;
      tableLines.push(trimmed);
      continue;
    }
    
    if (inTable) {
      inTable = false;
      if (tableLines.length >= 3) {
        resultLines.push(parseAndFormatTable(tableLines));
      } else {
        resultLines.push(...tableLines);
      }
      tableLines = [];
    }
    
    resultLines.push(line);
  }
  
  if (inTable && tableLines.length >= 3) {
    resultLines.push(parseAndFormatTable(tableLines));
  } else if (inTable) {
    resultLines.push(...tableLines);
  }
  
  return resultLines.join('\n');
}

function collapseSystemReminders(text: string): string {
  if (!text) return '';
  
  // First, strip internal comment markers completely
  let clean = text
    .replace(/<!-- OMO_INTERNAL_INITIATOR -->/g, '')
    .replace(/<!-- OMO_INTERNAL_NOREPLY -->/g, '');
    
  const lines = clean.split('\n');
  const resultLines: string[] = [];
  let inReminder = false;
  let reminderTitle = '';
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    
    if (trimmed.startsWith('&lt;system-reminder&gt;') || trimmed.startsWith('<system-reminder>')) {
      inReminder = true;
      reminderTitle = '';
      const rest = trimmed
        .replace('&lt;system-reminder&gt;', '')
        .replace('<system-reminder>', '')
        .trim();
      if (rest) {
        reminderTitle = rest;
      }
      continue;
    }
    
    if (inReminder) {
      if (trimmed.endsWith('&lt;/system-reminder&gt;') || trimmed.endsWith('</system-reminder>') || 
          trimmed === '&lt;/system-reminder&gt;' || trimmed === '</system-reminder>') {
        inReminder = false;
        const finalTitle = reminderTitle || 'System Notification';
        resultLines.push(`🔔 <b>System</b>: ${finalTitle}`);
        continue;
      }
      if (!reminderTitle && trimmed) {
        reminderTitle = trimmed.replace(/[\[\]`]/g, '');
      }
      continue;
    }
    
    // Skip empty lines or timestamps right after a system reminder or DCP block
    const lastResult = resultLines[resultLines.length - 1];
    if (lastResult && (lastResult.startsWith('🔔 <b>System</b>:') || lastResult.startsWith('✂️ <b>DCP</b>:'))) {
      if (trimmed === '') {
        continue;
      }
      if (/^\d{1,2}:\d{2}\s*(?:AM|PM)?$/i.test(trimmed)) {
        continue;
      }
    }
    
    resultLines.push(line);
  }
  
  return resultLines.join('\n').trim();
}

function collapseLspDiagnostics(text: string): string {
  if (!text) return '';
  
  const lines = text.split('\n');
  const resultLines: string[] = [];
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    
    if (trimmed.startsWith('# lsp_diagnostics') || trimmed.startsWith('### lsp_diagnostics') || trimmed.includes('lsp_diagnostics')) {
      const pathMatch = trimmed.match(/filePath=([^\]\s]+)/);
      if (pathMatch) {
        const rawPath = pathMatch[1];
        const cleanP = cleanPath(rawPath);
        
        // Peek next line for "No diagnostics found"
        const nextLine = lines[i + 1];
        if (nextLine && nextLine.trim().includes('No diagnostics found')) {
          resultLines.push(`🔎 <b>LSP:</b> <code>${cleanP}</code> (Clean)`);
          i++; // Skip "No diagnostics found" line
          
          // Skip subsequent empty lines or timestamps
          while (i + 1 < lines.length && (lines[i + 1].trim() === '' || /^\d{1,2}:\d{2}\s*(?:AM|PM)?$/i.test(lines[i + 1].trim()))) {
            i++;
          }
          continue;
        } else {
          resultLines.push(`🔎 <b>LSP Diagnostics:</b> <code>${cleanP}</code>`);
          continue;
        }
      }
    }
    
    resultLines.push(line);
  }
  
  return resultLines.join('\n').trim();
}

export function escapeHtml(text: string): string {
  const escaped = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  const collapsedDcp = collapseDcpBlocks(escaped);
  const collapsedReminders = collapseSystemReminders(collapsedDcp);
  const collapsedLsp = collapseLspDiagnostics(collapsedReminders);
  const tablesFormatted = formatMarkdownTables(collapsedLsp);
  return convertMarkdownToHtml(tablesFormatted);
}

export function formatThinkingText(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return '';

  const parts = trimmed.split(/(?<=[.?!])\s+|\n+/);
  const cleanParts = parts.map(p => p.trim()).filter(Boolean);

  if (cleanParts.length <= 2) {
    if (trimmed.length > 250) {
      return trimmed.slice(0, 120) + ' ... ' + trimmed.slice(-120);
    }
    return trimmed;
  }

  const first = cleanParts[0];
  const last = cleanParts[cleanParts.length - 1];

  const maxPartLen = 150;
  const safeFirst = first.length > maxPartLen ? first.slice(0, maxPartLen) + '...' : first;
  const safeLast = last.length > maxPartLen ? last.slice(-maxPartLen) : last;

  return `${safeFirst}\n...\n${safeLast}`;
}

function cleanPath(p: string): string {
  if (!p) return '';
  let cleaned = p;
  const projectDir = activeProjectDir || apiRef.state.path.directory || '';
  if (projectDir && p.startsWith(projectDir)) {
    let relative = p.slice(projectDir.length);
    if (relative.startsWith('/') || relative.startsWith('\\')) {
      relative = relative.slice(1);
    }
    cleaned = relative || '.';
  } else {
    const home = os.homedir();
    if (p.startsWith(home)) {
      cleaned = '~' + p.slice(home.length);
    }
  }
  
  // Middle shorten if path exceeds 45 characters
  if (cleaned.length > 45) {
    const head = cleaned.slice(0, 15);
    const tail = cleaned.slice(-27);
    cleaned = `${head}...${tail}`;
  }
  
  return cleaned;
}

function getToolInputLabel(name: string, input: any): string {
  if (!input) return '';
  
  let obj: any = null;
  if (typeof input === 'object') {
    obj = input;
  } else if (typeof input === 'string') {
    const trimmed = input.trim();
    if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
      try {
        obj = JSON.parse(trimmed);
      } catch(e) {}
    }
  }
  
  if (obj) {
    if (name === 'bash' || name === 'run_command' || name === 'execute_command') {
      return String(obj.CommandLine || obj.command || obj.cmd || '');
    }
    const pathVal = obj.path || obj.file_path || obj.AbsolutePath || obj.TargetFile || obj.filePath || obj.DirectoryPath || obj.dir || obj.SearchPath || '';
    if (pathVal) return cleanPath(String(pathVal));
  
    const queryVal = obj.query || obj.q || obj.Query || obj.pattern || '';
    if (queryVal) return String(queryVal);
  }
  
  const rawStr = String(input);
  if (rawStr.startsWith('/') || rawStr.includes('/Users/')) {
    return cleanPath(rawStr);
  }
  return rawStr;
}

export function formatToolLine(name: string, input: any, status: string | undefined): string {
  const label = getToolInputLabel(name, input);
  const cmd = label.split('\n')[0].slice(0, 60);
  const escCmd = escapeHtml(cmd);
  const hasMore = label.length > 60 || label.includes('\n');
  const showCmd = escCmd + (hasMore ? '...' : '');

  let icon = '🔧';
  let actionName = name;
  
  if (name === 'bash' || name === 'execute_command' || name === 'run_command') {
    icon = '⚡';
    actionName = '$';
  } else if (name === 'read_file' || name === 'view_file') {
    icon = '📄';
    actionName = 'Read';
  } else if (name === 'write_file' || name === 'create_file' || name === 'edit_file'
             || name === 'replace_file_content' || name === 'multi_replace_file_content' || name === 'write_to_file') {
    icon = '✏️';
    actionName = 'Write';
  } else if (name === 'web_search' || name === 'search_web' || name === 'grep_search') {
    icon = '🔍';
    actionName = 'Search';
  } else if (name === 'list_dir') {
    icon = '📁';
    actionName = 'List';
  }

  const prefix = showCmd 
    ? `${icon} <code>${actionName}: ${showCmd}</code>`
    : `${icon} <code>${name}</code>`;

  if (status === 'running') {
    return `${prefix} ⏳`;
  } else if (status === 'complete') {
    return `${prefix} ✅`;
  } else if (status === 'error') {
    return `${prefix} ❌`;
  }
  return prefix;
}

export function buildStatusFromParts(parts: any[]): string {
  const lines: string[] = [];
  const textParts = parts.filter(p => p.type === 'text');
  const otherParts = parts.filter(p => p.type !== 'text');

  for (const p of otherParts) {
    if (p.type === 'reasoning') {
      const text = (p.text || '').trim();
      if (text) {
        lines.push(`🧠 <i>Thinking: ${escapeHtml(formatThinkingText(text))}</i>`);
      }
    } else if (p.type === 'tool' || p.type === 'tool_call') {
      const name = p.tool || p.name || '';
      const input = p.state?.input?.command || p.state?.input?.CommandLine || p.input || '';
      const status = p.state?.status || (p.type === 'tool_call' ? 'running' : 'complete');
      lines.push(formatToolLine(name, input, status));
    }
  }

  const textContent = textParts.map(p => p.text || '').join('').trim();
  if (textContent) {
    const esc = escapeHtml(textContent);
    let truncated = esc;
    if (esc.length > 3000) {
      const head = esc.slice(0, 300);
      const tail = esc.slice(-2650);
      truncated = `${head}\n\n... <i>(truncated)</i> ...\n\n${tail}`;
    }
    lines.push(truncated);
  }

  return lines.join('\n\n').trim();
}

export function registerMessageSession(messageId: number, sessionId: string, directory: string) {
  try {
    const state = readState();
    state.messageSessions = state.messageSessions || {};
    state.messageSessions[messageId] = { sessionId, directory, timestamp: Date.now() };
    
    // Clean up older mappings to avoid growing infinitely (keep last 200)
    const keys = Object.keys(state.messageSessions);
    if (keys.length > 200) {
      const items = keys.map(k => ({ key: k, ts: state.messageSessions[k].timestamp || 0 }));
      items.sort((a, b) => b.ts - a.ts);
      const toKeep = items.slice(0, 200).map(i => i.key);
      const newMap: Record<string, any> = {};
      for (const k of toKeep) {
        newMap[k] = state.messageSessions[k];
      }
      state.messageSessions = newMap;
    }
    fs.writeFileSync(path.join(os.homedir(), '.cache', 'opencode-session-tracker', 'session-tracker.json'), JSON.stringify(state));
  } catch(e) {}
}

export function buildFooter(sData: any): string {
  const parts: string[] = [];
  if (sData?.agent) {
    parts.push(`agent: ${sData.agent.split('-')[0]}`);
  }
  if (sData?.model?.modelID || sData?.modelID) {
    parts.push(`model: ${sData.model?.modelID || sData.modelID}`);
  }
  return parts.length > 0 ? `\n\n_${parts.join(' · ')}_` : '';
}

export function modelName(m: any): string {
  const p = m.providerID || '';
  const id = m.modelID || m.id || '';
  if (p === 'openrouter') return id.split('/').pop() || id;
  return id;
}

export async function buildMessageWithHeaderAndFooter(
  sessionId: string,
  bodyText: string,
  lastAssistant: any,
  promptTimestamp: number
): Promise<string> {
  let sessionTitle = '';
  try {
    const sRes = await apiRef.client.session.get({ sessionID: sessionId });
    sessionTitle = (sRes?.data || sRes)?.title || '';
  } catch(e) {}
  const header = sessionTitle ? `📌 <b>${escapeHtml(sessionTitle)}</b>\n\n` : '';

  const info = lastAssistant?.info || lastAssistant || {};
  const metaParts: string[] = [];

  // Agent Name
  let agentVal = info?.agent;
  if (!agentVal) {
    try { agentVal = readState().sessionAgents?.[sessionId]; } catch(e) {}
  }
  if (agentVal) metaParts.push(agentVal.split('-')[0].trim());

  // Model Name
  let modelVal = info?.model?.modelID || info?.modelID;
  if (!modelVal) {
    try { modelVal = readState().sessionModels?.[sessionId]?.modelID; } catch(e) {}
  }
  if (modelVal) metaParts.push(modelVal);

  // Duration
  const elapsedMs = Date.now() - promptTimestamp;
  const sec = elapsedMs / 1000;
  metaParts.push(sec < 60 ? `${sec.toFixed(1)}s` : `${Math.floor(sec/60)}m ${Math.round(sec%60)}s`);

  // Tokens & cost display are currently disabled per user preference to reduce footer noise.
  // KEEP THIS CODE: Do not delete, it will be re-enabled when requested.
  /*
  const tok = info?.tokens?.total ||
              ((info?.tokens?.input || 0) + (info?.tokens?.output || 0)) ||
              ((info?.tokens_input || info?.tokensInput || 0) + (info?.tokens_output || info?.tokensOutput || 0));
  if (tok > 0) metaParts.push(`${(tok/1000).toFixed(1)}K`);
  if (info?.cost > 0) metaParts.push(`$${info.cost.toFixed(2)}`);
  */

  let footer = metaParts.length > 0 ? `\n\n<i>${metaParts.join(' · ')}</i>` : '';

  return `${header}${bodyText}${footer}`;
}
