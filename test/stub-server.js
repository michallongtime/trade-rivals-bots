// stub-server.js — atrapa API TradeContest (in-memory) do testów E2E.
// Rdzeń to TradeSimulator z src/mock.js opakowany w HTTP + limity 429.
//   node test/stub-server.js [--port 8081] [--paid] [--busy N]
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { normalize } from 'node:path';
import { TradeSimulator } from '../src/mock.js';

const args = process.argv.slice(2);
const port = Number(args[args.indexOf('--port') + 1]) || 8081;
const paid = args.includes('--paid');
const busy = Number(args[args.indexOf('--busy') + 1]) || 0;

export function startStub({ port: p = port, paid: isPaid = paid, busy: busyN = busy } = {}) {
  const sim = new TradeSimulator({ isPaid: isPaid, busyCount: busyN });

  // Limity z API.md: okno 60s
  const WINDOW_MS = 60000;
  const LIMITS = {
    'POST /auth/register': 10,
    'POST /auth/login': 10,
    'POST /tournaments/join': 20,
    'POST /portfolios/orders': 30,
  };
  const hits = new Map(); // key -> { count, windowStart }

  function overLimit(key) {
    const now = Date.now();
    const rec = hits.get(key) ?? { count: 0, windowStart: now };
    if (now - rec.windowStart > WINDOW_MS) {
      rec.count = 0;
      rec.windowStart = now;
    }
    rec.count++;
    hits.set(key, rec);
    return rec.count > (LIMITS[key] ?? Infinity);
  }

  function keyFor(method, path) {
    if (method === 'POST' && path === '/api/auth/register') return 'POST /auth/register';
    if (method === 'POST' && path === '/api/auth/login') return 'POST /auth/login';
    if (method === 'POST' && /^\/api\/tournaments\/\d+\/join$/.test(path)) return 'POST /tournaments/join';
    if (method === 'POST' && /^\/api\/portfolios\/\d+\/orders$/.test(path)) return 'POST /portfolios/orders';
    return null;
  }

  function readBody(req) {
    return new Promise((resolve) => {
      let data = '';
      req.on('data', (c) => (data += c));
      req.on('end', () => {
        try {
          resolve(data ? JSON.parse(data) : {});
        } catch {
          resolve({});
        }
      });
    });
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
    const path = url.pathname;
    const method = req.method;
    const send = (code, obj) => {
      const body = JSON.stringify(obj);
      res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
      res.end(body);
    };
    const auth = (req.headers.authorization ?? '').replace(/^Bearer /, '');
    const num = (re) => Number(path.match(re)?.[1]);

    try {
      const rlKey = keyFor(method, path);
      if (rlKey && overLimit(rlKey)) return send(429, { message: 'Too Many Requests' });

      if (method === 'GET' && path === '/api/health') return send(200, { status: 'ok' });
      if (method === 'POST' && path === '/api/auth/register') return send(201, sim.register(await readBody(req)));
      if (method === 'POST' && path === '/api/auth/login') return send(200, sim.login(await readBody(req)));
      if (method === 'POST' && path === '/api/auth/logout') return send(200, sim.logout(auth));
      if (method === 'GET' && path === '/api/me') return send(200, sim.me(auth));
      if (method === 'GET' && path === '/api/me/wallet') return send(200, sim.wallet(auth));
      if (method === 'GET' && path === '/api/tournaments') {
        const s = url.searchParams.get('status');
        return send(200, sim.listTournaments(s));
      }
      if (method === 'GET' && /^\/api\/tournaments\/\d+$/.test(path)) {
        return send(200, sim.getTournament(num(/\/api\/tournaments\/(\d+)$/), auth));
      }
      if (method === 'POST' && /^\/api\/tournaments\/\d+\/join$/.test(path)) {
        return send(201, sim.join(auth, num(/\/api\/tournaments\/(\d+)\/join/)));
      }
      if (method === 'GET' && /^\/api\/tournaments\/\d+\/ranking$/.test(path)) {
        return send(200, sim.ranking(num(/\/api\/tournaments\/(\d+)\/ranking/)));
      }
      if (method === 'GET' && /^\/api\/portfolios\/\d+$/.test(path)) {
        return send(200, sim.portfolio(auth, num(/\/api\/portfolios\/(\d+)$/)));
      }
      if (method === 'GET' && /^\/api\/portfolios\/\d+\/orders$/.test(path)) {
        return send(200, sim.myOrders(auth, num(/\/api\/portfolios\/(\d+)\/orders/)));
      }
      if (method === 'GET' && /^\/api\/portfolios\/\d+\/transactions$/.test(path)) {
        return send(200, sim.myTransactions(auth, num(/\/api\/portfolios\/(\d+)\/transactions/)));
      }
      if (method === 'POST' && /^\/api\/portfolios\/\d+\/orders$/.test(path)) {
        return send(201, sim.createOrder(auth, num(/\/api\/portfolios\/(\d+)\/orders/), await readBody(req)));
      }
      if (method === 'DELETE' && /^\/api\/orders\/\d+$/.test(path)) {
        return send(200, { order: sim.cancelOrder(auth, num(/\/api\/orders\/(\d+)/)) });
      }
      if (method === 'POST' && /^\/api\/portfolios\/\d+\/positions\/\d+\/close$/.test(path)) {
        const m = path.match(/^\/api\/portfolios\/(\d+)\/positions\/(\d+)\/close$/);
        return send(200, sim.closePosition(auth, Number(m[1]), Number(m[2])));
      }
      if (method === 'GET' && /^\/api\/prices\/[\w]+$/.test(path)) {
        const sym = path.split('/').pop();
        try {
          return send(200, sim.price(sym));
        } catch (e) {
          if (e.status === 404) return send(404, { message: 'unknown symbol' });
          throw e;
        }
      }
      if (method === 'GET' && path === '/api/candles') {
        const sym = url.searchParams.get('symbol');
        return send(200, sim.candles(sym, url.searchParams.get('interval') ?? '5m', Number(url.searchParams.get('limit')) || 20));
      }
      return send(404, { message: 'not found' });
    } catch (e) {
      send(e.status ?? 500, e.body ?? { message: e.message });
    }
  });

  return new Promise((resolve) => {
    server.listen(p, '127.0.0.1', () => resolve(server));
  });
}

// Uruchomienie bezpośrednie (CLI)
if (process.argv[1] && normalize(process.argv[1]) === fileURLToPath(import.meta.url)) {
  startStub().then((s) => {
    console.log(`[stub] TradeContest API mock on http://127.0.0.1:${s.address().port}${paid ? ' (paid tournament)' : ''}${busy ? ` (busy ${busy})` : ''}`);
  });
}
