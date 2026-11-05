/**
 * Isolated concurrent workspaces (Phase 4): Git worktrees for write-capable tasks.
 * Read-only tasks share the project dir (no races). Scoped under a caller-provided
 * parent dir (tests use safe temp dirs, never the original project). Zero deps
 * beyond node:child_process / node:fs.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, basename } from 'node:path';

function git(args, cwd) {
  return execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
}

function isGitRepo(dir) {
  try { git(['rev-parse', '--is-inside-work-tree'], dir); return true; } catch { return false; }
}

function headRev(dir) {
  try { return git(['rev-parse', 'HEAD'], dir).trim(); } catch { return null; }
}

function dirtyFiles(dir) {
  try {
    const out = git(['status', '--porcelain'], dir);
    return out.split('\n').filter(Boolean).map((l) => l.slice(3).trim()).filter(Boolean);
  } catch { return []; }
}

/**
 * Create (or reuse) an isolated worktree for one write task.
 * Returns { dir, taskId, baseRev, readOnly:false }.
 * Non-git projects: reports { unsupported:true } explicitly.
 */
export function createWorkspace({ projectDir, taskId, parentDir, readOnly = false } = {}) {
  if (!projectDir || !taskId || !parentDir) throw new Error('projectDir, taskId, parentDir are required');
  mkdirSync(parentDir, { recursive: true });
  if (readOnly) return { dir: projectDir, taskId, baseRev: headRev(projectDir), readOnly: true };
  if (!isGitRepo(projectDir)) return { dir: null, taskId, unsupported: true, readOnly: false, error: 'not a git repo' };
  const baseRev = headRev(projectDir);
  const safeId = String(taskId).replace(/[^A-Za-z0-9_-]/g, '_');
  const wsDir = join(parentDir, safeId);
  // Preserve dirty user changes: if project has uncommitted changes, record them
  // in the manifest but do NOT auto-clean or reset.
  const dirty = dirtyFiles(projectDir);
  try {
    git(['worktree', 'add', '--detach', wsDir, baseRev ?? 'HEAD'], projectDir);
  } catch (error) {
    throw new Error(`worktree create failed for ${taskId}: ${String(error?.message ?? error).slice(0, 200)}`);
  }
  const manifest = { taskId, dir: wsDir, baseRev, dirtyAtCreate: dirty, branch: null };
  try { writeFileSync(join(wsDir, '.factory-workspace.json'), `${JSON.stringify(manifest, null, 2)}\n`); } catch {}
  return { dir: wsDir, taskId, baseRev, dirtyAtCreate: dirty, readOnly: false };
}

/** Changed-file manifest (relative paths) for a workspace vs base rev. */
export function changedFiles(workspaceDir) {
  if (!workspaceDir || !existsSync(workspaceDir)) return [];
  try {
    const out = git(['status', '--porcelain'], workspaceDir);
    return out.split('\n').filter(Boolean).map((l) => l.slice(3).trim()).filter(Boolean);
  } catch { return []; }
}

/** Overlap check: files written by more than one workspace. */
export function overlappingFiles(manifests = []) {
  const seen = new Map();
  for (const m of manifests) {
    for (const f of m.files ?? []) {
      seen.set(f, [...(seen.get(f) ?? []), m.taskId]);
    }
  }
  return [...seen.entries()].filter(([, ids]) => new Set(ids).size > 1).map(([file, taskIds]) => ({ file, taskIds: [...new Set(taskIds)] }));
}

/** Base-revision mismatch check (caller provides current HEAD). */
export function baseMismatch(workspace, currentRev) {
  if (!workspace?.baseRev || !currentRev) return false;
  return workspace.baseRev !== currentRev;
}

/** Remove a worktree owned by this run (never touches the original project dir). */
export function removeWorkspace({ projectDir, workspaceDir } = {}) {
  if (!projectDir || !workspaceDir || workspaceDir === projectDir) return false;
  try { git(['worktree', 'remove', '--force', workspaceDir], projectDir); return true; }
  catch { return false; }
}
