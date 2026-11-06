/**
 * Skill registry for theFactory.
 *
 * Skill files live in `skills/` (default `skills/` next to the repo root) and
 * use markdown with YAML frontmatter:
 *
 *   ---
 *   name: code-review
 *   agent: reviewer
 *   description: Review code changes for quality and bugs
 *   triggers:
 *     - review
 *     - pr
 *     - diff
 *   ---
 *
 *   Instructions for the reviewer agent...
 *
 * The orchestrator loads skills at startup, matches incoming objectives against
 * skill triggers, and passes the matching skill body into the worker prompt so
 * the specialized agent behaves according to the skill.
 *
 * Zero dependencies: frontmatter is parsed with a tiny hand-rolled parser for
 * the scalar/array subset we use (no `js-yaml`).
 */

import fs from 'node:fs';
import path from 'node:path';

/** Default skills directory, overridable via FACTORY_SKILLS_DIR. */
export function defaultSkillsDir() {
  return process.env.FACTORY_SKILLS_DIR ?? path.join(process.cwd(), 'skills');
}

/** Parse a subset of YAML frontmatter: scalars and inline/block arrays. */
function parseFrontmatter(raw) {
  const meta = {};
  let inArrayKey = null;
  let arrayIndent = null;

  for (const line of raw.split('\n')) {
    if (inArrayKey !== null) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      const m = trimmed.match(/^-\s+(.*)$/);
      if (m) {
        meta[inArrayKey].push(m[1].trim().replace(/^['"]|['"]$/g, ''));
        const indent = line.search(/\S|$/);
        if (arrayIndent === null) arrayIndent = indent;
        continue;
      }
      // End of array block when indentation drops or a new key appears.
      if (/^[a-zA-Z]/.test(trimmed) && line.search(/\S/) <= (arrayIndent ?? 0)) {
        inArrayKey = null;
        arrayIndent = null;
        // fall through to parse this line as a key below
      } else {
        continue;
      }
    }
    const kv = line.match(/^([a-zA-Z_][\w-]*):\s*(.*)$/);
    if (!kv) continue;
    const key = kv[1];
    const val = kv[2].trim();
    if (val === '') {
      inArrayKey = key;
      arrayIndent = null;
      meta[key] = [];
      continue;
    }
    // Inline array: [a, b, c]
    const arr = val.match(/^\[(.*)\]$/);
    if (arr) {
      meta[key] = arr[1]
        .split(',')
        .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
        .filter(Boolean);
      continue;
    }
    // Quoted scalar
    const q = val.match(/^['"](.*)['"]$/);
    meta[key] = q ? q[1] : val;
  }
  return meta;
}

/** Strip YAML frontmatter from markdown, returning { meta, body }. */
function splitFrontmatter(text) {
  const raw = String(text ?? '');
  if (!raw.startsWith('---\n')) return { meta: {}, body: raw };
  const end = raw.indexOf('\n---', 4);
  if (end === -1) return { meta: {}, body: raw };
  const fm = raw.slice(4, end);
  const body = raw.slice(end + 4);
  // Strip a single leading newline left after the closing fence.
  const cleanBody = body.startsWith('\n') ? body.slice(1) : body;
  return { meta: parseFrontmatter(fm), body: cleanBody };
}

/**
 * A loaded skill:
 *   { name, agent, description, triggers: string[], file, body, path }
 */
export function loadSkill(file) {
  const text = fs.readFileSync(file, 'utf8');
  const { meta, body } = splitFrontmatter(text);
  const name = meta.name ?? path.basename(file, path.extname(file));
  const triggers = Array.isArray(meta.triggers) ? meta.triggers : [];
  return {
    name,
    agent: meta.agent ?? 'developer',
    description: meta.description ?? '',
    triggers: triggers.map((t) => String(t).toLowerCase()),
    file: path.basename(file),
    path: file,
    body: body.trim(),
  };
}

/** Load all `.md` skill files from a directory. Returns [] if missing. */
export function loadSkills(dir = defaultSkillsDir()) {
  if (!fs.existsSync(dir)) return [];
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .sort()
    .map((f) => path.join(dir, f));
  const skills = [];
  for (const file of files) {
    try { skills.push(loadSkill(file)); } catch {
      // A malformed skill never kills the factory.
    }
  }
  return skills;
}

/** Create a registry from loaded skills. */
export function createSkillRegistry(skills = []) {
  const byName = new Map();
  const byAgent = new Map();
  for (const skill of skills) {
    byName.set(skill.name, skill);
    const list = byAgent.get(skill.agent) ?? [];
    list.push(skill);
    byAgent.set(skill.agent, list);
  }
  const triggerIndex = new Map();
  for (const skill of skills) {
    for (const trigger of skill.triggers) {
      const set = triggerIndex.get(trigger) ?? new Set();
      set.add(skill.name);
      triggerIndex.set(trigger, set);
    }
  }

  function find(text) {
    const words = new Set(String(text ?? '').toLowerCase().split(/\W+/).filter(Boolean));
    const matches = new Set();
    for (const word of words) {
      const set = triggerIndex.get(word);
      if (set) for (const name of set) matches.add(name);
    }
    return [...matches].map((name) => byName.get(name));
  }

  return {
    skills,
    byName,
    byAgent,
    find,
    get(name) { return byName.get(name) ?? null; },
    forAgent(agent) { return (byAgent.get(agent) ?? []).slice(); },
    all() { return skills.slice(); },
  };
}

/** Build a prompt fragment that lists available skills for the orchestrator. */
export function skillsPrompt(registry) {
  const skills = registry.all();
  if (skills.length === 0) return '';
  const lines = [
    '',
    'Available skills (delegate matching tasks to the named agent):',
  ];
  for (const skill of skills) {
    lines.push(
      `- ${skill.name} → ${skill.agent}: ${skill.description} (triggers: ${skill.triggers.join(', ')})`,
    );
  }
  lines.push('When an objective matches a skill, prefer assigning the task to that skill\'s agent.');
  return lines.join('\n');
}

/** Build a worker prompt prefix that injects a matched skill's instructions. */
export function skillPrompt(skill) {
  if (!skill) return '';
  return [
    '',
    `=== SKILL: ${skill.name} ===`,
    `Applies to agent: ${skill.agent}`,
    skill.body,
    `=== END SKILL: ${skill.name} ===`,
    '',
  ].join('\n');
}
