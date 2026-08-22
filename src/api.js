// ApiClient — klient HTTP API TradeContest (Laravel Sanctum, Bearer tokens).
//   - Throttle per klucz (auth/join/orders) — limity z API.md
//   - 429 -> backoff wykładniczy (szanuje Retry-After)
//   - 401 -> single-flight re-login (współdzielony Promise), potem 1 retry
//   - 5xx -> retry z backoffem
//   - Tryby: offline (symulator in-memory) i dryRun (odczyty live, mutacje tylko logowane)
import { log, sleep, shortId } from './util.js';

export class ApiError extends Error {
  constructor(status, body = null) {
    super((body && (body.message || body.error)) || `HTTP ${status}`);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
  }
}

export class AlreadyJoined extends ApiError {
  constructor(body) {
    super(409, body);
    this.name = 'AlreadyJoined';
  }
}

export class InsufficientFunds extends ApiError {
  constructor(body) {
    super(402, body);
    this.name = 'InsufficientFunds';
  }
}

class Throttle {
  constructor(spacings) {
    this.spacings = spacings; // { auth: ms, join: ms, orders: ms }
    this.last = new Map();
  }

  async acquire(key) {
    const spacing = this.spacings[key];
    if (!spacing) return;
    const last = this.last.get(key) ?? 0;
    const wait = last + spacing - Date.now();
    if (wait > 0) await sleep(wait);
    this.last.set(key, Date.now());
  }
}

export class ApiClient {
  constructor({ cfg, account, offline = false, dryRun = false, sim = null, onAuthRefreshed = null }) {
    this.cfg = cfg;
    this.account = account; // mutowany: token / user_id
    this.offline = offline;
    this.dryRun = dryRun;
    this.sim = sim;
    this.onAuthRefreshed = onAuthRefreshed;
    this.throttle = new Throttle({
      auth: cfg.account.registerIntervalMs,
      join: 3200, // 20/min
      orders: cfg.trading.minOrderSpacingMs, // 30/min
    });
    this.loginPromise = null;
  }

  // ---------- niski poziom ----------
  async request(method, path, { auth = false, body = null, query = null, key = null, retries = null } = {}) {
    const base = this.cfg.api.baseUrl.replace(/\/+$/, '');
    const url = new URL(base + path);
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v != null) url.searchParams.set(k, v);
      }
    }
    const maxAttempts = retries ?? this.cfg.api.retriesOn5xx + 1;
    let lastErr = null;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      await this.throttle.acquire(key);
      try {
        const res = await this.#rawFetch(method, url, { auth, body });
        if (res.status === 429) {
          const retryAfterMs = Number(res.headers.get('retry-after')) * 1000;
          const delay = Math.min(Number.isFinite(retryAfterMs) && retryAfterMs > 0 ? retryAfterMs : 1000 * 2 ** attempt, 30000);
          log('warn', `429 throttled (${path}), retry in ${delay}ms`);
          await sleep(delay);
          continue;
        }
        if (res.status === 401 && auth) {
          const ok = await this.relogin();
          if (ok) continue; // 1 próba po odświeżeniu tokenu
          throw new ApiError(401, { message: 'unauthorized (re-login failed)' });
        }
        if (res.status >= 500) {
          log('warn', `HTTP ${res.status} ${path}, retry ${attempt + 1}/${maxAttempts}`);
          await sleep(Math.min(1000 * 2 ** attempt, 10000));
          continue;
        }
        return await this.#parse(res);
      } catch (e) {
        if (e instanceof ApiError) throw e;
        // ABORTED = nasz przerwany sleep; AbortError = timeout fetch — nie retry'ujemy
        // (mutacja mogła dojść do serwera, powtórka groziłaby podwójnym zleceniem)
        if (e.code === 'ABORTED' || e.name === 'AbortError') throw e;
        lastErr = e;
        log('warn', `network error ${path}: ${e.message}, retry ${attempt + 1}/${maxAttempts}`);
        await sleep(Math.min(1000 * 2 ** attempt, 10000));
      }
    }
    throw lastErr ?? new Error(`request failed after ${maxAttempts} attempts: ${method} ${path}`);
  }

  async #rawFetch(method, url, { auth, body }) {
    const headers = { Accept: 'application/json' };
    if (body) headers['Content-Type'] = 'application/json';
    if (auth && this.account.token) headers.Authorization = `Bearer ${this.account.token}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.cfg.api.requestTimeoutMs);
    try {
      return await fetch(url, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  async #parse(res) {
    let data = null;
    try {
      data = await res.json();
    } catch {
      // brak JSON-a w odpowiedzi — zostaw null
    }
    if (res.status >= 400) {
      if (res.status === 409) throw new AlreadyJoined(data);
      if (res.status === 402) throw new InsufficientFunds(data);
      throw new ApiError(res.status, data);
    }
    return data;
  }

  async relogin() {
    if (!this.loginPromise) {
      this.loginPromise = this.login(this.account.email, this.account.password)
        .then(() => true)
        .catch((e) => {
          log('error', `re-login failed for ${this.account.nickname}: ${e.message}`);
          return false;
        })
        .finally(() => {
          this.loginPromise = null;
        });
    }
    return this.loginPromise;
  }

  // ---------- auth ----------
  async register(nickname, email, password) {
    if (this.offline) {
      const r = this.sim.register({ nickname, email, password, password_confirmation: password });
      this.account.token = r.token;
      this.account.user_id = r.user.id;
      return r;
    }
    if (this.dryRun) {
      log('info', 'DRY-RUN register', `${nickname} <${email}>`);
      const user = { id: 900000 + Math.floor(Math.random() * 99999), nickname, email, role: 'user', locale: 'pl' };
      const r = { token: `dry-${shortId(8)}`, user };
      this.account.token = r.token;
      this.account.user_id = r.user.id;
      return r;
    }
    const data = await this.request('POST', '/auth/register', {
      body: { nickname, email, password, password_confirmation: password },
      key: 'auth',
    });
    this.account.token = data.token;
    this.account.user_id = data.user.id;
    return data;
  }

  async login(email, password) {
    if (this.offline) {
      const r = this.sim.login({ email, password });
      this.account.token = r.token;
      this.account.user_id = r.user.id;
      this.onAuthRefreshed?.(this.account);
      return r;
    }
    if (this.dryRun) {
      const user = { id: this.account.user_id ?? 900000, nickname: this.account.nickname, email, role: 'user', locale: 'pl' };
      const r = { token: `dry-${shortId(8)}`, user };
      this.account.token = r.token;
      return r;
    }
    const data = await this.request('POST', '/auth/login', { body: { email, password }, key: 'auth' });
    this.account.token = data.token;
    this.account.user_id = data.user.id;
    this.onAuthRefreshed?.(this.account);
    return data;
  }

  async logout() {
    try {
      if (this.offline) return this.sim.logout(this.account.token);
      if (this.dryRun) {
        log('info', 'DRY-RUN logout', this.account.nickname);
        return { message: 'ok' };
      }
      return await this.request('POST', '/auth/logout', { auth: true, key: 'auth' });
    } finally {
      this.account.token = null;
      this.onAuthRefreshed?.(this.account);
    }
  }

  // ---------- odczyty ----------
  async me() {
    if (this.offline) return this.sim.me(this.account.token);
    return this.request('GET', '/me', { auth: true });
  }

  async getWallet() {
    if (this.offline) return this.sim.wallet(this.account.token);
    return this.request('GET', '/me/wallet', { auth: true });
  }

  async listTournaments(status) {
    if (this.offline) return this.sim.listTournaments(status);
    return this.request('GET', '/tournaments', { query: status ? { status } : null });
  }

  async getTournament(id) {
    if (this.offline) return this.sim.getTournament(id, this.account.token);
    return this.request('GET', `/tournaments/${id}`, { auth: true });
  }

  async joinTournament(id) {
    if (this.offline) return this.sim.join(this.account.token, id);
    if (this.dryRun) {
      log('info', 'DRY-RUN join tournament', String(id));
      return { message: 'joined', player: { id: 900000 + Math.floor(Math.random() * 99999), cash_balance: '10000.00000000', status: 'active' } };
    }
    return this.request('POST', `/tournaments/${id}/join`, { auth: true, key: 'join' });
  }

  async getPortfolio(playerId) {
    if (this.offline) return this.sim.portfolio(this.account.token, playerId);
    return this.request('GET', `/portfolios/${playerId}`, { auth: true });
  }

  async getMyOrders(playerId) {
    if (this.offline) return this.sim.myOrders(this.account.token, playerId);
    return this.request('GET', `/portfolios/${playerId}/orders`, { auth: true });
  }

  async getMyTransactions(playerId) {
    if (this.offline) return this.sim.myTransactions(this.account.token, playerId);
    return this.request('GET', `/portfolios/${playerId}/transactions`, { auth: true });
  }

  async getRanking(tournamentId) {
    if (this.offline) return this.sim.ranking(tournamentId);
    return this.request('GET', `/tournaments/${tournamentId}/ranking`);
  }

  async getPrice(symbol) {
    if (this.offline) return this.sim.price(symbol);
    return this.request('GET', `/prices/${symbol}`);
  }

  async getCandles(symbol, interval, limit) {
    if (this.offline) return this.sim.candles(symbol, interval, limit);
    return this.request('GET', '/candles', { query: { symbol, interval, limit } });
  }

  // ---------- mutacje ----------
  async createOrder(playerId, order) {
    if (this.offline) return this.sim.createOrder(this.account.token, playerId, order);
    if (this.dryRun) {
      log('info', 'DRY-RUN order', JSON.stringify(order));
      const fabricated = {
        order: {
          id: 800000 + Math.floor(Math.random() * 99999),
          market_id: order.market_id,
          market_symbol: order.market_symbol ?? '?',
          type: order.type,
          side: order.side,
          qty: order.qty ?? order.amount_usd ?? null,
          price: order.price ?? null,
          status: order.type === 'market' ? 'filled' : 'pending',
          filled_price: null,
          filled_qty: null,
          position_id: order.type === 'market' ? 800000 + Math.floor(Math.random() * 99999) : null,
          created_at: new Date().toISOString(),
        },
      };
      return fabricated;
    }
    return this.request('POST', `/portfolios/${playerId}/orders`, { auth: true, body: order, key: 'orders' });
  }

  async cancelOrder(orderId) {
    if (this.offline) return this.sim.cancelOrder(this.account.token, orderId);
    if (this.dryRun) {
      log('info', 'DRY-RUN cancel order', String(orderId));
      return { order: { id: orderId, status: 'cancelled' } };
    }
    return this.request('DELETE', `/orders/${orderId}`, { auth: true, key: 'orders' });
  }

  async closePosition(playerId, positionId) {
    if (this.offline) return this.sim.closePosition(this.account.token, playerId, positionId);
    if (this.dryRun) {
      log('info', 'DRY-RUN close position', String(positionId));
      return {
        position: {
          id: positionId,
          status: 'closed',
          realized_pnl: '0.00000000',
          close_price: '0.00000000',
          unrealized_pnl: '0.00000000',
        },
      };
    }
    return this.request('POST', `/portfolios/${playerId}/positions/${positionId}/close`, { auth: true, key: 'orders' });
  }
}
