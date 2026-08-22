import { join } from 'node:path';
import { loadJsonFile, atomicWriteJson, now } from './util.js';
import { ROOT } from './config.js';

// accounts.json  — tożsamości kont (nickname/email/password/token) + player_id
// state.json     — live snapshoty botów (equity, pozycje, rank, log, status)
// dataDir: katalog per target (data/<target>) z oboma plikami; bez niego legacy (ROOT).
export class Store {
  constructor({ dataDir = ROOT, accountsFile = null, stateFile = null } = {}) {
    if (dataDir == null) dataDir = ROOT; // null nie aktywuje defaulta destrukturyzacji
    this.accountsFile = accountsFile ?? join(dataDir, 'accounts.json');
    this.stateFile = stateFile ?? join(dataDir, 'state.json');
    this.accounts = loadJsonFile(accountsFile, { version: 1, accounts: [] });
    this.state = loadJsonFile(stateFile, { version: 1, bots: {} });
  }

  saveAccounts() {
    atomicWriteJson(this.accountsFile, this.accounts);
  }

  saveState() {
    atomicWriteJson(this.stateFile, this.state);
  }

  // --- accounts ---
  getAccount(id) {
    return this.accounts.accounts.find((a) => a.id === id);
  }

  upsertAccount(acc) {
    const list = this.accounts.accounts;
    const i = list.findIndex((a) => a.id === acc.id);
    if (i >= 0) list[i] = acc;
    else list.push(acc);
    this.saveAccounts();
  }

  removeAccount(id) {
    const list = this.accounts.accounts;
    const i = list.findIndex((a) => a.id === id);
    if (i >= 0) {
      list.splice(i, 1);
      this.saveAccounts();
    }
  }

  // --- state ---
  getBotState(id) {
    let s = this.state.bots[id];
    if (!s) {
      s = {
        id,
        status: 'new',
        last_tick: null,
        last_error: null,
        tick_failures: 0,
        tournament: null,
        portfolio: null,
        positions: [],
        pending_orders: [],
        rank: null,
        players_count: null,
        last_decision: null,
        log: [],
        created_at: now(),
      };
      this.state.bots[id] = s;
    }
    return s;
  }

  removeBotState(id) {
    delete this.state.bots[id];
  }

  addLogEntry(id, level, msg) {
    const s = this.getBotState(id);
    s.log.push({ ts: now(), level, msg });
    if (s.log.length > 200) s.log.splice(0, s.log.length - 200);
    return s;
  }

  // Wszystkie stany botów do dashboardu (bez internalnych pól).
  botViews() {
    return Object.values(this.state.bots).map((s) => ({
      id: s.id,
      status: s.status,
      last_tick: s.last_tick,
      last_error: s.last_error,
      tournament: s.tournament ? { id: s.tournament.id, name: s.tournament.name, status: s.tournament.status, is_paid: s.tournament.is_paid } : null,
      portfolio: s.portfolio,
      positions: s.positions,
      pending_orders: s.pending_orders,
      trading_plan: s.trading_plan ?? null,
      rank: s.rank,
      players_count: s.players_count,
      last_decision: s.last_decision,
      log: s.log.slice(-30),
      created_at: s.created_at,
    }));
  }
}
