// server.js — mini dashboard REST na czystym http (bez frameworków).
// Serwuje public/dashboard.html oraz API sterowania botami.
import http from 'node:http';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './config.js';
import { assertAuthConfig, createAuthGuard } from './auth.js';

const HTML_PATH = join(ROOT, 'public', 'dashboard.html');
const HTML = readFileSync(HTML_PATH, 'utf8');

// Dashboard odświeżany z dysku po zmianie pliku — edycje HTML bez restartu.
let htmlCache = { mtimeMs: statSync(HTML_PATH).mtimeMs, content: HTML };
function getHtml() {
  try {
    const st = statSync(HTML_PATH);
    if (st.mtimeMs !== htmlCache.mtimeMs) {
      htmlCache = { mtimeMs: st.mtimeMs, content: readFileSync(HTML_PATH, 'utf8') };
    }
  } catch {
    // brak dostępu — zostajemy przy ostatniej wersji
  }
  return htmlCache.content;
}

function sendJson(res, code, obj, extra = {}) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body), ...extra });
  res.end(body);
}

function collectBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 1e6) req.destroy(new Error('body too large'));
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch (e) {
        reject(Object.assign(e, { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

export function createServer({ manager, store, cfg, offline, dryRun, startedAt, targetName }) {
  assertAuthConfig(cfg); // fail-closed: publiczny bind bez server.auth = odmowa startu
  const guard = createAuthGuard(cfg);
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
      const p = url.pathname;
      const m = req.method;

      // Health dla Docker watchdoga — publiczne (sam {ok:true}, zero danych).
      if (m === 'GET' && p === '/api/health') {
        sendJson(res, 200, { ok: true });
        return;
      }

      // Skorupa HTML jest publiczna (nie zawiera danych — wszystko jest za /api/*).
      if (m === 'GET' && p === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(getHtml());
        return;
      }

      // Guard przed collectBody — nieudany auth nie czyta ciał żądań.
      const g = guard(req);
      if (!g.allowed) {
        const extra = g.status === 429 ? { 'Retry-After': String(g.retryAfter) } : {};
        return sendJson(res, g.status, {
          error: g.status === 429
            ? 'zbyt wiele nieudanych prób logowania — spróbuj później'
            : 'wymagana autoryzacja (Basic + X-Auth-Token)',
        }, extra);
      }

      if (m === 'GET' && p === '/api/status') {
        const bots = store.botViews();
        const totals = { total: bots.length, running: 0, paused: 0, waiting: 0, needs_funding: 0, error: 0 };
        for (const b of bots) totals[b.status] = (totals[b.status] ?? 0) + 1;
        sendJson(res, 200, {
          uptimeSec: Math.floor((Date.now() - startedAt) / 1000),
          target: targetName ?? null,
          mode: offline ? 'offline' : dryRun ? 'dry-run' : 'live',
          aiProvider: cfg.ai.provider,
          aiModel: cfg.ai.model,
          baseUrl: cfg.api.baseUrl,
          totals,
          registrationQueueLen: manager.registrationQueueLen(),
          aiRequestsTotal: store.aiRequestsTotal(),
        });
        return;
      }

      if (m === 'GET' && p === '/api/bots') {
        const accounts = new Map(store.accounts.accounts.map((a) => [a.id, a]));
        const bots = store.botViews().map((v) => ({
          ...v,
          nickname: accounts.get(v.id)?.nickname,
          email: accounts.get(v.id)?.email,
        }));
        sendJson(res, 200, { bots });
        return;
      }

      if (m === 'POST' && p === '/api/bots/propose') {
        const body = await collectBody(req);
        const accounts = manager.proposeAccounts(body.count ?? 1, body.exclude ?? []);
        sendJson(res, 200, { accounts });
        return;
      }

      if (m === 'POST' && p === '/api/bots') {
        const body = await collectBody(req);
        const result = body.accounts ? manager.createAccounts(body.accounts) : manager.createAccounts(body.count ?? 1);
        sendJson(res, result.queued ? 202 : 400, result);
        return;
      }

      const action = p.match(/^\/api\/bots\/([^/]+)\/(pause|resume|delete)$/);
      if (m === 'POST' && action) {
        const id = action[1];
        if (!store.getAccount(id)) return sendJson(res, 404, { error: 'bot not found' });
        if (action[2] === 'pause') return sendJson(res, 200, manager.pauseBot(id));
        if (action[2] === 'resume') return sendJson(res, 200, manager.resumeBot(id));
        return sendJson(res, 200, await manager.deleteBot(id));
      }

      const logMatch = p.match(/^\/api\/bots\/([^/]+)\/log$/);
      if (m === 'GET' && logMatch) {
        const s = store.getBotState(logMatch[1]);
        return sendJson(res, 200, { log: s.log ?? [] });
      }

      // Ostatnie wymiany AI (pełny prompt + odpowiedź) — na żądanie, bo payload
      // jest duży; dashboard nie polluje tego co 3 s.
      const aiMatch = p.match(/^\/api\/bots\/([^/]+)\/ai$/);
      if (m === 'GET' && aiMatch) {
        const s = store.getBotState(aiMatch[1]);
        const exchanges = s.ai_exchanges ?? [];
        return sendJson(res, 200, { exchanges: exchanges.slice(-10).reverse() });
      }

      // Ustawienia AI edytowalne z dashboardu (instrukcja + cooldown pytań).
      if (m === 'GET' && p === '/api/settings') {
        return sendJson(res, 200, store.getSettings());
      }
      if (m === 'POST' && p === '/api/settings') {
        const body = await collectBody(req);
        const patch = {};
        if (typeof body.aiInstruction === 'string') patch.aiInstruction = body.aiInstruction.slice(0, 4000);
        if (Number.isFinite(Number(body.aiAskIntervalMin))) {
          patch.aiAskIntervalMin = Math.max(0, Math.min(120, Math.round(Number(body.aiAskIntervalMin))));
        }
        return sendJson(res, 200, store.updateSettings(patch));
      }

      sendJson(res, 404, { error: 'Not found' });
    } catch (e) {
      sendJson(res, e.status ?? 500, { error: e.message });
    }
  });
}
