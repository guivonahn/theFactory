/**
 * Lightweight inline highlighting for log and feed lines. It follows the
 * OpenCode TUI look: commands, paths, numbers, agent names, status glyphs and
 * success/error words get semantic colours while the rest keeps the base style.
 */

import { AGENT_COLORS, APPLE_UIKIT, themeFor } from './colors.js';

const T = themeFor('dark');

export const HIGHLIGHT_STYLES = Object.freeze({
  keyword: T.accent,
  code: T.info,
  number: APPLE_UIKIT.dark.system.yellow,
  path: T.path,
  link: T.accent,
  key: T.keyHint,
  success: T.success,
  warning: T.warning,
  error: T.error,
  muted: T.textMuted,
});

const AGENT_STYLES = AGENT_COLORS;

// Alternatives are ordered: more specific tokens win over generic words.
const TOKEN_RE = new RegExp([
  /(?<url>https?:\/\/[^\s)>\]]+)/,
  /(?<code>`[^`]+`)/,
  /(?<heading>^#{1,6}\s+[^\n]*)/,
  /(?<command>\/(?:new|fresh|sessions|resume|fallback|models|config|log)\b)/,
  /(?<path>(?:~|\.{1,2})?\/[\w.@%+~\-/]+|(?:[\w.@-]+\/)+[\w.@-]+\.[A-Za-z0-9]+(?::\d+(?::\d+)?)?|[\w.@-]+\.(?:js|ts|tsx|jsx|mjs|cjs|json|md|markdown|py|rs|go|rb|sh|bash|zsh|css|scss|html|yml|yaml|toml|lock|txt|png|jpg|jpeg|gif|webp|svg))(?::\d+(?::\d+)?)?/,
  /(?<agent>\b(?:orchestrator|explorer|architect|developer|reviewer|security|tester)\b)/i,
  /(?<arrow>[←→↑↓])/,
  /(?<key>\besc\b|\benter\b)/i,
  /(?<report>FINISHED TASK REPORT|FAILED TASK REPORT)/,
  /(?<status>[✓✗×⚠▶❓🖼⚒●◐◑◒•»«])/,
  /(?<bang>^!)/,
  /(?<error>\b(?:error|errors|failed|failure|fatal|denied|abort|aborted)\b)/i,
  /(?<success>\b(?:ok|done|complete|completed|success|passed|pass|ready)\b)/i,
  /(?<warning>\b(?:warn|warning|retry|retrying|timeout|blocked|waiting)\b)/i,
  /(?<stat>\b(?:msgs?|tools?|tok|kb|mb|gb|sess(?:ion)?s?|entries?|agents?|workers?|steps?)\b)/i,
  /(?<number>\b\d+(?:\.\d+)?(?:%|ms|s|m|k|kb|mb|gb|w)?\b)/i,
  /(?<keyword>\b(?:read|write|edit|grep|glob|bash|task|webfetch|subagent|config|profile|verbose|graphify|fallback|model|session|opencode|git|npm|node|run|build|test|plan|update|install|status|parallel|worker|prompt|reply|form|image|popup)\b)/i,
].map((pattern) => pattern.source).join('|'), 'giu');

function styleForStatus(glyph) {
  if (glyph === '✓') return HIGHLIGHT_STYLES.success;
  if (glyph === '⚠' || glyph === '⚒') return HIGHLIGHT_STYLES.warning;
  if (glyph === '✗' || glyph === '×') return HIGHLIGHT_STYLES.error;
  if (glyph === '❓' || glyph === '🖼' || glyph === '▶' || glyph === '»' || glyph === '«') {
    return HIGHLIGHT_STYLES.keyword;
  }
  return HIGHLIGHT_STYLES.muted;
}

/**
 * Split one line into `{text, style}` runs. Plain text keeps `baseStyle`.
 * Reconstructing the runs with `.text` always returns the input unchanged.
 */
export function highlightLine(text, baseStyle = T.textPrimary) {
  const line = String(text ?? '');
  if (!line) return [];
  const segments = [];
  const push = (value, style) => {
    if (!value) return;
    const previous = segments[segments.length - 1];
    if (previous && previous.style === style) previous.text += value;
    else segments.push({ text: value, style });
  };

  let last = 0;
  for (const match of line.matchAll(TOKEN_RE)) {
    const index = match.index ?? 0;
    if (index > last) push(line.slice(last, index), baseStyle);
    const groups = match.groups ?? {};
    let style = baseStyle;
    if (groups.url || groups.link) style = HIGHLIGHT_STYLES.link;
    else if (groups.code) style = HIGHLIGHT_STYLES.code;
    else if (groups.heading || groups.command) style = HIGHLIGHT_STYLES.keyword;
    else if (groups.path) style = HIGHLIGHT_STYLES.path;
    else if (groups.agent) style = AGENT_STYLES[groups.agent.toLowerCase()] ?? HIGHLIGHT_STYLES.keyword;
    else if (groups.arrow || groups.key) style = HIGHLIGHT_STYLES.key;
    else if (groups.status) style = styleForStatus(groups.status);
    else if (groups.report) style = groups.report.includes('FAILED')
      ? HIGHLIGHT_STYLES.error
      : HIGHLIGHT_STYLES.success;
    else if (groups.bang || groups.error) style = HIGHLIGHT_STYLES.error;
    else if (groups.success) style = HIGHLIGHT_STYLES.success;
    else if (groups.warning) style = HIGHLIGHT_STYLES.warning;
    else if (groups.stat) style = HIGHLIGHT_STYLES.key;
    else if (groups.number) style = HIGHLIGHT_STYLES.number;
    else if (groups.keyword) style = HIGHLIGHT_STYLES.keyword;
    push(match[0], style);
    last = index + match[0].length;
  }
  if (last < line.length) push(line.slice(last), baseStyle);
  return segments;
}
