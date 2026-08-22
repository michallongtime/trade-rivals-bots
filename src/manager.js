// manager.js — cykl życia botów: globalna kolejka rejestracji (pacing z limitu
// 10/min), start/pause/resume/delete (per-bot AbortController), odświeżanie
// tokenów po 401 (single-flight w ApiClient).
import { ApiClient, ApiError } from './api.js';
import { TradeSimulator } from './mock.js';
import { runBotLoop } from './engine.js';
import { generateNickname, generateEmail } from './names.js';
import { log, now, shortId, sleep } from './util.js';

export class BotManager {
  constructor({ store, cfg, llm, offline = false, dryRun = false, sim = null }) {
    this.store = store;
    this.cfg = cfg;
    this.llm = llm;
    this.offline = offline;
    this.dryRun = dryRun;
    this.sim = sim ?? (offline ? new TradeSimulator({ symbols: cfg.trading.symbols, maxLeverage: cfg.trading.maxLeverage }) : null);
    this.queue = Promise.resolve();
    this.pendingRegistrations = 0;
    this.loops = new Map(); // botId -> AbortController
  }

  apiFor(account) {
    return new ApiClient({
      cfg: this.cfg,
      account,
      offline: this.offline,
      dryRun: this.dryRun,
      sim: this.sim,
      onAuthRefreshed: (acc) => this.store.upsertAccount(acc),
    });
  }

  registrationQueueLen() {
    return this.pendingRegistrations;
  }

  // Propozycje nazw dla dashboardu: unikalne, poza istniejącymi kontami
  // i poza exclude (bieżące propozycje w modalu).
  proposeAccounts(count, exclude = []) {
    const n = Math.max(1, Math.min(Math.floor(Number(count) || 1), 500));
    const style = this.cfg.account.nameStyle ?? 'mixed';
    const domains = this.cfg.account.emailDomains ?? null;
    const usedNicks = new Set(this.store.accounts.accounts.map((a) => a.nickname.toLowerCase()));
    const usedEmails = new Set(this.store.accounts.accounts.map((a) => a.email.toLowerCase()));
    for (const x of exclude) {
      usedNicks.add(String(x.nickname ?? x ?? '').toLowerCase());
      usedEmails.add(String(x.email ?? '').toLowerCase());
    }
    const out = [];
    for (let i = 0; i < n; i++) {
      const nickname = generateNickname(style, usedNicks);
      usedNicks.add(nickname.toLowerCase());
      const email = generateEmail({ nickname, style, domains });
      usedEmails.add(email.toLowerCase());
      out.push({ nickname, email });
    }
    return out;
  }

  // Kolejka rejestracji: pojedynczy łańcuch Promise + pacing >= registerIntervalMs
  // (limit API: 10 rejestracji/min). Akceptuje liczbę (generuje propozycje)
  // lub tablicę jawnych {nickname, email} z dashboardu. Odpowiada od razu,
  // rejestracja w tle.
  createAccounts(input) {
    let items;
    if (Array.isArray(input)) {
      items = input.map((x) => ({ nickname: String(x?.nickname ?? '').trim(), email: String(x?.email ?? '').trim() }));
    } else {
      items = this.proposeAccounts(input);
    }
    const errors = [];
    const seen = new Set();
    for (const it of items) {
      if (!/^[a-zA-Z0-9_]{3,24}$/.test(it.nickname)) errors.push(`nickname „${it.nickname}": 3-24 znaki [a-zA-Z0-9_]`);
      else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(it.email)) errors.push(`email „${it.email}": nieprawidłowy adres`);
      const key = `${it.nickname.toLowerCase()}|${it.email.toLowerCase()}`;
      if (seen.has(key)) errors.push(`duplikat w zgłoszeniu: ${it.nickname}`);
      seen.add(key);
    }
    if (errors.length) {
      log('warn', `createAccounts odrzucone: ${errors.join('; ')}`);
      return { queued: 0, errors };
    }
    this.pendingRegistrations += items.length;
    for (const it of items) {
      this.queue = this.queue.then(() => this.#registerOne(it.nickname, it.email));
    }
    log('info', `queued ${items.length} account(s)`);
    return { queued: items.length };
  }

  async #registerOne(nickname, email) {
    const account = {
      id: `b-${shortId(3)}`,
      nickname,
      email,
      password: this.cfg.account.password,
      token: null,
      user_id: null,
      player_id: null,
      tournament_id: null,
      created_at: now(),
    };
    try {
      const api = this.apiFor(account);
      const res = await api.register(nickname, email, account.password);
      account.token = res.token;
      account.user_id = res.user.id;
      this.store.upsertAccount(account);
      log('info', `registered ${account.nickname} <${account.email}> (id ${account.user_id})`);
      this.startBot(account.id);
    } catch (e) {
      const taken = e instanceof ApiError && e.status === 422 && /taken/i.test(JSON.stringify(e.body?.errors ?? {}));
      log('error', taken ? `rejected for ${nickname}: nazwa/email zajęte na serwerze — wybierz inną` : `registration failed for ${nickname}: ${e.message}`);
    } finally {
      this.pendingRegistrations = Math.max(0, this.pendingRegistrations - 1);
      await sleep(this.cfg.account.registerIntervalMs);
    }
  }

  startBot(botId) {
    if (this.loops.has(botId)) return;
    const account = this.store.getAccount(botId);
    if (!account) return;
    const controller = new AbortController();
    this.loops.set(botId, controller);
    const api = this.apiFor(account);
    const state = this.store.getBotState(botId);
    state.status = 'running';
    state.last_error = null;
    this.store.addLogEntry(botId, 'info', 'bot started');
    runBotLoop(botId, { account, api, llm: this.llm, store: this.store, cfg: this.cfg }, controller)
      .catch((e) => {
        if (e.code !== 'ABORTED') log('error', `bot ${botId} crashed: ${e.message}`);
      })
      .finally(() => {
        if (this.loops.get(botId) === controller) this.loops.delete(botId);
      });
  }

  pauseBot(botId) {
    const c = this.loops.get(botId);
    if (c) c.abort();
    const state = this.store.getBotState(botId);
    state.status = 'paused';
    state.last_error = null;
    this.store.addLogEntry(botId, 'info', 'paused');
    return { status: 'paused' };
  }

  resumeBot(botId) {
    const state = this.store.getBotState(botId);
    state.status = 'running';
    state.tick_failures = 0;
    state.last_error = null;
    this.store.addLogEntry(botId, 'info', 'resumed');
    this.startBot(botId);
    return { status: 'running' };
  }

  // Usunięcie: abort -> logout tokenu (best effort) -> wykluczenie z zarządzania.
  async deleteBot(botId) {
    const c = this.loops.get(botId);
    if (c) c.abort();
    const account = this.store.getAccount(botId);
    if (account) {
      try {
        await this.apiFor(account).logout();
        log('info', `logged out ${account.nickname}`);
      } catch (e) {
        log('warn', `logout failed for ${botId}: ${e.message}`);
      }
    }
    this.store.removeAccount(botId);
    this.store.removeBotState(botId);
    return { deleted: true };
  }

  // Przy starcie aplikacji wznawia wszystkie boty poza zapauzowanymi.
  startAllActive() {
    for (const acc of this.store.accounts.accounts) {
      const state = this.store.getBotState(acc.id);
      if (state.status === 'paused') continue;
      this.startBot(acc.id);
    }
  }

  // Zatrzymanie wszystkiego (shutdown).
  stopAll() {
    for (const [botId, c] of this.loops) {
      c.abort();
      this.store.addLogEntry(botId, 'info', 'stopped (shutdown)');
    }
    this.loops.clear();
  }
}
