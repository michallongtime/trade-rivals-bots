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
import { loadTargets, listTargets, resolveTargetName, applyTargetOverrides } from '../src/targets.js';
import { startStub } from './stub-server.js';
import { createAuthGuard, assertAuthConfig, parseBasic } from '../src/auth.js';
import { createServer } from '../src/server.js';
import { seededRandom, randBetween } from '../src/util.js';

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
cfg.trading.idleChancePerTick = 0; // kamuflaż wyłączony w testach — deterministyczne czasy
cfg.trading.tickJitterFraction = 0;

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
  ok('historia dołączonych turniejów w widoku bota', () =>
    views.every((b) => (b.joinedTournaments ?? []).some((t) => t.id === 7 && t.name && t.joined_at)));
  ok('licznik zapytań AI per bot > 0', () => views.every((b) => (b.aiRequests ?? 0) > 0));
  ok('wymiany AI zapisane (prompt + odpowiedź)', () => {
    const st = store.getBotState(Object.keys(store.state.bots)[0]);
    return (
      Array.isArray(st.ai_exchanges) &&
      st.ai_exchanges.length > 0 &&
      typeof st.ai_exchanges[0].system === 'string' &&
      st.ai_exchanges[0].user &&
      st.ai_exchanges[0].response != null &&
      st.ai_exchanges[0].tournament_id === 7
    );
  });
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
  await engine.joinMore(store.getBotState('b-closed'));
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

// ============ F. Targety (cel serwera) ============
console.log('\nF. Targety:');
{
  const t = loadTargets();
  ok('targets.json: default = local, są local+prod', () => {
    assert.strictEqual(t.default, 'local');
    assert.ok(t.targets.local && t.targets.prod);
  });
  ok('listTargets pokazuje baseUrl', () => {
    const l = listTargets(t);
    assert.ok(l.some((e) => e.name === 'local' && e.baseUrl === 'http://localhost:8080/api'));
  });
  ok('resolveTargetName: znany target', () => assert.strictEqual(resolveTargetName('prod', t, 'local'), 'prod'));
  ok('resolveTargetName: brak flagi -> default', () => assert.strictEqual(resolveTargetName(null, t, 'local'), 'local'));
  ok('resolveTargetName: nieznany -> błąd z listą', () => {
    assert.throws(() => resolveTargetName('nope', t, 'local'), /nieznany target/);
  });
  const cfgT = loadConfig();
  applyTargetOverrides(cfgT, t.targets.prod);
  ok('nadpisania targetu wygrywają z config.json', () => assert.strictEqual(cfgT.api.baseUrl, t.targets.prod.api.baseUrl));
  const d = mkdtempSync(join(tmpdir(), 'tcbot-tgt-'));
  const sLocal = new Store({ dataDir: join(d, 'local') });
  const sProd = new Store({ dataDir: join(d, 'prod') });
  sLocal.upsertAccount({ id: 'b-1', nickname: 'x', email: 'x@y.z', password: 'p', token: 't', user_id: 1, player_id: 2, tournament_id: 7, created_at: 'now' });
  ok('konto targetu nie wycieka do innego targetu', () => {
    assert.strictEqual(sLocal.getAccount('b-1').token, 't');
    assert.strictEqual(sProd.getAccount('b-1'), undefined);
  });
  ok('dataDir: konto i stan wczytane po przeładowaniu (regresja ładowania)', () => {
    const d2 = mkdtempSync(join(tmpdir(), 'tcbot-tgt2-'));
    const s1 = new Store({ dataDir: join(d2, 'prod') });
    s1.upsertAccount({ id: 'b-9', nickname: 'x', email: 'x@y.z', password: 'p', token: 't', user_id: 1, player_id: 2, tournament_id: 7, created_at: 'now' });
    s1.addLogEntry('b-9', 'info', 'hello');
    s1.saveState();
    const s2 = new Store({ dataDir: join(d2, 'prod') });
    assert.strictEqual(s2.getAccount('b-9').token, 't', 'konto wczytane z dataDir');
    assert.strictEqual(s2.state.bots['b-9'].log[0].msg, 'hello', 'stan wczytany z dataDir');
    rmSync(d2, { recursive: true, force: true });
  });
  rmSync(d, { recursive: true, force: true });
}

// ============ G. Autoryzacja dashboardu (auth.js + server) ============
console.log('\nG. Autoryzacja (Basic + X-Auth-Token + lockout):');
{
  const AUTH = { user: 'admin', pass: 'pass', token: 'tok', maxAttempts: 4, lockMs: 1800000 };
  const guard = createAuthGuard({ server: { auth: AUTH } });
  const req = (ip, auth, token) => ({
    socket: { remoteAddress: ip },
    headers: { authorization: auth, 'x-auth-token': token },
  });
  const basic = (u, p) => 'Basic ' + Buffer.from(`${u}:${p}`).toString('base64');

  ok('parseBasic: poprawny nagłówek', () => {
    assert.deepStrictEqual(parseBasic(basic('user', 'pass')), { user: 'user', pass: 'pass' });
  });
  ok('parseBasic: hasło z dwukropkiem', () => {
    assert.deepStrictEqual(parseBasic(basic('user', 'pa:ss')), { user: 'user', pass: 'pa:ss' });
  });
  ok('parseBasic: śmieci -> null', () => {
    assert.strictEqual(parseBasic('Bearer xyz'), null);
    assert.strictEqual(parseBasic(undefined), null);
  });
  ok('poprawne dane -> allowed', () => {
    assert.strictEqual(guard(req('1.2.3.4', basic('admin', 'pass'), 'tok')).allowed, true);
  });
  ok('brak tokenu -> 401', () => {
    const r = guard(req('1.2.3.5', basic('admin', 'pass'), null));
    assert.strictEqual(r.allowed, false);
    assert.strictEqual(r.status, 401);
  });
  ok('żądania bez nagłówka Authorization nie liczą się do blokady', () => {
    const g = createAuthGuard({ server: { auth: { ...AUTH, maxAttempts: 2 } } });
    for (let i = 0; i < 10; i++) {
      assert.strictEqual(g(req('5.5.5.5', null, null)).status, 401, `puste ${i + 1}`);
    }
    assert.strictEqual(g(req('5.5.5.5', basic('admin', 'pass'), 'tok')).allowed, true, 'po 10 pustych 401 poprawne dane nadal wchodzą');
  });
  ok('zły user -> 401', () => {
    assert.strictEqual(guard(req('1.2.3.6', basic('nope', 'pass'), 'tok')).status, 401);
  });
  ok('4 błędy z IP -> 429 nawet z poprawnymi danymi (5. próba)', () => {
    const g = createAuthGuard({ server: { auth: AUTH } });
    for (let i = 0; i < 4; i++) {
      const r = g(req('9.9.9.9', basic('zly', 'user'), 'zly'));
      assert.strictEqual(r.status, 401);
    }
    const r5 = g(req('9.9.9.9', basic('admin', 'pass'), 'tok'));
    assert.strictEqual(r5.status, 429);
    assert.ok(r5.retryAfter > 0 && r5.retryAfter <= 1800, `retryAfter: ${r5.retryAfter}`);
  });
  ok('inne IP niezablokowane', () => {
    assert.strictEqual(guard(req('8.8.8.8', basic('admin', 'pass'), 'tok')).allowed, true);
  });
  ok('lock wygasa -> poprawne dane wchodzą', async () => {
    const g = createAuthGuard({ server: { auth: { ...AUTH, lockMs: 120 } } });
    for (let i = 0; i < 4; i++) g(req('7.7.7.7', basic('zly', 'user'), 'zly'));
    assert.strictEqual(g(req('7.7.7.7', basic('admin', 'pass'), 'tok')).status, 429);
    await sleep(200);
    assert.strictEqual(g(req('7.7.7.7', basic('admin', 'pass'), 'tok')).allowed, true);
  });
  ok('sukces resetuje licznik błędów', () => {
    const g = createAuthGuard({ server: { auth: { ...AUTH, maxAttempts: 2 } } });
    g(req('6.6.6.6', basic('zly', 'user'), 'zly')); // 1 błąd
    assert.strictEqual(g(req('6.6.6.6', basic('admin', 'pass'), 'tok')).allowed, true); // reset
    assert.strictEqual(g(req('6.6.6.6', basic('zly', 'user'), 'zly')).status, 401); // znowu 1. błąd
    assert.strictEqual(g(req('6.6.6.6', basic('zly', 'user'), 'zly')).status, 401); // 2. błąd uzbraja lock
    assert.strictEqual(g(req('6.6.6.6', basic('admin', 'pass'), 'tok')).status, 429); // kolejna -> 429 mimo dobrych danych
  });
  ok('brak auth w configu = guard wyłączony', () => {
    const g = createAuthGuard({ server: { host: '127.0.0.1' } });
    assert.strictEqual(g(req('1.1.1.1', null, null)).allowed, true);
  });
  ok('assertAuthConfig: 0.0.0.0 bez auth -> throw', () => {
    assert.throws(() => assertAuthConfig({ server: { host: '0.0.0.0' } }), /server\.auth/);
  });
  ok('assertAuthConfig: loopback bez auth -> OK', () => {
    assert.doesNotThrow(() => assertAuthConfig({ server: { host: '127.0.0.1' } }));
  });
  ok('assertAuthConfig: 0.0.0.0 z kompletnym auth -> OK', () => {
    assert.doesNotThrow(() => assertAuthConfig({ server: { host: '0.0.0.0', auth: AUTH } }));
  });

  // --- integracja: prawdziwy createServer (port 0) ---
  okAsync('HTTP: health publiczne, status 401/200, lockout po 2 błędach', async () => {
    const store = { botViews: () => [], accounts: { accounts: [] }, getAccount: () => undefined, getBotState: () => ({ log: [] }), aiRequestsTotal: () => 0 };
    const manager = { registrationQueueLen: () => 0 };
    const cfgG = loadConfig();
    cfgG.server = { host: '127.0.0.1', port: 0, auth: { user: 'admin', pass: 'pass', token: 'tok', maxAttempts: 2, lockMs: 60000 } };
    const srv = createServer({ manager, store, cfg: cfgG, offline: false, dryRun: true, startedAt: Date.now(), targetName: 'test' });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${srv.address().port}`;
    const get = async (path, headers = {}) => fetch(base + path, { headers });

    assert.strictEqual((await get('/api/health')).status, 200, 'health bez creds');
    assert.strictEqual((await get('/api/status')).status, 401, 'status bez creds (puste żądania nie liczą się do blokady)');
    assert.strictEqual((await get('/api/status')).status, 401, 'kolejne puste żądanie też nie liczy się do blokady');
    const okStatus = await get('/api/status', { Authorization: basic('admin', 'pass'), 'X-Auth-Token': 'tok' });
    assert.strictEqual(okStatus.status, 200, 'status z creds (po pustych żądaniach nadal wchodzi)');
    assert.strictEqual((await get('/')).status, 200, 'skorupa HTML publiczna');
    assert.strictEqual((await get('/api/status', { Authorization: basic('zly', 'zly'), 'X-Auth-Token': 'zly' })).status, 401, 'złe dane (1. błąd)');
    const armed = await get('/api/status', { Authorization: basic('zly', 'zly'), 'X-Auth-Token': 'zly' });
    assert.strictEqual(armed.status, 401, '2. błąd uzbraja lock (samo żądanie wciąż 401)');
    const locked = await get('/api/status', { Authorization: basic('admin', 'pass'), 'X-Auth-Token': 'tok' });
    assert.strictEqual(locked.status, 429, 'kolejna próba -> 429');
    assert.ok(Number(locked.headers.get('retry-after')) > 0, 'Retry-After nagłówek');
    const stillLocked = await get('/api/status', { Authorization: basic('admin', 'pass'), 'X-Auth-Token': 'tok' });
    assert.strictEqual(stillLocked.status, 429, 'zablokowany IP dostaje 429 nawet z poprawnymi danymi');

    srv.close();
  });
}

// ============ H. Kamuflaż aktywności (seeded PRNG, jitter, idle) ============
console.log('\nH. Kamuflaż aktywności:');
{
  ok('seededRandom: deterministyczny dla tego samego id', () => {
    const a = Array.from({ length: 10 }, () => seededRandom('b-abc')());
    const b = Array.from({ length: 10 }, () => seededRandom('b-abc')());
    assert.deepStrictEqual(a, b);
  });
  ok('seededRandom: różne id -> różne sekwencje', () => {
    assert.notStrictEqual(seededRandom('b-abc')(), seededRandom('b-xyz')());
  });
  ok('randBetween: wartości w zakresie', () => {
    const rng = seededRandom('b-test');
    for (let i = 0; i < 100; i++) {
      const v = randBetween(rng, 300000, 2400000);
      assert.ok(v >= 300000 && v <= 2400000, `v=${v}`);
    }
  });
  ok('profil per bot: base w 70-130% intervalMs', () => {
    const rng = seededRandom('b-profil');
    const base = Math.round(45000 * (0.7 + 0.6 * rng()));
    assert.ok(base >= 31500 && base <= 58500, `base=${base}`);
  });
  ok('jitter: odstęp w zakresie base*(1±0.5)', () => {
    const rng = seededRandom('b-jitter');
    for (let i = 0; i < 100; i++) {
      const j = 1 + (rng() * 2 - 1) * 0.5;
      const wait = Math.max(5000, Math.round(45000 * j));
      assert.ok(wait >= 22500 && wait <= 67500, `wait=${wait}`);
    }
  });
}

// ============ I. Multi-turnieje (jeden bot gra w maxTurniejów) ============
console.log('\nI. Multi-turnieje:');
{
  // await — sekcja jest ostatnia przed synchronicznym cleanupem; bez tego
  // proces.exit zdąży ubić niezakończony test
  await okAsync('bot dołącza do 2 turniejów i handluje w obu', async () => {
    const T = {
      1: { id: 1, name: 'Alpha', status: 'running', can_join: true, markets: [{ id: 1, symbol: 'BTCUSDT' }] },
      2: { id: 2, name: 'Beta', status: 'running', can_join: true, markets: [{ id: 1, symbol: 'BTCUSDT' }] },
    };
    const srv = http.createServer(async (req, res) => {
      const url = new URL(req.url, 'http://x');
      const json = (code, obj) => {
        const b = JSON.stringify(obj);
        res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(b) });
        res.end(b);
      };
      if (req.method === 'POST' && url.pathname === '/api/auth/login') { for await (const c of req) { /* body */ } return json(200, { token: 'tok-m', user: { id: 77 } }); }
      if (req.method === 'GET' && url.pathname === '/api/tournaments') return json(200, { tournaments: Object.values(T) });
      let m = url.pathname.match(/^\/api\/tournaments\/(\d+)\/join$/);
      if (req.method === 'POST' && m) { for await (const c of req) { /* body */ } return json(200, { player: { id: 100 + Number(m[1]) } }); }
      m = url.pathname.match(/^\/api\/tournaments\/(\d+)$/);
      if (req.method === 'GET' && m) return json(200, { tournament: T[m[1]] });
      if (req.method === 'POST' && /^\/api\/portfolios\/\d+\/orders$/.test(url.pathname)) {
        for await (const c of req) { /* body */ }
        return json(200, { order: { id: 11, position_id: 1 } });
      }
      if (req.method === 'GET' && url.pathname.startsWith('/api/portfolios/')) {
        if (url.pathname.endsWith('/orders')) return json(200, { orders: [] });
        if (url.pathname.endsWith('/transactions')) return json(200, { transactions: [] });
        return json(200, { player: { equity: '10000.00000000', cash_balance: '10000.00000000', unrealized_pnl: '0.00000000' }, positions: [] });
      }
      if (req.method === 'GET' && url.pathname === '/api/prices/BTCUSDT') return json(200, { price: '65000.00' });
      if (req.method === 'GET' && url.pathname === '/api/candles') return json(200, { candles: [] });
      m = url.pathname.match(/^\/api\/tournaments\/(\d+)\/ranking$/);
      if (req.method === 'GET' && m) return json(200, { ranking: [{ rank: 1, player_id: 77 }] });
      return json(404, { message: 'not found' });
    });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));

    const cfgI = loadConfig();
    cfgI.account.maxTournamentsPerBot = 2;
    cfgI.trading.intervalMs = 1000;
    const store = new Store({ accountsFile: join(tmp, 'multi-accounts.json'), stateFile: join(tmp, 'multi-state.json') });
    const account = { id: 'b-multi', nickname: 'Multi', email: 'm@x.y', password: 'p', token: 'tok-m', user_id: 77, player_id: null, tournament_id: null, players: {} };
    const api = new ApiClient({
      cfg: { ...cfgI, api: { ...cfgI.api, baseUrl: `http://127.0.0.1:${srv.address().port}/api` } },
      account,
    });
    const engine = new BotEngine({ account, api, llm: new LlmClient({ provider: 'mock' }), store, cfg: cfgI, botId: 'b-multi' });
    await engine.tick();
    await engine.tick();

    ok('dołączył do 2 turniejów (players: tid -> player_id)', () => {
      assert.deepStrictEqual(Object.keys(account.players).sort(), ['1', '2']);
      assert.strictEqual(account.players[1], 101);
      assert.strictEqual(account.players[2], 102);
    });
    const st = store.getBotState('b-multi');
    ok('stan per turniej: 2 wpisy running', () => {
      assert.strictEqual(Object.keys(st.tournaments).length, 2);
      assert.ok(Object.values(st.tournaments).every((t) => t.status === 'running'));
    });
    ok('bot aggregate = running', () => assert.strictEqual(st.status, 'running'));
    ok('historia turniejów ma 2 wpisy', () => assert.strictEqual(st.joinedTournaments.length, 2));
    srv.close();
  });
}

// ============ cleanup ============
managerOffline?.stopAll();
rmSync(tmp, { recursive: true, force: true });
console.log(`\nWynik: ${passed} OK, ${failed} FAIL`);
process.exit(failed ? 1 : 0);
