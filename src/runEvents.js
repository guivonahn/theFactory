/** Route supervised native-child output without replacing the parent's recap/session. */
import { resolveAgent } from './agents.js';

export function applySubagentEvent(app, parsed) {
  if (!parsed?.isSubagent) return false;
  const agent = resolveAgent(parsed.agent).key;
  if (parsed.sessionID) app.setAgentRuntime(agent, { sessionID: parsed.sessionID });
  if (parsed.logEntry) app.recordAgentLog(agent, parsed.logEntry);
  else if (parsed.text) app.recordAgentLog(agent, { kind: 'message', dir: 'in', text: parsed.text, sessionID: parsed.sessionID });
  for (const event of parsed.events ?? []) app.applyEvent({ ...event, from: agent, sessionID: parsed.sessionID, logRecorded: Boolean(parsed.logEntry) });
  return true;
}
