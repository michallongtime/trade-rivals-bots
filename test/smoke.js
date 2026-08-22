// smoke.js — szybkie testy: storage, walidacja decyzji AI, cykl bota
// (offline + przez HTTP stub), obsługa 429 i 401.
//   node test/smoke.js
import assert from 'node:assert';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Store } from '../src/store.js';
import { validateDecision } from '../src/prompts.js';
import { parseJsonResponse, LlmClient } from '../src/llm.js';
import { ApiClient } from '../src/api.js';
import { TradeSimulator } from '../src/mock.js';
import { BotManager } from '../src/manager.js';
import { BotEngine } from '../src/engine.js';
import { generateNickname, generateEmail, transliterate } from '../src/names.js';
import { loadConfig } from '../src/config.js';
import { startStub } from './stub-server.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0;
let failed = 0;
function ok(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    console.error(`  ✗ ${name}: ${e.message}`);
  }
}
async function okAsync(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    console.error(`  ✗ ${name}: ${e.message}`);
  }
}

const tmp = mkdtempSync(join(tmpdir(), 'tcbot-smoke-'));
const cfg = loadConfig();
cfg.account.count = 0;
cfg.trading.intervalMs = 2000;
cfg.trading.minOrderSpacingMs = 400;

// ============ A. Store ============
console.log('A. Store:');
{
  const store = new Store({ accountsFile: join(tmp, 'accounts.json'), stateFile: join(tmp, 'state.json') });
  store.upsertAccount({ id: 'b-1', nickname: 'x', email: 'x@y.z', password: 'p', token: 't', user_id: 1, player_id: 2, tournament_id: 7, created_at: 'now' });
  const s2 = new Store({ accountsFile: join(tmp, 'accounts.json'), stateFile: join(tmp, 'state.json') });
  ok('konto przetrwa przeładowanie', () => assert.strictEqual(s2.getAccount('b-1').token, 't'));
  s2.addLogEntry('b-1', 'info', 'hello');
  s2.saveState(); // zapis atomowy przed przeładowaniem
  const s3 = new Store({ accountsFile: join(tmp, 'accounts.json'), stateFile: join(tmp, 'state.json') });
  ok('log przetrwa przeładowanie', () => assert.strictEqual(s3.state.bots['b-1'].log[0].msg, 'hello'));
}

// ============ B. Walidacja decyzji ============
console.log('\nB. validateDecision:');
{
  const ctx = {
    markets: [{ id: 1, symbol: 'BTCUSDT' }],
    positions: [],
    pendingOrders: [],
    portfolio: { equity: '10000.00000000' },
    prices: { BTCUSDT: 100000 },
    tournament: { max_leverage: '10', virtual_start_capital: '10000.00000000' },
    cfg: { maxPositionAmountUsd: 1000, maxEquityFraction: 0.5, maxOpenPositions: 3, maxLeverage: 10 },
  };
  ok('garbage -> hold', () => assert.strictEqual(validateDecision('not json', ctx).decision.action, 'hold'));
  ok('brak akcji -> hold', () => assert.strictEqual(validateDecision({ foo: 1 }, ctx).decision.action, 'hold'));
  ok('leverage 99 clampowane do 10', () => {
    const d = validateDecision({ action: 'open', side: 'long', market_symbol: 'BTCUSDT', amount_usd: 100, leverage: 99 }, ctx).decision;
    assert.strictEqual(d.leverage, 10);
  });
  ok('amount 1e9 clampowane do limitu', () => {
    const d = validateDecision({ action: 'open', side: 'long', market_symbol: 'BTCUSDT', amount_usd: 1e9, leverage: 1 }, ctx).decision;
    assert.strictEqual(d.amount_usd, 1000);
  });
  ok('weto przy max otwartych pozycji', () => {
    const c2 = { ...ctx, positions: [{ id: 1 }, { id: 2 }, { id: 3 }] };
    assert.strictEqual(validateDecision({ action: 'open', side: 'long', market_symbol: 'BTCUSDT', amount_usd: 100 }, c2).decision.action, 'hold');
  });
  ok('tp w złą stronę odrzucone, sl zachowane (long: sl < cena jest OK)', () => {
    const d = validateDecision({ action: 'open', side: 'long', market_symbol: 'BTCUSDT', amount_usd: 100, leverage: 2, tp_price: 90000, sl_price: 80000 }, ctx).decision;
    assert.strictEqual(d.tp_price, null);
    assert.strictEqual(d.sl_price, 80000);
  });
  ok('close nieistniejącej pozycji -> hold', () => {
    assert.strictEqual(validateDecision({ action: 'close', position_id: 999 }, ctx).decision.action, 'hold');
  });
  ok('set_tp_sl z dobrymi cenami przechodzi', () => {
    const c2 = { ...ctx, positions: [{ id: 5, side: 'long', entry_price: '98000.00000000' }] };
    const d = validateDecision({ action: 'set_tp_sl', position_id: 5, tp_price: 101000, sl_price: 95000 }, c2).decision;
    assert.deepStrictEqual(d, { action: 'set_tp_sl', position_id: 5, tp_price: 101000, sl_price: 95000 });
  });
  ok('parseJsonResponse: fenced JSON i garbage', () => {
    assert.deepStrictEqual(parseJsonResponse('```json\n{"a":1}\n```'), { a: 1 });
    assert.strictEqual(parseJsonResponse('nope'), null);
  });
}

// ============ B2. Generator nazw (realistyczne nicki/emaile) ============
console.log('\nB2. names.js:');
{
  ok('transliteracja polskich znaków', () => assert.strictEqual(transliterate('Złoty Orzeł ąćęłńóśźż'), 'Zloty Orzel acelnoszz'));
  for (const style of ['mixed', 'gamer', 'polish']) {
    const nicks = [];
    for (let i = 0; i < 80; i++) nicks.push(generateNickname(style));
    ok(`nicki (${style}): format 3-24 [a-zA-Z0-9_], unikalne w serii`, () => {
      for (const n of nicks) {
        assert.ok(n.length >= 3 && n.length <= 24, `długość: ${n}`);
        assert.match(n, /^[a-zA-Z0-9_]+$/, `znaki: ${n}`);
      }
      assert.strictEqual(new Set(nicks.map((n) => n.toLowerCase())).size, nicks.length, 'duplikaty');
    });
  }
  ok('generateNickname respektuje exclude', () => {
    const exclude = new Set(['silentwolf42']);
    const n = generateNickname('gamer', exclude);
    assert.ok(!exclude.has(n.toLowerCase()));
  });
  ok('emaile: poprawny format i spójność z nickiem', () => {
    for (const style of ['mixed', 'gamer', 'polish']) {
      for (let i = 0; i < 40; i++) {
        const nick = generateNickname(style);
        const email = generateEmail({ nickname: nick, style });
        assert.match(email, /^[^\s@]+@[^\s@]+\.[^\s@]+$/, `format: ${email}`);
      }
    }
    const nick = 'SilentWolf42';
    const email = generateEmail({ nickname: nick, style: 'gamer' });
    assert.ok(email.startsWith('silentwolf42') || /^[a-z]+\.[a-z]+\d*@/.test(email), `wzorzec: ${email}`);
  });
}

// ============ C. Offline E2E (manager + symulator, busy lock) ============
console.log('\nC. Offline E2E:');
let managerOffline = null;
{
  const store = new Store({ accountsFile: join(tmp, 'off-accounts.json'), stateFile: join(tmp, 'off-state.json') });
  const sim = new TradeSimulator({ busyCount: 2 });
  managerOffline = new BotManager({ store, cfg, llm: new LlmClient({ provider: 'mock' }), offline: true, sim });
  managerOffline.createAccounts(2);
  await sleep(4000);
  ok('pierwsze konto zarejestrowane', () => assert.strictEqual(store.accounts.accounts.length, 1));
  await sleep(10000);
  ok('oba konta zarejestrowane', () => assert.strictEqual(store.accounts.accounts.length, 2));
  await sleep(6000);
  const views = store.botViews();
  ok('boty dołączyły i mają portfolio', () => views.length === 2 && views.every((b) => b.portfolio && b.status === 'running'));
  ok('boty handlują (otwarte pozycje)', () => views.some((b) => b.positions.length > 0));
  ok('plan per bot: rynki z turnieju, zróżnicowane budżety', () =>
    views.every((b) => {
      const p = b.trading_plan;
      return (
        p &&
        p.tournament_id === 7 &&
        p.symbols.length >= 1 &&
        p.symbols.every((s) => ['BTCUSDT', 'ETHUSDT'].includes(s)) &&
        p.maxPositionAmountUsd >= 300 &&
        p.maxPositionAmountUsd <= 1000
      );
    }),
  );
  ok('lock "Portfolio is busy" obsłużony retry', () => views.some((b) => b.log.some((l) => /busy/i.test(l.msg))));
  ok('logi zawierają decyzje AI', () => views.some((b) => b.log.some((l) => /decision:/.test(l.msg))));

  const id = store.accounts.accounts[0].id;
  managerOffline.pauseBot(id);
  await sleep(3000);
  const t1 = store.getBotState(id).last_tick;
  await sleep(3000);
  ok('pause zatrzymuje pętlę', () => {
    const s = store.getBotState(id);
    return s.status === 'paused' && s.last_tick === t1;
  });
  managerOffline.resumeBot(id);
  await sleep(4000);
  ok('resume wznawia pętlę', () => store.getBotState(id).last_tick !== t1);
  await managerOffline.deleteBot(id);
  ok('delete usuwa konto i stan', () => store.getAccount(id) === undefined && store.state.bots[id] === undefined);

  // propozycje nazw + walidacja createAccounts
  const props = managerOffline.proposeAccounts(5);
  ok('proposeAccounts: 5 unikalnych par (nick/email)', () => {
    assert.strictEqual(props.length, 5);
    const nicks = props.map((p) => p.nickname.toLowerCase());
    assert.strictEqual(new Set(nicks).size, 5);
    for (const p of props) {
      assert.match(p.nickname, /^[a-zA-Z0-9_]{3,24}$/, `nick: ${p.nickname}`);
      assert.match(p.email, /^[^\s@]+@[^\s@]+\.[^\s@]+$/, `email: ${p.email}`);
    }
  });
  ok('proposeAccounts respektuje exclude', () => {
    const again = managerOffline.proposeAccounts(3, props);
    for (const p of again) {
      assert.ok(!props.some((x) => x.nickname.toLowerCase() === p.nickname.toLowerCase()), `duplikat: ${p.nickname}`);
    }
  });
  ok('createAccounts: błędne nazwy odrzucone (queued 0 + errors)', () => {
    const r = managerOffline.createAccounts([{ nickname: 'zły nick!', email: 'bad' }]);
    assert.strictEqual(r.queued, 0);
    assert.ok(r.errors.length >= 1);
  });
  ok('createAccounts: poprawne jawnie podane nazwy przyjęte', () => {
    const r = managerOffline.createAccounts([{ nickname: 'Tester_A1', email: 'tester_a1@wp.pl' }]);
    assert.strictEqual(r.queued, 1);
  });
}

// ============ C2. Join odrzucony (zamknięte okno) -> waiting ============
console.log('\nC2. join zamknięty -> waiting:');
{
  const store = new Store({ accountsFile: join(tmp, 'closed-accounts.json'), stateFile: join(tmp, 'closed-state.json') });
  const sim = new TradeSimulator({ status: 'settling' }); // poza oknem zapisów
  const account = { id: 'b-closed', nickname: 'x', email: 'x@y.z', password: 'pppppppp', token: null, user_id: null, player_id: null, tournament_id: null };
  const api = new ApiClient({ cfg, account, offline: true, sim });
  await api.register('Closed_Probe', 'closed_probe@y.z', 'pppppppp');
  const engine = new BotEngine({ account, api, llm: new LlmClient({ provider: 'mock' }), store, cfg, botId: 'b-closed' });
  await engine.ensureJoined();
  ok('join 422 -> status waiting, bez player_id', () => {
    assert.strictEqual(store.getBotState('b-closed').status, 'waiting');
    assert.strictEqual(account.player_id, null);
  });
}

// ============ D. HTTP stub E2E ============
console.log('\nD. HTTP stub E2E:');
{
  const stub = await startStub({ port: 8092 });
  const store = new Store({ accountsFile: join(tmp, 'http-accounts.json'), stateFile: join(tmp, 'http-state.json') });
  const cfgHttp = structuredClone(cfg);
  cfgHttp.api.baseUrl = 'http://127.0.0.1:8092/api';
  const manager = new BotManager({ store, cfg: cfgHttp, llm: new LlmClient({ provider: 'mock' }) });
  manager.createAccounts(1);
  await sleep(5000);
  ok('rejestracja przez HTTP', () => {
    const a = store.accounts.accounts[0];
    return Boolean(a && a.token && a.token.startsWith('stub-'));
  });
  await sleep(9000);
  const v = store.botViews()[0];
  ok('join + handel przez HTTP', () => Boolean(v && v.portfolio && v.log.some((l) => /opened|set_tp_sl|closed/.test(l.msg))));
  stub.close();
}

// ============ E. 429 backoff + 401 single-flight re-login ============
console.log('\nE. 429 backoff i 401 re-login:');
{
  let hits = 0;
  const srv = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const json = (code, obj, extra = {}) => {
      const body = JSON.stringify(obj);
      res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), ...extra });
      res.end(body);
    };
    if (req.method === 'POST' && url.pathname === '/api/auth/login') {
      for await (const c of req) { /* wyczyść body */ }
      return json(200, { token: 'tok-2', user: { id: 1 } });
    }
    if (req.method === 'GET' && url.pathname === '/api/x') {
      if (req.headers.authorization !== 'Bearer tok-2') return json(401, { message: 'unauthorized' });
      if (++hits <= 2) return json(429, { message: 'Too Many Requests' }, { 'Retry-After': '1' });
      return json(200, { ok: true });
    }
    return json(404, { message: 'not found' });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  const cfgC = {
    api: { baseUrl: `http://127.0.0.1:${port}/api`, requestTimeoutMs: 5000, retriesOn5xx: 2 },
    account: { registerIntervalMs: 100 },
    trading: { minOrderSpacingMs: 100 },
  };
  const client = new ApiClient({
    cfg: cfgC,
    account: { id: 'b-x', email: 'a@b.c', password: 'p', nickname: 'x', token: null, user_id: null, player_id: null },
  });
  const t0 = Date.now();
  const r = await client.request('GET', '/x', { auth: true, retries: 4 });
  ok('401 -> re-login -> 429 x2 -> 200', () => assert.strictEqual(r.ok, true));
  ok('backoff (Retry-After 1s) realnie czeka', () => assert.ok(Date.now() - t0 >= 900, `zajęło ${Date.now() - t0}ms`));
  ok('token odświeżony po 401', () => assert.strictEqual(client.account.token, 'tok-2'));
  srv.close();
}

// ============ cleanup ============
managerOffline?.stopAll();
rmSync(tmp, { recursive: true, force: true });
console.log(`\nWynik: ${passed} OK, ${failed} FAIL`);
process.exit(failed ? 1 : 0);
