import os from 'os';
import { apiRef, activeProjectDir } from './state';

function currentDir(): string {
  try {
    return activeProjectDir || apiRef?.data?.location?.default?.()?.directory || apiRef?.state?.path?.directory || '';
  } catch (e) {
    return activeProjectDir || '';
  }
}

const TIME_ONLY_RE = /^\d{1,2}:\d{2}\s*(?:AM|PM)?$/i;
const DCP_PREFIX = '✂️ <b>DCP</b>:';
const SYSTEM_PREFIX = '🔔 <b>System</b>:';

export function cleanPath(p: string): string {
  if (!p) return '';
  let cleaned = p;
  const projectDir = currentDir();
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
    cleaned = `${cleaned.slice(0, 15)}...${cleaned.slice(-27)}`;
  }
  return cleaned;
}

export function cleanCommand(cmd: string): string {
  if (!cmd) return '';

  let cleaned = cmd
    .replace(/2>\S*/g, '')
    // Remove | tail -N, | tail, | head -N, or | head
    .replace(/\|\s*(?:tail|head)(?:\s+-\d+)?/g, '');

  // Replace home dir with ~
  const escapedHome = os.homedir().replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
  cleaned = cleaned.replace(new RegExp(escapedHome, 'g'), '~');

  // Clean up trailing/excess spaces and pipes
  cleaned = cleaned.replace(/\s+/g, ' ').trim();
  if (cleaned.endsWith('|')) {
    cleaned = cleaned.slice(0, -1).trim();
  }
  return cleaned;
}

function collapseDcpBlocks(text: string): string {
  if (!text) return '';

  const resultLines: string[] = [];
  let inDcpBlock = false;

  // Progress bars, compression lines, topics, items lines, blanks and timestamps inside a DCP block
  const isDcpNoise = (t: string) =>
    (t.startsWith('│') && t.endsWith('│')) ||
    t.includes('▣ Compression') ||
    t.startsWith('→ Topic:') || t.startsWith('→ Items:') ||
    t === '' ||
    TIME_ONLY_RE.test(t);

  for (const line of text.split('\n')) {
    const trimmed = line.trim();

    if (trimmed.includes('▣ DCP |')) {
      inDcpBlock = true;
      resultLines.push(`${DCP_PREFIX} ${trimmed.replace('▣ DCP |', '').trim()}`);
      continue;
    }

    if (inDcpBlock) {
      if (isDcpNoise(trimmed)) continue;
      inDcpBlock = false;
    }

    resultLines.push(line);
  }

  return resultLines.join('\n').trim();
}

function collapseSystemReminders(text: string): string {
  if (!text) return '';

  // First, strip internal comment markers completely
  const clean = text
    .replace(/<!-- OMO_INTERNAL_INITIATOR -->/g, '')
    .replace(/<!-- OMO_INTERNAL_NOREPLY -->/g, '');

  const resultLines: string[] = [];
  let inReminder = false;
  let reminderTitle = '';

  for (const line of clean.split('\n')) {
    const trimmed = line.trim();

    if (trimmed.startsWith('&lt;system-reminder&gt;') || trimmed.startsWith('<system-reminder>')) {
      inReminder = true;
      reminderTitle = trimmed
        .replace('&lt;system-reminder&gt;', '')
        .replace('<system-reminder>', '')
        .trim();
      continue;
    }

    if (inReminder) {
      if (trimmed.endsWith('&lt;/system-reminder&gt;') || trimmed.endsWith('</system-reminder>')) {
        inReminder = false;
        resultLines.push(`${SYSTEM_PREFIX} ${reminderTitle || 'System Notification'}`);
        continue;
      }
      if (!reminderTitle && trimmed) {
        reminderTitle = trimmed.replace(/[\[\]`]/g, '');
      }
      continue;
    }

    // Skip empty lines or timestamps right after a system reminder or DCP block
    const lastResult = resultLines[resultLines.length - 1];
    if (lastResult && (lastResult.startsWith(SYSTEM_PREFIX) || lastResult.startsWith(DCP_PREFIX))
        && (trimmed === '' || TIME_ONLY_RE.test(trimmed))) {
      continue;
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

    const pathMatch = trimmed.includes('lsp_diagnostics') ? trimmed.match(/filePath=([^\]\s]+)/) : null;
    if (!pathMatch) {
      resultLines.push(line);
      continue;
    }

    const cleanP = cleanPath(pathMatch[1]);
    // Peek next line for "No diagnostics found"
    if (lines[i + 1]?.trim().includes('No diagnostics found')) {
      resultLines.push(`🔎 <b>LSP:</b> <code>${cleanP}</code> (Clean)`);
      i++; // Skip "No diagnostics found" line
      // Skip subsequent empty lines or timestamps
      while (i + 1 < lines.length && (lines[i + 1].trim() === '' || TIME_ONLY_RE.test(lines[i + 1].trim()))) {
        i++;
      }
    } else {
      resultLines.push(`🔎 <b>LSP Diagnostics:</b> <code>${cleanP}</code>`);
    }
  }

  return resultLines.join('\n').trim();
}

// Single-line tool headers, tried in order. First match wins.
const DIFF_HEADER_RULES: [RegExp, (m: RegExpMatchArray) => string][] = [
  [/^[^\w\s]*\s*Edit:?\s+([^\s]+)(.*)$/i, m => `✏️ <b>Edit:</b> <code>${cleanPath(m[1])}</code>${m[2]}`],
  [/^[^\w\s]*\s*Read:?\s+([^\s]+)(.*)$/i, m => `📄 <b>Read:</b> <code>${cleanPath(m[1])}</code>${m[2]}`],
  [/^[^\w\s]*\s*Write:?\s+([^\s]+)(.*)$/i, m => `✏️ <b>Write:</b> <code>${cleanPath(m[1])}</code>${m[2]}`],
  [/^[^\w\s]*\s*Grep\s+(.+?)\s+in\s+(.+)$/i, m => `🔍 <b>Search:</b> <code>${m[1]}</code> in <code>${cleanPath(m[2])}</code>`],
  [/^[^\w\s]*\s*Grep\s+(.+)$/i, m => `🔍 <b>Search:</b> <code>${m[1]}</code>`],
];
const RUNNING_RE = /^(?:#+\s*)?Running\s+in\s+(.+)$/i;

function collapseDiffHeaders(text: string): string {
  if (!text) return '';

  const lines = text.split('\n');
  const resultLines: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    let replaced: string | null = null;
    for (const [re, render] of DIFF_HEADER_RULES) {
      const m = trimmed.match(re);
      if (m) { replaced = render(m); break; }
    }

    if (replaced === null) {
      const running = trimmed.match(RUNNING_RE);
      const nextLine = lines[i + 1];
      if (running && nextLine) {
        replaced = `⚡ <b>Run:</b> <code>${cleanCommand(nextLine.trim())}</code> in <code>${cleanPath(running[1])}</code>`;
        i++;
      }
    }

    resultLines.push(replaced ?? line);
  }

  return resultLines.join('\n');
}

function parseAndFormatTable(tableLines: string[]): string {
  const splitRow = (row: string) =>
    row.split('|').map(c => c.trim()).filter((_, idx, arr) => idx > 0 && idx < arr.length - 1);

  const headers = splitRow(tableLines[0]);
  const dataRows: string[] = [];

  for (let i = 2; i < tableLines.length; i++) {
    const cells = splitRow(tableLines[i]);
    if (cells.length === 0) continue;

    let rowText = `▪️ <b>${headers[0] || 'Key'}:</b> ${cells[0] || '-'}\n`;
    for (let j = 1; j < headers.length; j++) {
      const header = headers[j] || `Col ${j + 1}`;
      if (header.replace(/[-:]/g, '') === '') continue;
      rowText += `  • <b>${header}:</b> ${cells[j] || '-'}\n`;
    }
    dataRows.push(rowText.trimEnd());
  }

  return dataRows.join('\n\n');
}

function formatMarkdownTables(text: string): string {
  if (!text) return '';

  const resultLines: string[] = [];
  let tableLines: string[] = [];

  const flushTable = () => {
    if (tableLines.length === 0) return;
    if (tableLines.length >= 3) resultLines.push(parseAndFormatTable(tableLines));
    else resultLines.push(...tableLines);
    tableLines = [];
  };

  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('|') && trimmed.endsWith('|')) {
      tableLines.push(trimmed);
      continue;
    }
    flushTable();
    resultLines.push(line);
  }
  flushTable();

  return resultLines.join('\n');
}

function cleanHorizontalRulesAndSpaces(text: string): string {
  if (!text) return '';

  return text
    // Horizontal rules (3+ dashes/stars/underscores or hr tags) -> em-dash divider
    .replace(/^\s*(?:-{3,}|\*{3,}|_{3,}|&lt;hr&gt;|&lt;hr\s*\/&gt;|<hr>|<hr\s*\/>)\s*$/gm, '────────────────────')
    // Collapse 3 or more consecutive newlines down to exactly 2
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function convertMarkdownToHtml(text: string): string {
  if (!text) return '';

  return text
    // Code blocks: ```language ... ``` -> <pre>...</pre>
    .replace(/```(?:[a-zA-Z0-9+#-]+)?\n([\s\S]*?)```/g, '<pre>$1</pre>')
    .replace(/```([\s\S]*?)```/g, '<pre>$1</pre>')
    // Inline code
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    // Bold, then italic
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    .replace(/\*([^\*\s][^\*]*[^\*\s]|[^\*\s])\*/g, '<i>$1</i>')
    // Bullet list items: * item -> • item
    .replace(/^\s*\*\s+(.+)$/gm, '• $1')
    // Headers: # Header -> <b>Header</b>
    .replace(/^#+\s+(.+)$/gm, '<b>$1</b>');
}

/** Runs the full cleanup pipeline on HTML-escaped text and converts markdown to Telegram HTML. */
export function cleanAndConvert(escaped: string): string {
  const steps = [
    collapseDcpBlocks,
    collapseSystemReminders,
    collapseLspDiagnostics,
    collapseDiffHeaders,
    formatMarkdownTables,
    cleanHorizontalRulesAndSpaces,
    convertMarkdownToHtml,
  ];
  return steps.reduce((acc, step) => step(acc), escaped);
}
