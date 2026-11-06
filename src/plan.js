/**
 * Planner (parallel wiring, Phase 1): turn the user objective into a task DAG
 * consumable by src/scheduler.js (validateTasks). The planner is executed by
 * the orchestrator model through launchRun; this module holds the prompt
 * builder and pure parsing/normalizing helpers. Zero dependencies.
 */

import { validateTasks } from './scheduler.js';

/** Agents that exist as opencode subagents in theFactory config. */
export const PLANNER_AGENTS = ['explorer', 'architect', 'developer', 'reviewer', 'security', 'tester'];

/**
 * Build the planning prompt for the orchestrator model.
 * The reply contract is a single JSON object `{"tasks":[...]}` — fenced or
 * plain. Constraints mirror validateTasks + the scheduler's parallelism so a
 * well-formed reply is dispatchable as-is: unique ids, DAG deps, disjoint
 * file scopes for independent tasks, bounded size.
 */
export function buildPlanningPrompt(objective, { maxTasks = 6, sequential = false } = {}) {
  const goal = String(objective ?? '').trim();
  const limit = Math.max(1, Math.min(12, maxTasks));
  return [
    'You are a task planner. Decompose the objective below into an execution plan.',
    'Respond with ONLY a JSON object — no prose, no code fences — in exactly this shape:',
    '{"tasks":[{"id":"t1","title":"short title","agent":"explorer","deps":[],"files":["src/x.js"],"readOnly":true,"acceptance":"how to verify"}]}',
    'Rules:',
    `- At most ${limit} task${limit === 1 ? '' : 's'}; drop a category only when pointless.`,
    '- ids are t1, t2, ... unique. deps list earlier ids only (keep it a DAG).',
    '- Two tasks without a dependency path between them MUST NOT share a file in "files".',
    '- Creating or editing files: agent "developer", readOnly false, files = repo-relative paths touched.',
    '- Reading/research/review: readOnly true (explorer, architect, reviewer, security).',
    '- Running/fixing tests: agent "tester", readOnly true.',
    sequential
      ? '- Tasks execute strictly one after another (sequential mode); lean on deps for ordering.'
      : '- Independent tasks run in parallel; deps decide the order.',
    '- Finish with one task that verifies or summarizes the whole objective and depends on its inputs.',
    '',
    `Objective: ${goal}`,
    '',
    'JSON only:',
  ].join('\n');
}

/**
 * Extract the first complete JSON value (object or array) from a model reply.
 * Handles code fences, prose around it, and string-aware bracket matching
 * (brackets inside JSON strings never break the scan).
 */
export function extractPlanJson(text) {
  const raw = String(text ?? '');
  const unfenced = raw.replace(/```(?:json)?\s*([\s\S]*?)```/gi, '$1');
  const start = [unfenced.indexOf('{'), unfenced.indexOf('[')].filter((i) => i !== -1)
    .sort((a, b) => a - b)[0];
  if (start === undefined) return null;
  const open = unfenced[start];
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < unfenced.length; index += 1) {
    const ch = unfenced[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === open) depth += 1;
    else if (ch === close) {
      depth -= 1;
      if (depth === 0) return unfenced.slice(start, index + 1);
    }
  }
  return null;
}

/**
 * Parse the planner reply into scheduler-ready tasks (validateTasks).
 * Unknown agent names are coerced to "developer" so dispatch never targets a
 * nonexistent opencode agent. Throws on unusable output — callers fall back.
 */
export function parsePlan(text) {
  const json = extractPlanJson(text);
  if (!json) throw new Error('no JSON object in planner output');
  let parsed;
  try {
    parsed = JSON.parse(json);
  } catch (error) {
    throw new Error(`planner JSON invalid: ${error?.message ?? error}`);
  }
  const raw = Array.isArray(parsed?.tasks) ? parsed.tasks : Array.isArray(parsed) ? parsed : [];
  for (const task of raw) {
    if (!PLANNER_AGENTS.includes(task?.agent)) task.agent = 'developer';
    if (typeof task?.readOnly !== 'boolean') task.readOnly = task.readOnly !== false;
  }
  return validateTasks(raw);
}

/**
 * Degenerate one-task plan (planner failed or produced garbage). The objective
 * still ships as a single developer worker so the run never blocks the user.
 */
export function fallbackPlan(objective) {
  const goal = String(objective ?? '').trim();
  return validateTasks([
    {
      id: 't1',
      title: goal ? goal.slice(0, 80) : 'objective',
      agent: 'developer',
      deps: [],
      files: [],
      readOnly: goal.length > 0 ? false : true,
    },
  ]);
}
