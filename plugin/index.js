import http from 'node:http';
import https from 'node:https';
import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const PORT = 9457;
const AUTH_PATH = join(homedir(), '.atomcode', 'auth.toml');
const UA_STRING = 'atomcode/4.23.0';
const UPSTREAM_HOST = 'llm-api.atomgit.com';
const REFRESH_URL = 'https://acs.atomgit.com/oauth/refresh';

const KNOWN_MODELS = [
  { id: 'deepseek-v4-flash', object: 'model', owned_by: 'atomgit' },
  { id: 'GLM-5.1', object: 'model', owned_by: 'atomgit' },
  { id: 'Qwen/Qwen3.6-35B-A3B', object: 'model', owned_by: 'atomgit' },
  { id: 'Qwen/Qwen3-VL-8B-Instruct', object: 'model', owned_by: 'atomgit' },
];

let proxyServer = null;
let proxyStarted = false;

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
  try { return parseAuth(readFileSync(AUTH_PATH, 'utf8')); } catch { return null; }
}

function writeAuth(auth) {
  const lines = [
    'access_token = "' + auth.access_token + '"',
    'refresh_token = "' + (auth.refresh_token || '') + '"',
    'token_type = "Bearer"',
    'expires_in = ' + auth.expires_in,
    'created_at = ' + auth.created_at,
  ];
  writeFileSync(AUTH_PATH, lines.join('\n') + '\n', { mode: 0o600 });
}

function isExpired(auth) {
  if (!auth.expires_in) return false;
  return Math.floor(Date.now() / 1000) >= auth.created_at + auth.expires_in - 300;
}

async function refreshToken(auth) {
  const body = JSON.stringify({ refresh_token: auth.refresh_token });
  const res = await fetch(REFRESH_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': UA_STRING },
    body,
  });
  if (!res.ok) throw new Error('refresh failed: HTTP ' + res.status);
  const j = await res.json();
  const now = Math.floor(Date.now() / 1000);
  const newAuth = {
    access_token: j.access_token,
    refresh_token: j.refresh_token || auth.refresh_token,
    expires_in: j.expires_in || auth.expires_in,
    created_at: now,
  };
  writeAuth(newAuth);
  return newAuth;
}

async function ensureValidToken() {
  const auth = readAuth();
  if (!auth?.access_token) throw new Error('No auth token. Run `atomcode login` first.');
  if (!isExpired(auth)) return auth.access_token;
  if (!auth.refresh_token) throw new Error('Token expired, no refresh_token.');
  const newAuth = await refreshToken(auth);
  return newAuth.access_token;
}

function startProxy() {
  const server = http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    if (req.url === '/v1/models' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: KNOWN_MODELS }));
      return;
    }

    if (req.url === '/v1/chat/completions' && req.method === 'POST') {
      const chunks = [];
      req.on('data', c => chunks.push(c));
      req.on('end', async () => {
        const body = Buffer.concat(chunks);
        let token;
        try { token = await ensureValidToken(); }
        catch (e) { res.writeHead(401); res.end(JSON.stringify({ error: e.message })); return; }

        const opts = {
          hostname: UPSTREAM_HOST,
          port: 443,
          path: '/v1/chat/completions',
          method: 'POST',
          headers: {
            'Authorization': 'Bearer ' + token,
            'User-Agent': UA_STRING,
            'Content-Type': 'application/json',
            'Content-Length': body.length,
          },
          timeout: 300_000,
        };
        const proxy = https.request(opts, (target) => {
          const h = {};
          for (const [k, v] of Object.entries(target.headers)) h[k] = v;
          res.writeHead(target.statusCode, h);
          target.pipe(res);
        });
        proxy.on('error', e => {
          if (!res.headersSent) { res.writeHead(502); res.end('{"error":"' + e.message + '"}'); }
        });
        proxy.end(body);
      });
      return;
    }

    res.writeHead(404); res.end('Not found');
  });

  return new Promise((resolve, reject) => {
    server.listen(PORT, '127.0.0.1', () => {
      console.log('[atomcode-auth] Proxy on http://127.0.0.1:' + PORT);
      proxyStarted = true;
      proxyServer = server;
      resolve(server);
    });
    server.on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        console.log('[atomcode-auth] Port ' + PORT + ' already in use — reusing');
        proxyStarted = true;
        proxyServer = null;
        resolve(null);
        return;
      }
      reject(err);
    });
  });
}

export const AtomCodeAuthPlugin = async () => {
  if (proxyStarted) return {};
  proxyStarted = true;
  proxyServer = await startProxy();
  return {};
};

process.on('exit', () => {
  if (proxyServer && proxyServer.listening) { proxyServer.close(); }
});
process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));
