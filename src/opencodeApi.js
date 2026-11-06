/** Small promise wrapper around the shared server's `opencode api` CLI. */

import { spawn } from 'node:child_process';

function concise(value, fallback) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (!text) return fallback;
  return text.length <= 240 ? text : `…${text.slice(-239)}`;
}

/**
 * Run one API request without a shell. The result is always resolved as
 * `{ok, data, raw, error}` so polling and form cancellation can stay tolerant.
 */
export function apiRequest(method, path, body, {
  bin = 'opencode',
  timeout = 5000,
  spawnFn,
} = {}) {
  const args = ['api', String(method).toLowerCase(), String(path)];
  if (body !== undefined && body !== null) args.push('--data', JSON.stringify(body));
  const launch = spawnFn ?? spawn;

  return new Promise((resolve) => {
    let child;
    try {
      child = launch(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      resolve({ ok: false, data: null, raw: '', error: concise(error?.message, 'unable to start opencode') });
      return;
    }

    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ raw: stdout, ...result });
    };

    child.stdout?.setEncoding?.('utf8');
    child.stderr?.setEncoding?.('utf8');
    child.stdout?.on('data', (chunk) => { stdout = `${stdout}${chunk}`.slice(-1_000_000); });
    child.stderr?.on('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(-8_000); });

    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGKILL'); } catch {}
      finish({ ok: false, data: null, error: `opencode api timed out after ${timeout}ms` });
    }, Math.max(1, timeout));

    child.once('error', (error) => {
      const message = error?.code === 'ENOENT'
        ? `opencode binary not found: ${bin}`
        : concise(error?.message, 'opencode api failed');
      finish({ ok: false, data: null, error: message });
    });

    child.once('close', (code) => {
      if (timedOut) return;
      if (code !== 0) {
        finish({
          ok: false,
          data: null,
          error: concise(stderr, `opencode api exited with code ${code}`),
        });
        return;
      }
      if (!stdout.trim()) {
        finish({ ok: true, data: null, error: null });
        return;
      }
      try {
        finish({ ok: true, data: JSON.parse(stdout), error: null });
      } catch {
        finish({ ok: false, data: null, error: 'opencode api returned invalid JSON' });
      }
    });
  });
}

export function formAnswerBody(answer) {
  return { answer };
}
