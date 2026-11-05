/**
 * Integration (Phase 5): collect per-task manifests, detect conflicts,
 * never silently pick one version. Zero dependencies (fs only).
 */

import { readFileSync, existsSync, cpSync, mkdirSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';

/**
 * Detect file-level conflicts across workspace manifests.
 * manifests: [{ taskId, dir, files: string[] }]
 * → { conflicts: [{ file, taskIds }], clean: boolean }
 */
export function detectConflicts(manifests = []) {
  const byFile = new Map();
  for (const m of manifests) {
    for (const f of m.files ?? []) {
      byFile.set(f, [...(byFile.get(f) ?? []), m.taskId]);
    }
  }
  const conflicts = [];
  for (const [file, taskIds] of byFile.entries()) {
    if (new Set(taskIds).size > 1) conflicts.push({ file, taskIds: [...new Set(taskIds)] });
  }
  conflicts.sort((a, b) => a.file.localeCompare(b.file));
  return { conflicts, clean: conflicts.length === 0 };
}

/**
 * Apply non-conflicting changed files into integrationDir.
 * Returns { applied: string[], blocked: conflicts[] }.
 * Conflicting files are NEVER copied — both inputs stay in their workspaces.
 * Optionally runs `verify(files)` hook (caller supplies tests).
 */
export function integrate({ manifests = [], integrationDir, verify = null } = {}) {
  if (!integrationDir) throw new Error('integrationDir is required');
  mkdirSync(integrationDir, { recursive: true });
  const { conflicts } = detectConflicts(manifests);
  const conflictFiles = new Set(conflicts.map((c) => c.file));
  const applied = [];
  for (const m of manifests) {
    if (!m.dir || !existsSync(m.dir)) continue;
    for (const file of m.files ?? []) {
      if (conflictFiles.has(file)) continue; // never silently pick
      const src = join(m.dir, file);
      if (!existsSync(src)) continue;
      const dest = join(integrationDir, file);
      mkdirSync(dirname(dest), { recursive: true });
      try { cpSync(src, dest, { force: true }); applied.push(`${m.taskId}:${file}`); } catch {}
    }
  }
  let verification = null;
  if (typeof verify === 'function') {
    try { verification = verify(applied); } catch (error) { verification = { ok: false, error: String(error?.message ?? error) }; }
  }
  return {
    applied,
    blocked: conflicts,
    clean: conflicts.length === 0,
    verification,
    note: conflicts.length ? 'blocked: conflicting files preserved in workspaces' : 'integrated cleanly',
  };
}
