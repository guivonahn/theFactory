/** Self-contained dashboard page. Kept as a template string so the proxy has zero build steps. */
export function dashboardHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>opencode-nolimit · Free AI proxy</title>
<style>
  :root{
    --bg:#0b0e14; --panel:#131722; --panel2:#1a2030; --border:#232b3d;
    --text:#e8ecf4; --muted:#8b95ab; --accent:#5b8cff; --accent2:#8b5bff;
    --good:#34d399; --warn:#fbbf24; --bad:#f87171;
  }
  *{box-sizing:border-box;margin:0;padding:0}
  body{background:var(--bg);color:var(--text);font:15px/1.55 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;min-height:100vh;
       background-image:radial-gradient(1200px 500px at 80% -10%,rgba(91,140,255,.14),transparent 60%),
                        radial-gradient(900px 400px at 10% 110%,rgba(139,91,255,.12),transparent 60%);}
  .wrap{max-width:1080px;margin:0 auto;padding:28px 20px 80px}
  header{display:flex;align-items:center;gap:14px;flex-wrap:wrap;margin-bottom:26px}
  .logo{width:46px;height:46px;border-radius:12px;display:grid;place-items:center;font-weight:800;color:#fff;
        background:linear-gradient(135deg,var(--accent),var(--accent2));box-shadow:0 8px 24px rgba(91,140,255,.35)}
  h1{font-size:22px;letter-spacing:.2px}
  .sub{color:var(--muted);font-size:13px;margin-top:2px}
  .status{margin-left:auto;display:flex;align-items:center;gap:8px;background:var(--panel);border:1px solid var(--border);
          padding:8px 14px;border-radius:999px;font-size:13px}
  .dot{width:9px;height:9px;border-radius:50%;background:var(--warn);animation:pulse 1.6s infinite}
  .dot.ok{background:var(--good);animation:none}
  .dot.bad{background:var(--bad);animation:none}
  @keyframes pulse{50%{opacity:.35}}
  .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:18px;margin-top:22px}
  .card{background:var(--panel);border:1px solid var(--border);border-radius:16px;padding:20px}
  .card h2{font-size:14px;text-transform:uppercase;letter-spacing:1px;color:var(--muted);margin-bottom:14px}
  .key-row{display:flex;align-items:center;gap:10px;padding:9px 12px;background:var(--panel2);border:1px solid var(--border);
           border-radius:10px;margin-bottom:8px;font-family:ui-monospace,Menlo,monospace;font-size:12.5px;word-break:break-all}
  .key-row span:first-child{color:var(--muted);flex:none;font-size:11px;text-transform:uppercase}
  .copy{margin-left:auto;flex:none;border:1px solid var(--border);background:transparent;color:var(--text);border-radius:8px;
        padding:4px 10px;font-size:12px;cursor:pointer;transition:.15s}
  .copy:hover{border-color:var(--accent);color:var(--accent)}
  .model{display:flex;align-items:center;gap:10px;padding:10px 12px;background:var(--panel2);border:1px solid var(--border);
         border-radius:10px;margin-bottom:8px;font-family:ui-monospace,Menlo,monospace;font-size:13px}
  .model .rel{margin-left:auto;font-size:10.5px;padding:3px 9px;border-radius:999px;flex:none}
  .rel.solid{background:rgba(52,211,153,.15);color:var(--good)}
  .rel.rate-limited{background:rgba(251,191,36,.14);color:var(--warn)}
  .rel.intermittent{background:rgba(248,113,113,.14);color:var(--bad)}
  label{display:block;font-size:12.5px;color:var(--muted);margin:12px 0 6px}
  textarea,select,input[type=text]{width:100%;background:var(--panel2);border:1px solid var(--border);color:var(--text);
        border-radius:10px;padding:10px 12px;font:13px/1.5 ui-monospace,Menlo,monospace;resize:vertical}
  select{cursor:pointer}
  button.primary{background:linear-gradient(135deg,var(--accent),var(--accent2));color:#fff;border:none;border-radius:10px;
        padding:10px 22px;font-weight:600;font-size:14px;cursor:pointer;margin-top:14px;transition:.15s}
  button.primary:hover{filter:brightness(1.1)}
  button.primary:disabled{opacity:.5;cursor:wait}
  .out{background:#0a0d12;border:1px solid var(--border);border-radius:10px;padding:12px;margin-top:12px;
       font:12.5px/1.6 ui-monospace,Menlo,monospace;white-space:pre-wrap;max-height:280px;overflow:auto;display:none}
  code{background:var(--panel2);padding:2px 6px;border-radius:6px;font-size:12.5px;color:#9ecbff}
  a{color:var(--accent)}
  .hint{color:var(--muted);font-size:13px;margin-top:8px}
  .flash{color:var(--good);font-size:12px}
</style>
</head>
<body>
<div class="wrap">
  <header>
    <div class="logo">⟳</div>
    <div>
      <h1>opencode-nolimit</h1>
      <div class="sub">Free AI models (DeepSeek &amp; friends) as OpenAI / Anthropic APIs — rate limits auto-retried with fresh sessions.</div>
    </div>
    <div class="status"><span class="dot" id="dot"></span><span id="statusText">checking…</span></div>
  </header>

  <div class="grid">
    <div class="card">
      <h2>API key</h2>
      <div id="keys"></div>
      <button class="copy" id="rotateBtn" style="margin-top:10px">⟳ rotate key</button>
      <div class="hint">Use either <code>Authorization: Bearer KEY</code> or <code>x-api-key: KEY</code>. Rotating invalidates the old key.</div>
    </div>

    <div class="card">
      <h2>Quick test</h2>
      <label for="model">Model</label>
      <select id="model"></select>
      <label for="prompt">Prompt</label>
      <textarea id="prompt" rows="3">Jelaskan opencode-nolimit dalam satu kalimat, dalam Bahasa Indonesia.</textarea>
      <label><input type="checkbox" id="streamChk" checked style="width:auto;vertical-align:-2px"/> stream</label>
      <button class="primary" id="runBtn">Run</button>
      <div class="out" id="out"></div>
    </div>
  </div>

  <div class="grid">
    <div class="card">
      <h2>Models <span class="flash" id="modelsMeta"></span></h2>
      <div id="models"></div>
      <button class="copy" id="refreshModelsBtn" style="margin-top:10px">↻ sync from models.dev</button>
    </div>

    <div class="card">
      <h2>Use it with</h2>
      <label>curl</label>
      <textarea id="curlSnippet" rows="4" readonly></textarea>
      <label>opencode CLI — ~/.config/opencode/opencode.jsonc</label>
      <textarea id="ocSnippet" rows="8" readonly></textarea>
      <label>Cursor / Continue / Cline</label>
      <textarea id="toolSnippet" rows="3" readonly></textarea>
    </div>
  </div>
</div>

<script>
const $ = (id) => document.getElementById(id);
// Newline & quote helpers keep this file free of backslash escapes that are
// easy to break when this page is embedded in a template literal.
const NL = String.fromCharCode(10);
const Q = String.fromCharCode(39);

async function boot() {
  const [st, keys] = await Promise.all([
    fetch('/api/status').then(r => r.json()),
    fetch('/api/keys').then(r => r.json()),
  ]);
  const ok = st.backend?.running;
  $('dot').className = 'dot ' + (ok ? 'ok' : 'bad');
  $('statusText').textContent = ok ? 'backend online · v' + st.version : 'backend offline';

  $('keys').innerHTML = Object.entries(keys.keys).map(([name, key]) =>
    '<div class="key-row"><span>' + name + '</span><code>' + key + '</code>' +
    '<button class="copy" data-key="' + key.replace(/"/g, '&quot;') + '">copy</button></div>'
  ).join('');
  $('keys').querySelectorAll('.copy').forEach((btn) => {
    btn.onclick = () => copyKey(btn, btn.dataset.key || '');
  });

  $('models').innerHTML = st.models.map(m =>
    '<div class="model"><span>' + m.id + '</span><span class="rel ' + m.reliability + '">' + m.reliability + '</span></div>'
  ).join('');

  $('model').innerHTML = st.models.map(m => '<option>' + m.id + '</option>').join('');
  if (st.models.some(m => m.id === 'deepseek-v4-flash-free')) $('model').value = 'deepseek-v4-flash-free';

  const mm = st.modelsMeta || {};
  $('modelsMeta').textContent = '(' + (mm.source === 'live' ? 'auto-synced' : 'seed') + ' · ' + (mm.count ?? st.models.length) + ' · ' +
    (mm.lastRefresh ? 'updated ' + new Date(mm.lastRefresh).toLocaleTimeString() : 'pending') + ')';

  $('refreshModelsBtn').onclick = async () => {
    const btn = $('refreshModelsBtn');
    btn.textContent = 'syncing…';
    const key = Object.values(await fetch('/api/keys').then(r => r.json()).then(k => k.keys))[0];
    try {
      const res = await fetch('/api/models/refresh', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + key },
      });
      const j = await res.json();
      if (j.models) {
        $('models').innerHTML = j.models.map(m =>
          '<div class="model"><span>' + m.id + '</span><span class="rel ' + m.reliability + '">' + m.reliability + '</span></div>'
        ).join('');
        $('model').innerHTML = j.models.map(m => '<option>' + m.id + '</option>').join('');
        $('modelsMeta').textContent = '(auto-synced · ' + j.models.length + ' · updated ' + new Date().toLocaleTimeString() + ')';
        btn.textContent = '✓ synced';
      } else {
        btn.textContent = 'sync failed';
      }
    } catch {
      btn.textContent = 'sync failed';
    }
    setTimeout(() => btn.textContent = '↻ sync from models.dev', 1500);
  };

  const key = Object.values(keys.keys)[0] || '';
  const curlBody = {
    model: 'deepseek-v4-flash-free',
    messages: [{ role: 'user', content: 'Hello' }],
    stream: true,
  };
  $('curlSnippet').value = [
    'curl http://localhost:' + st.port + '/v1/chat/completions',
    '  -H "Authorization: Bearer ' + key + '"',
    '  -H "Content-Type: application/json"',
    '  -d ' + Q + JSON.stringify(curlBody) + Q,
  ].join(NL);

  const ocConfig = {
    provider: {
      'OC-NOLIMIT': {
        type: 'openai',
        apiKey: key,
        baseURL: 'http://localhost:' + st.port + '/v1',
        models: {
          'OC-NOLIMIT/deepseek-v4-flash-free': {
            id: 'deepseek-v4-flash-free',
            name: 'OC-NOLIMIT/deepseek-v4-flash-free',
            attachment: true,
            reasoning: true,
          },
        },
      },
    },
  };
  $('ocSnippet').value = JSON.stringify(ocConfig, null, 2);

  $('toolSnippet').value = [
    'Base URL : http://localhost:' + st.port + '/v1',
    'API Key  : ' + key,
    'Model    : deepseek-v4-flash-free',
  ].join(NL);
}

function copyKey(btn, key) {
  navigator.clipboard.writeText(key).then(() => {
    btn.textContent = 'copied!';
    setTimeout(() => btn.textContent = 'copy', 1200);
  });
}

async function rotateKey() {
  const btn = $('rotateBtn');
  if (!confirm('Rotate API key? The old key will stop working immediately.')) return;
  btn.textContent = 'rotating…';
  const key = Object.values(await fetch('/api/keys').then(r => r.json()).then(k => k.keys))[0];
  try {
    const res = await fetch('/api/keys/rotate', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + key },
    });
    const j = await res.json();
    if (j.keys) {
      $('keys').innerHTML = Object.entries(j.keys).map(([name, k]) =>
        '<div class="key-row"><span>' + name + '</span><code>' + k + '</code>' +
        '<button class="copy" data-key="' + k.replace(/"/g, '&quot;') + '">copy</button></div>'
      ).join('');
      $('keys').querySelectorAll('.copy').forEach((b) => {
        b.onclick = () => copyKey(b, b.dataset.key || '');
      });
      btn.textContent = '✓ rotated';
    } else {
      btn.textContent = 'rotate failed';
    }
  } catch {
    btn.textContent = 'rotate failed';
  }
  setTimeout(() => btn.textContent = '⟳ rotate key', 1500);
}

$('rotateBtn').onclick = rotateKey;

$('runBtn').onclick = async () => {
  const btn = $('runBtn'), out = $('out');
  btn.disabled = true; out.style.display = 'block'; out.textContent = '…';
  const body = {
    model: $('model').value,
    messages: [{ role: 'user', content: $('prompt').value }],
    stream: $('streamChk').checked,
  };
  try {
    const key = Object.values(await fetch('/api/keys').then(r => r.json()).then(k => k.keys))[0];
    const res = await fetch('/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key },
      body: JSON.stringify(body),
    });
    if (body.stream) {
      const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const frames = buf.split(NL + NL); buf = frames.pop() || '';
        for (const f of frames) {
          for (const line of f.split(NL)) {
            if (!line.startsWith('data: ')) continue;
            const d = line.slice(6);
            if (d === '[DONE]') continue;
            try { out.textContent += JSON.parse(d).choices?.[0]?.delta?.content || ''; } catch {}
          }
        }
      }
      out.textContent += NL + '▲ stream selesai';
    } else {
      const j = await res.json();
      out.textContent = j.error ? JSON.stringify(j, null, 2) : j.choices?.[0]?.message?.content || '(kosong)';
    }
  } catch (e) {
    out.textContent = 'Error: ' + e.message;
  } finally {
    btn.disabled = false;
  }
};

boot();
</script>
</body>
</html>`;
}
