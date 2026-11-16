/** Recovery decisions apply to provider failures, never to tool permissions. */
import { stripAnsi } from './canvas.js';
export function providerFailure(value, { provider = false } = {}) {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? '');
  const status = Number(value?.statusCode ?? value?.status ?? value?.data?.statusCode);
  if (/permission denied|permission requested|tool execution interrupted|step interrupted|policy.*den(?:ied|y)|provider\.use.*den|access denied/i.test(text)) return { kind: 'permission', retry: false, switchModel: false };
  if (/\b(?:ENOENT|EACCES|ENOSPC|ENOMEM|EMFILE)\b|(?:invalid|malformed).{0,40}config|config.{0,40}(?:invalid|malformed)/i.test(text)) return { kind: 'system', retry: false, switchModel: false };
  if (/\b(?:401|403)\b|invalid.*(?:api[ _-]?key|token)|authentication|unauthori[sz]ed|forbidden|credentials/i.test(text) || status === 401 || status === 403) return { kind: 'authentication', retry: false, switchModel: true };
  if (/provider\.quota|usage[ _-]+limits?|quota|billing|credit|payment[ _-]required|insufficient[ _-]balance|not part of the free tier|spending|budget|limit (?:reached|exceeded|exhausted)|exhausted|depleted/i.test(text) || status === 402) return { kind: 'quota', retry: false, switchModel: true };
  if (/\b(?:408|409|425|429|5\d\d)\b|rate[ _-]?limit|too many(?! tokens)|overloaded|capacity|temporar|timeout|timed out|econnreset|econnrefused|etimedout|enotfound|eai_again|socket|network|fetch failed|connection|empty response|no response|try again|try later/i.test(text) || [408, 409, 425, 429].includes(status) || status >= 500 && status <= 599) return { kind: 'transient', retry: true, switchModel: true };
  if (/no.route|unsupported package|variant unavailable|not.found|not found|unavailable|not supported|does not (?:exist|support)|context.{0,30}(?:length|window|limit)|maximum context|too many tokens|invalid.*(?:request|parameter|json)|malformed|\b(?:400|404|422)\b/i.test(text) || [400, 404, 422].includes(status)) return { kind: 'model', retry: false, switchModel: true };
  return { kind: provider ? 'provider' : 'system', retry: false, switchModel: provider };
}

/** Keep a recoverable attempt visible without marking the task as failed. */
export function recoveryEvent(parsed) {
  if (!parsed?.error) return parsed;
  const failure = providerFailure(parsed.errorDetails ?? parsed.error, { provider: !parsed.tool });
  if (!parsed.tool && failure.kind === 'system') return parsed;
  return {
    ...parsed, providerError: parsed.tool ? null : parsed.error, error: null,
    logEntry: parsed.logEntry ? { ...parsed.logEntry, kind: 'status', status: 'recovering' } : undefined,
    events: (parsed.events ?? []).map((event) => ({ ...event, state: 'working', recovering: true, text: event.text.replace(/✗/g, '↻') })),
  };
}

export function unfinishedRecap(report) {
  const text = stripAnsi(report ?? '').trim().replace(/```[\s\S]*?```|~~~[\s\S]*?~~~/g, '').replace(/^THEFACTORY_TASK_RESULT:.*$/gm, '');
  const headers = [...text.matchAll(/^(?:#{1,3}\s*)?Not finished\s*:?\s*$/gim)];
  if (!headers.length) return '';
  const header = headers.at(-1);
  const tail = text.slice(header.index + header[0].length);
  const end = tail.search(/^(?:#{1,3}\s+|Verification\b)/m);
  const body = (end < 0 ? tail : tail.slice(0, end)).replace(/^\s*[-*]\s*/gm, '').trim();
  return /^(?:none(?: reported)?|nothing remains unfinished|no unfinished (?:items|work)|all requested work (?:is )?completed)[.!]?$/i.test(body) ? '' : body;
}

export function unfinishedResponse(report) {
  const text = String(report ?? '').replace(/```[\s\S]*?```|~~~[\s\S]*?~~~/g, '');
  const marker = [...text.matchAll(/^THEFACTORY_TASK_RESULT:\s*(completed|incomplete)\s*$/gm)].at(-1)?.[1];
  return marker === 'completed' ? '' : unfinishedRecap(text) || (marker === 'incomplete' ? 'The assigned acceptance criteria remain unfinished.' : '');
}
