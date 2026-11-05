/**
 * `opencode serve` client for the parallel engine (long-term worker backend).
 * Verified routes (v2.0.15): session create, prompt, messages, permission
 * list/get, permission reply (decision field), session delete.
 * Decision enum values remain UNVERIFIED (quota 429) — callers must pass
 * the literal decision string; this client does not guess/approve for them.
 * Zero dependencies (global fetch). All methods need a live server base URL.
 */

function authHeader(password) {
  return `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`;
}

export function createServeClient({ baseUrl, password } = {}) {
  if (!baseUrl || !password) throw new Error('baseUrl and password are required');
  const base = String(baseUrl).replace(/\/+$/, '');
  const headers = { Authorization: authHeader(password), 'Content-Type': 'application/json' };

  async function request(method, path, body) {
    const res = await fetch(`${base}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    if (!res.ok) {
      const err = new Error(`server ${method} ${path} → ${res.status}: ${text.slice(0, 300)}`);
      err.status = res.status;
      err.json = json;
      throw err;
    }
    return json;
  }

  return {
    // POST /api/session {title, model?} → {data:{id,...}}
    async createSession(title, extra = {}) {
      const json = await request('POST', '/api/session', { title: title ?? 'theFactory worker', ...extra });
      const id = json?.data?.id ?? json?.id;
      if (!id) throw new Error(`session create returned no id: ${JSON.stringify(json).slice(0, 200)}`);
      return { id, raw: json };
    },
    // POST /api/session/:id/prompt {text} → user message (async steer)
    prompt(sessionId, text) {
      if (!sessionId) throw new Error('sessionId is required');
      return request('POST', `/api/session/${sessionId}/prompt`, { text: String(text ?? '') });
    },
    // GET /api/session/:id/message?limit=n
    messages(sessionId, limit = 20) {
      if (!sessionId) throw new Error('sessionId is required');
      return request('GET', `/api/session/${sessionId}/message?limit=${limit}`);
    },
    // GET /api/session/:id/permission → {data:[pending...]}
    pendingPermissions(sessionId) {
      if (!sessionId) throw new Error('sessionId is required');
      return request('GET', `/api/session/${sessionId}/permission`);
    },
    // GET /api/session/:id/permission/:requestID
    getPermission(sessionId, requestId) {
      if (!sessionId || !requestId) throw new Error('sessionId and requestId are required');
      return request('GET', `/api/session/${sessionId}/permission/${requestId}`);
    },
    // POST /api/session/:id/permission/:requestID/reply {decision}
    replyPermission(sessionId, requestId, decision) {
      if (!sessionId || !requestId || !decision) throw new Error('sessionId, requestId and decision are required');
      return request('POST', `/api/session/${sessionId}/permission/${requestId}/reply`, { decision });
    },
    // DELETE /api/session/:id
    deleteSession(sessionId) {
      if (!sessionId) throw new Error('sessionId is required');
      return request('DELETE', `/api/session/${sessionId}`);
    },
    // GET /api/config (health / readiness)
    config() {
      return request('GET', '/api/config');
    },
  };
}

/**
 * Start one `opencode serve` child (ephemeral port). Returns { baseUrl, password, kill }.
 * Uses the installed `opencode` binary; spawns on 127.0.0.1 with random port.
 * Polls /api/config until ready or timeout.
 */
export async function startServe({ binary = 'opencode', hostname = '127.0.0.1', timeoutMs = 15000, port = 0 } = {}) {
  const { spawn } = await import('node:child_process');
  const actualPort = port || (49152 + Math.floor(Math.random() * 8000));
  const child = spawn(binary, ['serve', '--port', String(actualPort), '--hostname', hostname], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let password = null;
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    stderr = `${stderr}${chunk}`.slice(-4000);
    const m = String(chunk).match(/server password\s+(\S+)/);
    if (m) password = m[1];
  });
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    if (password) {
      try {
        const client = createServeClient({ baseUrl: `http://${hostname}:${actualPort}`, password });
        await client.config();
        return { baseUrl: `http://${hostname}:${actualPort}`, password, kill: () => { try { child.kill('SIGTERM'); } catch {} }, child };
      } catch (error) { lastError = error; }
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  try { child.kill('SIGTERM'); } catch {}
  throw new Error(`serve did not become ready in ${timeoutMs}ms${lastError ? `: ${lastError.message}` : ''}; stderr: ${stderr.slice(-300)}`);
}
