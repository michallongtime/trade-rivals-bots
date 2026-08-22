// server.js — mini dashboard REST na czystym http (bez frameworków).
// Serwuje public/dashboard.html oraz API sterowania botami.
import http from 'node:http';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './config.js';

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

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
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
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
      const p = url.pathname;
      const m = req.method;

      if (m === 'GET' && p === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(getHtml());
        return;
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

      sendJson(res, 404, { error: 'Not found' });
    } catch (e) {
      sendJson(res, e.status ?? 500, { error: e.message });
    }
  });
}
