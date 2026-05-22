import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const AUTH_PATH = join(homedir(), '.atomcode', 'auth.toml');
const UPSTREAM_HOSTS = ['llm-api.atomgit.com', 'api-ai.gitcode.com'];
const REFRESH_URL = 'https://acs.atomgit.com/oauth/refresh';
const UA_STRING = 'atomcode/4.23.0';

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
    return parseAuth(readFileSync(AUTH_PATH, 'utf8'));
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
  writeFileSync(AUTH_PATH, content, { mode: 0o600 });
}

function isExpired(auth) {
  if (!auth.expires_in) return false;
  const now = Math.floor(Date.now() / 1000);
  return now >= auth.created_at + auth.expires_in - 300;
}

async function refreshToken(auth) {
  const body = JSON.stringify({ refresh_token: auth.refresh_token });
  const res = await fetch(REFRESH_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': UA_STRING,
    },
    body,
  });
  if (!res.ok) {
    throw new Error('Token refresh failed: HTTP ' + res.status);
  }
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
  if (!auth?.access_token) {
    throw new Error('No auth token found in ' + AUTH_PATH + '. Install AtomCode and run `atomcode login` first.');
  }

  if (!isExpired(auth)) {
    return auth.access_token;
  }

  if (!auth.refresh_token) {
    throw new Error('Token expired and no refresh_token available. Run `atomcode login` again.');
  }

  const newAuth = await refreshToken(auth);
  return newAuth.access_token;
}

function needsInterception(urlStr) {
  try {
    const u = new URL(urlStr);
    return UPSTREAM_HOSTS.some(h => u.hostname === h || u.hostname.endsWith('.' + h));
  } catch {
    return false;
  }
}

// ── Plugin ─────────────────────────────────────────────────────────────────

export const AtomCodeProviderPlugin = async ({ client }) => {
  return {
    auth: {
      provider: 'atomgit',
      methods: [
        {
          label: 'AtomCode (read ~/.atomcode/auth.toml)',
          type: 'api',
          prompts: [],
          async authorize() {
            const auth = readAuth();
            if (!auth?.access_token) {
              throw new Error(
                'No auth.toml found. Install AtomCode and run `atomcode login` or `atomcode codingplan`.',
              );
            }
            return {};
          },
        },
      ],
      loader: async (getAuth) => {
        return {
          apiKey: '',
          async fetch(input, init) {
            const url = typeof input === 'string' ? input : input.url;

            // Only intercept atomgit gateway requests
            if (!needsInterception(url)) {
              return fetch(input, init);
            }

            let token;
            try {
              token = await ensureValidToken();
            } catch (err) {
              throw new Error('[atomcode-auth] ' + err.message);
            }

            const headers = new Headers(init?.headers);
            headers.set('Authorization', 'Bearer ' + token);
            headers.set('User-Agent', UA_STRING);
            headers.set('Content-Type', headers.get('Content-Type') || 'application/json');

            return fetch(url, {
              ...init,
              headers,
            });
          },
        };
      },
    },
  };
};
