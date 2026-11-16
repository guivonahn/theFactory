import { charWidth, stripAnsi } from './canvas.js';
import { highlightCode, highlightLine } from './highlight.js';
import { themeFor } from './colors.js';

const T = themeFor('dark');
export const LOG_FILTERS = ['all', 'messages', 'tools', 'errors'];

export function logMatches(entry, filter) {
  if (filter === 'errors' && ['recovering', 'blocked'].includes(entry.status)) return false;
  if (filter === 'messages') return entry.kind === 'msg' || entry.kind === 'message';
  if (filter === 'tools') return entry.kind === 'tool';
  if (filter === 'errors') return entry.kind === 'error' || entry.status === 'error' || entry.kind === 'status' && /(?:^!|[✗⚠]|\b(?:failed|error|denied|aborted)\b)/i.test(entry.text);
  return true;
}

/** Wrap by terminal cells, retaining indentation and per-token colors. */
export function wrapLogSegments(segments, width, wordWrap = true) {
  const rows = [];
  let current = []; let used = 0;
  const flush = () => { rows.push({ segments: current, text: current.map((s) => s.text).join('') }); current = []; used = 0; };
  const chars = segments.flatMap((segment) => Array.from(stripAnsi(segment.text)).map((text) => ({ text, style: segment.style })));
  for (let index = 0; index < chars.length; index += 1) {
    const char = chars[index];
    if (wordWrap && used && /\S/.test(char.text) && (index === 0 || /\s/.test(chars[index - 1].text))) {
      let nextWidth = 0;
      for (let j = index; j < chars.length && /\S/.test(chars[j].text); j += 1) nextWidth += charWidth(chars[j].text);
      if (nextWidth <= width && used + nextWidth > width) flush();
    }
    const size = charWidth(char.text);
    if (used + size > width) flush();
    const last = current.at(-1);
    if (last?.style === char.style) last.text += char.text;
    else current.push({ ...char });
    used += size;
  }
  if (current.length || rows.length === 0) flush();
  return rows;
}

function formatAt(entry) {
  if (Number.isFinite(entry.timestamp) && Number.isFinite(new Date(entry.timestamp).getTime())) return new Date(entry.timestamp).toLocaleTimeString('en-GB', { hour12: false });
  const seconds = Math.floor((entry.at ?? 0) / 1000);
  return `+${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}

export function formatLogEntries(entries, width) {
  const rows = [];
  for (const entry of entries) {
    const isError = logMatches(entry, 'errors');
    const label = entry.kind === 'tool' ? `TOOL · ${entry.tool ?? 'tool'}` : entry.kind === 'msg' || entry.kind === 'message' ? (entry.dir === 'out' ? 'PROMPT' : 'RESPONSE') : isError ? 'ERROR' : 'STATUS';
    const detail = [entry.status, Number.isFinite(entry.durationMs) ? `${Math.round(entry.durationMs)}ms` : null, Number.isFinite(entry.tokens) ? `${entry.tokens} tokens` : null].filter(Boolean).join(' · ');
    const header = `${formatAt(entry)}  ${label}${detail ? ` · ${detail}` : ''}`;
    rows.push(...wrapLogSegments([{ text: header, style: isError ? T.error : T.textSecondary }], width));
    let language = null;
    const content = stripAnsi(entry.text ?? '').replace(/\r\n/g, '\n');
    for (const line of content.split('\n')) {
      const fence = line.match(/^\s*(```+|~~~+)([\w+-]*)/);
      if (fence) {
        language = language === null ? fence[2] || 'code' : null;
        rows.push(...wrapLogSegments([{ text: line, style: T.info }], width, false));
        continue;
      }
      const segments = language !== null ? highlightCode(line, language) : highlightLine(line);
      rows.push(...wrapLogSegments(segments, width, language === null));
    }
    rows.push({ text: '', segments: [] });
  }
  return rows;
}

/** Full tool content, with a bounded history budget and visible truncation. */
export function toolLogEntry(part, { timestamp, sessionID, model } = {}) {
  const input = part.state?.input ?? part.input ?? {};
  const tool = part.tool ?? part.name ?? 'tool';
  const state = part.state ?? {};
  const blocks = [];
  if (typeof input.command === 'string') blocks.push(`\`\`\`sh\n${input.command}\n\`\`\``);
  else if (Object.keys(input).length) blocks.push(`Input\n\`\`\`json\n${JSON.stringify(input, null, 2)}\n\`\`\``);
  if (typeof input.oldString === 'string' || typeof input.newString === 'string') {
    const diff = [...String(input.oldString ?? '').split('\n').map((line) => `- ${line}`), ...String(input.newString ?? '').split('\n').map((line) => `+ ${line}`)].join('\n');
    blocks.push(`Changes\n\`\`\`diff\n${diff}\n\`\`\``);
  }
  const output = state.output ?? part.output;
  const extension = String(input.filePath ?? input.path ?? '').split('.').at(-1)?.toLowerCase();
  const languages = { js: 'javascript', ts: 'typescript', tsx: 'tsx', jsx: 'jsx', json: 'json', py: 'python', sh: 'sh', sql: 'sql', css: 'css', html: 'html', go: 'go', rs: 'rust' };
  const outputLanguage = typeof output === 'object' ? 'json' : /read|cat/i.test(tool) ? languages[extension] ?? 'text' : 'text';
  if (output != null) blocks.push(`Output\n\`\`\`${outputLanguage}\n${typeof output === 'string' ? output : JSON.stringify(output, null, 2)}\n\`\`\``);
  if (state.error) blocks.push(`Error\n${state.error}`);
  const text = blocks.join('\n\n') || state.title || tool;
  const start = state.time?.start; const end = state.time?.end;
  return {
    id: part.id, kind: 'tool', tool, status: state.status ?? 'running',
    text: text.length > 32000 ? `${text.slice(0, 32000)}\n[tool content truncated at 32,000 characters]` : text,
    durationMs: Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, end - start) : undefined,
    timestamp, sessionID, model,
  };
}
