import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  loadSkills,
  loadSkill,
  createSkillRegistry,
  skillsPrompt,
  skillPrompt,
  defaultSkillsDir,
} from '../src/skills.js';

test('defaultSkillsDir returns FACTORY_SKILLS_DIR or cwd/skills', () => {
  const prev = process.env.FACTORY_SKILLS_DIR;
  delete process.env.FACTORY_SKILLS_DIR;
  assert.equal(defaultSkillsDir(), path.join(process.cwd(), 'skills'));
  process.env.FACTORY_SKILLS_DIR = '/tmp/custom-skills';
  assert.equal(defaultSkillsDir(), '/tmp/custom-skills');
  if (prev === undefined) delete process.env.FACTORY_SKILLS_DIR;
  else process.env.FACTORY_SKILLS_DIR = prev;
});

test('loadSkills returns empty array for missing dir', () => {
  assert.deepEqual(loadSkills('/definitely/does/not/exist'), []);
});

test('loadSkill parses frontmatter and body', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-test-'));
  try {
    const file = path.join(dir, 'code-review.md');
    fs.writeFileSync(file, `---\nname: code-review\nagent: reviewer\ndescription: Review code\ntriggers:\n  - review\n  - pr\n---\n\nBe rigorous.\n`);
    const skill = loadSkill(file);
    assert.equal(skill.name, 'code-review');
    assert.equal(skill.agent, 'reviewer');
    assert.equal(skill.description, 'Review code');
    assert.deepEqual(skill.triggers, ['review', 'pr']);
    assert.equal(skill.body, 'Be rigorous.');
    assert.equal(skill.file, 'code-review.md');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('loadSkill falls back to filename for name when frontmatter lacks it', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-test-'));
  try {
    const file = path.join(dir, 'weird-name.md');
    fs.writeFileSync(file, '---\nagent: developer\n---\n\nBody text.\n');
    const skill = loadSkill(file);
    assert.equal(skill.name, 'weird-name');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('createSkillRegistry indexes by name, agent, and triggers', () => {
  const skills = [
    { name: 'code-review', agent: 'reviewer', description: 'd1', triggers: ['review', 'pr'], file: 'a.md', path: 'a.md', body: 'be rigorous' },
    { name: 'security-audit', agent: 'security', description: 'd2', triggers: ['security', 'audit'], file: 'b.md', path: 'b.md', body: 'hunt risk' },
    { name: 'test-generation', agent: 'tester', description: 'd3', triggers: ['test', 'spec'], file: 'c.md', path: 'c.md', body: 'write tests' },
  ];
  const reg = createSkillRegistry(skills);
  assert.equal(reg.all().length, 3);
  assert.equal(reg.get('code-review').agent, 'reviewer');
  assert.equal(reg.get('nope'), null);
  assert.deepEqual(reg.forAgent('reviewer').map((s) => s.name), ['code-review']);
  assert.deepEqual(reg.forAgent('nonexistent'), []);
});

test('registry.find matches skills by trigger words', () => {
  const skills = [
    { name: 'code-review', agent: 'reviewer', description: 'd1', triggers: ['review', 'pr'], file: 'a.md', path: 'a.md', body: 'be rigorous' },
    { name: 'security-audit', agent: 'security', description: 'd2', triggers: ['security', 'audit'], file: 'b.md', path: 'b.md', body: 'hunt risk' },
    { name: 'test-generation', agent: 'tester', description: 'd3', triggers: ['test', 'spec'], file: 'c.md', path: 'c.md', body: 'write tests' },
  ];
  const reg = createSkillRegistry(skills);
  assert.deepEqual(reg.find('please review this pr').map((s) => s.name), ['code-review']);
  assert.deepEqual(reg.find('security audit the auth flow').map((s) => s.name), ['security-audit']);
  assert.deepEqual(reg.find('write tests for the spec').map((s) => s.name), ['test-generation']);
  assert.deepEqual(reg.find('nothing relevant here'), []);
  assert.deepEqual(reg.find(''), []);
});

test('skillsPrompt builds a prompt fragment', () => {
  const skills = [
    { name: 'code-review', agent: 'reviewer', description: 'Review code', triggers: ['review', 'pr'], file: 'a.md', path: 'a.md', body: 'x' },
  ];
  const reg = createSkillRegistry(skills);
  const out = skillsPrompt(reg);
  assert.ok(out.includes('Available skills'));
  assert.ok(out.includes('code-review → reviewer'));
  assert.ok(out.includes('Review code'));
  assert.ok(out.includes('triggers: review, pr'));
  assert.equal(skillsPrompt(createSkillRegistry([])), '');
});

test('skillPrompt wraps the skill body', () => {
  const skill = { name: 'code-review', agent: 'reviewer', description: 'd', triggers: [], file: 'a.md', path: 'a.md', body: 'Be rigorous.' };
  const out = skillPrompt(skill);
  assert.ok(out.includes('=== SKILL: code-review ==='));
  assert.ok(out.includes('Applies to agent: reviewer'));
  assert.ok(out.includes('Be rigorous.'));
  assert.ok(out.includes('=== END SKILL: code-review ==='));
  assert.equal(skillPrompt(null), '');
});

test('loadSkills loads real skills folder', () => {
  const skills = loadSkills();
  // The repo ships 5 skills; ensure they load and are well-formed.
  assert.ok(skills.length >= 1, `expected skills, got ${skills.length}`);
  const names = new Set(skills.map((s) => s.name));
  assert.ok(names.has('code-review') || names.has('security-audit'), `unexpected skills: ${[...names]}`);
  for (const s of skills) {
    assert.ok(s.name, 'skill missing name');
    assert.ok(s.agent, 'skill missing agent');
    assert.ok(typeof s.body === 'string', 'skill missing body');
  }
});
