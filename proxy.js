#!/usr/bin/env node
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

// ── Configuration ──────────────────────────────────────────────────────────

const PORT = parseInt(process.env.PORT || '9457', 10);
const UPSTREAM_HOST = process.env.UPSTREAM_HOST || 'llm-api.atomgit.com';
const AUTH_PATH = path.join(
  process.env.HOME || process.env.USERPROFILE || '/tmp',
  '.atomcode',
  'auth.toml',
);
const UA_STRING = process.env.UA_STRING || 'atomcode/4.23.0';

// Known models available via the CodingPlan subscription. Update periodically
// by running: curl -H "Authorization: Bearer $(your_token)" \
//   "https://api.gitcode.com/api/v5/coding-plan/models-v2?plan_type=Max"
const KNOWN_MODELS = [
  { id: 'deepseek-v4-flash', object: 'model', owned_by: 'atomgit' },
  { id: 'GLM-5.1', object: 'model', owned_by: 'atomgit' },
  { id: 'Qwen/Qwen3.6-35B-A3B', object: 'model', owned_by: 'atomgit' },
  { id: 'Qwen/Qwen3-VL-8B-Instruct', object: 'model', owned_by: 'atomgit' },
];

// ── Auth helpers ───────────────────────────────────────────────────────────

function readToken() {
  try {
    const raw = fs.readFileSync(AUTH_PATH, 'utf8');
    const m = raw.match(/^access_token\s*=\s*"([^"]+)"/m);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

// ── HTTP Proxy Logic ───────────────────────────────────────────────────────

function proxyToUpstream(method, pathname, body, clientRes) {
  const token = readToken();
  if (!token) {
    clientRes.writeHead(401, { 'Content-Type': 'application/json' });
    clientRes.end(JSON.stringify({
      error: 'unauthorized',
      message: 'No auth token found in ' + AUTH_PATH + '. Run `atomcode login` first.',
    }));
    return;
  }

  const opts = {
    hostname: UPSTREAM_HOST,
    port: 443,
    path: pathname,
    method,
    rejectUnauthorized: true,
    headers: {
      Authorization: 'Bearer ' + token,
      'User-Agent': UA_STRING,
    },
    timeout: 300_000,
  };

  if (body) {
    opts.headers['Content-Type'] = 'application/json';
    opts.headers['Content-Length'] = body.length;
  }

  const upstreamReq = https.request(opts, (upstreamRes) => {
    const headers = { 'Access-Control-Allow-Origin': '*' };
    for (const [k, v] of Object.entries(upstreamRes.headers)) {
      if (k !== 'access-control-allow-origin') headers[k] = v;
    }
    clientRes.writeHead(upstreamRes.statusCode, headers);
    upstreamRes.pipe(clientRes);
  });

  upstreamReq.on('error', (err) => {
    console.error('[proxy] upstream error:', err.message);
    if (!clientRes.headersSent) {
      clientRes.writeHead(502, { 'Content-Type': 'application/json' });
      clientRes.end(JSON.stringify({ error: 'bad_gateway', message: err.message }));
    }
  });

  upstreamReq.on('timeout', () => {
    upstreamReq.destroy();
    if (!clientRes.headersSent) {
      clientRes.writeHead(504, { 'Content-Type': 'application/json' });
      clientRes.end(JSON.stringify({ error: 'gateway_timeout' }));
    }
  });

  if (body) upstreamReq.write(body);
  upstreamReq.end();
}

// ── HTTP Server ────────────────────────────────────────────────────────────

const server = http.createServer((req, res) => {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // GET /v1/models — return known model list
  if (req.url === '/v1/models' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ object: 'list', data: KNOWN_MODELS }));
    return;
  }

  // POST /v1/chat/completions — proxy to upstream
  if (req.url === '/v1/chat/completions' && req.method === 'POST') {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => proxyToUpstream('POST', '/v1/chat/completions', Buffer.concat(chunks), res));
    return;
  }

  // Health check
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', auth: !!readToken() }));
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not found. Try POST /v1/chat/completions');
});

server.listen(PORT, '127.0.0.1', () => {
  const hasAuth = !!readToken();
  console.log('┌────────────────────────────────────────────┐');
  console.log('│  atomgit-opencode-bridge                    │');
  console.log('│  Listening on http://127.0.0.1:' + String(PORT).padEnd(5) + '              │');
  console.log('│  Auth token: ' + (hasAuth ? '✓ loaded' : '✗ MISSING').padEnd(29) + ' │');
  console.log('│  Upstream:  ' + UPSTREAM_HOST.padEnd(31) + ' │');
  console.log('│                                              │');
  console.log('│  Models:                                      │');
  KNOWN_MODELS.forEach((m) => {
    console.log('│    - ' + m.id.padEnd(38) + ' │');
  });
  console.log('└────────────────────────────────────────────┘');
});
