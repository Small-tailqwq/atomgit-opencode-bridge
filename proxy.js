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
const REFRESH_URL = 'https://acs.atomgit.com/oauth/refresh';

const KNOWN_MODELS = [
  { id: 'deepseek-v4-flash', object: 'model', owned_by: 'atomgit' },
  { id: 'GLM-5.1', object: 'model', owned_by: 'atomgit' },
  { id: 'Qwen/Qwen3.6-35B-A3B', object: 'model', owned_by: 'atomgit' },
  { id: 'Qwen/Qwen3-VL-8B-Instruct', object: 'model', owned_by: 'atomgit' },
];

// ── TOML parser (minimal, for auth.toml only) ──────────────────────────────

function parseAuth(raw) {
  const get = (key) => {
    const m = raw.match(new RegExp('^' + key + '\\s*=\\s*"([^"]*)"', 'm'));
    return m ? m[1] : null;
  };
  const getNum = (key) => {
    const m = raw.match(new RegExp('^' + key + '\\s*=\\s*(-?\\d+)', 'm'));
    return m ? parseInt(m[1], 10) : null;
  };
  return {
    access_token: get('access_token'),
    refresh_token: get('refresh_token'),
    expires_in: getNum('expires_in'),
    created_at: getNum('created_at') || 0,
  };
}

function readAuth() {
  try {
    return parseAuth(fs.readFileSync(AUTH_PATH, 'utf8'));
  } catch {
    return null;
  }
}

function writeAuth(auth) {
  const content = [
    'access_token = "' + auth.access_token + '"',
    'refresh_token = "' + (auth.refresh_token || '') + '"',
    'token_type = "Bearer"',
    'expires_in = ' + auth.expires_in,
    'created_at = ' + auth.created_at,
  ].join('\n') + '\n';
  fs.writeFileSync(AUTH_PATH, content, { mode: 0o600 });
}

// ── Token lifecycle ────────────────────────────────────────────────────────

function isExpired(auth) {
  if (!auth.expires_in) return false;
  const now = Math.floor(Date.now() / 1000);
  // 5-minute safety margin, matching atomcode's logic
  return now >= auth.created_at + auth.expires_in - 300;
}

function refreshToken(auth) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ refresh_token: auth.refresh_token });
    const req = https.request(
      REFRESH_URL,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          'User-Agent': UA_STRING,
        },
        timeout: 10_000,
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          if (res.statusCode !== 200) {
            return reject(new Error('refresh failed: HTTP ' + res.statusCode + ' ' + data));
          }
          try {
            const j = JSON.parse(data);
            const now = Math.floor(Date.now() / 1000);
            const newAuth = {
              access_token: j.access_token,
              refresh_token: j.refresh_token || auth.refresh_token,
              expires_in: j.expires_in || auth.expires_in,
              created_at: now,
            };
            writeAuth(newAuth);
            resolve(newAuth);
          } catch (e) {
            reject(new Error('refresh parse error: ' + e.message));
          }
        });
      },
    );
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('refresh timeout'));
    });
    req.end(body);
  });
}

// ── Auth pipeline: read → refresh-if-expired → return token ────────────────

let cachedToken = null;
let refreshInProgress = null;

async function ensureValidToken() {
  const auth = readAuth();
  if (!auth || !auth.access_token) {
    throw new Error('No auth token found in ' + AUTH_PATH + '. Run `atomcode login` first.');
  }

  if (!isExpired(auth)) {
    cachedToken = auth.access_token;
    return cachedToken;
  }

  if (!auth.refresh_token) {
    throw new Error('Token expired and no refresh_token available. Run `atomcode login` again.');
  }

  if (refreshInProgress) {
    return refreshInProgress;
  }

  refreshInProgress = refreshToken(auth).then((newAuth) => {
    cachedToken = newAuth.access_token;
    refreshInProgress = null;
    console.log('[auth] token auto-refreshed, new expires_in=' + newAuth.expires_in + 's');
    return cachedToken;
  }).catch((err) => {
    refreshInProgress = null;
    console.error('[auth] refresh failed:', err.message);
    // Fall back to existing token — might still work if close to expiry
    cachedToken = auth.access_token;
    return cachedToken;
  });

  return refreshInProgress;
}

// ── HTTP Proxy Logic ───────────────────────────────────────────────────────

async function proxyToUpstream(method, pathname, body, clientRes) {
  let token;
  try {
    token = await ensureValidToken();
  } catch (err) {
    clientRes.writeHead(401, { 'Content-Type': 'application/json' });
    clientRes.end(JSON.stringify({ error: 'unauthorized', message: err.message }));
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
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.url === '/v1/models' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ object: 'list', data: KNOWN_MODELS }));
    return;
  }

  if (req.url === '/v1/chat/completions' && req.method === 'POST') {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => proxyToUpstream('POST', '/v1/chat/completions', Buffer.concat(chunks), res));
    return;
  }

  if (req.url === '/health') {
    const auth = readAuth();
    const expired = auth ? isExpired(auth) : null;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ok',
      auth: !!auth,
      expired: expired,
      expires_in: auth ? auth.expires_in : null,
      created_at: auth ? auth.created_at : null,
      refresh_token: !!auth?.refresh_token,
    }));
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not found. Try POST /v1/chat/completions');
});

server.listen(PORT, '127.0.0.1', () => {
  const auth = readAuth();
  const expired = auth ? isExpired(auth) : null;
  console.log('┌────────────────────────────────────────────┐');
  console.log('│  atomgit-opencode-bridge                    │');
  console.log('│  Listening on http://127.0.0.1:' + String(PORT).padEnd(5) + '              │');
  if (auth) {
    const status = expired ? 'EXPIRED, will auto-refresh' : '✓ valid';
    console.log('│  Token: ' + status.padEnd(32) + ' │');
    console.log('│  Expires: ' + (
      expired ? 'auto-refresh on next request' :
      new Date((auth.created_at + auth.expires_in) * 1000).toLocaleString()
    ).padEnd(32) + ' │');
  } else {
    console.log('│  Token: ✗ MISSING'.padEnd(43) + ' │');
  }
  console.log('│  Upstream:  ' + UPSTREAM_HOST.padEnd(31) + ' │');
  console.log('│                                              │');
  console.log('│  Models:                                      │');
  KNOWN_MODELS.forEach((m) => {
    console.log('│    - ' + m.id.padEnd(38) + ' │');
  });
  console.log('└────────────────────────────────────────────┘');
});
