// TradeSimulator — in-memory atrapa API TradeContest.
// Używana w trybie --offline (bez sieci) oraz jako rdzeń stub-servera do testów.
// Rzuca ApiError (import z api.js) tak samo jak prawdziwy serwer.
import { ApiError } from './api.js';

const NICK_RE = /^[a-zA-Z0-9_]{3,24}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const f8 = (n) => Number(n).toFixed(8);
const round4 = (n) => Math.round(n * 1e4) / 1e4;

// Deterministyczny PRNG — ten sam seed daje tę samą ścieżkę cen.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashSeed(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export class TradeSimulator {
  constructor(options = {}) {
    this.opt = {
      symbols: ['BTCUSDT', 'ETHUSDT'],
      startPrices: { BTCUSDT: 100000, ETHUSDT: 3500 },
      isPaid: false,
      entryFee: 25,
      walletBalance: 1000,
      virtualStartCapital: 10000,
      maxLeverage: 10,
      feePercent: 0.1,
      lendingFeeDailyPercent: 0.02,
      tournamentId: 7,
      tournamentName: 'BTC Rally Sierpień',
      status: 'running', // registration_open | running | ...
      busyCount: 0, // ile pierwszych zleceń per gracz zwróci 422 "Portfolio is busy"
      ...options,
    };
    this.markets = this.opt.symbols.map((s, i) => ({
      id: i + 1,
      symbol: s.toUpperCase(),
      base: s.toUpperCase().slice(0, -4) || 'X',
      quote: 'USDT',
    }));
    this.users = new Map(); // id -> user
    this.byEmail = new Map(); // email(lower) -> id
    this.byNick = new Map(); // nick(lower) -> id
    this.tokens = new Map(); // token -> userId
    this.wallets = new Map(); // userId -> {balance, locked}
    this.players = new Map(); // userId -> player (null gdy nie dołączył)
    this.pending = []; // oczekujące zlecenia (limit/tp/sl)
    this.orders = new Map(); // orderId -> order (wszystkie)
    this.seq = { user: 1, player: 10000, order: 5000, position: 300, tx: 9000 };
    this.current = new Map(); // symbol -> {idx, price}
  }

  // ---------- ceny / świece ----------
  #step(symbol) {
    const c = this.current.get(symbol) ?? { idx: 0, price: this.opt.startPrices[symbol] ?? 1000 };
    const rnd = mulberry32(hashSeed(symbol));
    for (let i = 0; i < c.idx; i++) rnd(); // replay do bieżącego stanu (determinizm)
    const step = (rnd() - 0.5) * 0.004 * c.price; // ±0.2%
    c.price = Math.max(c.price + step, 0.01);
    c.idx++;
    this.current.set(symbol, c);
    return c.price;
  }

  price(symbol) {
    const key = String(symbol).toUpperCase();
    if (!this.opt.symbols.includes(key)) throw new ApiError(404, { message: 'unknown symbol' });
    if (!this.current.has(key)) this.current.set(key, { idx: 0, price: this.opt.startPrices[key] ?? 1000 });
    const p = this.#step(key);
    this.#fillPendingForSymbol(key);
    return { symbol: key, price: p, ts: Math.floor(Date.now() / 1000), source: 'mock' };
  }

  candles(symbol, interval = '1m', limit = 200) {
    const key = String(symbol).toUpperCase();
    const n = Math.min(Math.max(Number(limit) || 20, 1), 1000);
    const idx = this.current.get(key)?.idx ?? 0;
    const rnd = mulberry32(hashSeed(key));
    // replay pełnej ścieżki od startu — świece zawsze spójne z ceną bieżącą
    let price = this.opt.startPrices[key] ?? 1000;
    const closes = [price];
    for (let i = 0; i < idx; i++) {
      price = Math.max(price + (rnd() - 0.5) * 0.004 * price, 0.01);
      closes.push(price);
    }
    const stepSec =
      interval === '5m' ? 300
      : interval === '15m' ? 900
      : interval === '30m' ? 1800
      : interval === '1h' ? 3600
      : interval === '4h' ? 14400
      : interval === '1d' ? 86400
      : 60;
    const nowTs = Math.floor(Date.now() / 1000);
    const out = [];
    for (let i = 0; i < n; i++) {
      const k = idx - n + 1 + i;
      if (k < 0) continue;
      const open = closes[k];
      const close = closes[k + 1] ?? open;
      const spread = Math.abs(close - open) * 0.4 + open * 0.0002;
      out.push({
        ts: nowTs - (idx - k) * stepSec,
        open: round4(open),
        high: round4(Math.max(open, close) + spread),
        low: round4(Math.min(open, close) - spread),
        close: round4(close),
        volume: round4(open * 0.01 * (0.5 + rnd())),
      });
    }
    return { symbol: key, interval, source: 'mock', candles: out };
  }

  // ---------- auth ----------
  register({ nickname, email, password, password_confirmation }) {
    const errors = {};
    if (typeof nickname !== 'string' || !NICK_RE.test(nickname)) {
      errors.nickname = ['The nickname must be 3-24 chars [a-zA-Z0-9_].'];
    } else if (this.byNick.has(nickname.toLowerCase())) {
      errors.nickname = ['nickname_taken'];
    }
    if (typeof email !== 'string' || !EMAIL_RE.test(email)) {
      errors.email = ['The email must be a valid email address.'];
    } else if (this.byEmail.has(email.toLowerCase())) {
      errors.email = ['The email has already been taken.'];
    }
    if (typeof password !== 'string' || password.length < 8) {
      errors.password = ['The password must be at least 8 characters.'];
    }
    if (password !== password_confirmation) {
      errors.password_confirmation = ['The password confirmation does not match.'];
    }
    if (Object.keys(errors).length) {
      throw new ApiError(422, { message: 'The given data was invalid.', errors });
    }
    const id = this.seq.user++;
    const user = { id, nickname, email, role: 'user', locale: 'pl', password };
    this.users.set(id, user);
    this.byEmail.set(email.toLowerCase(), id);
    this.byNick.set(nickname.toLowerCase(), id);
    this.players.set(id, null);
    this.wallets.set(id, { balance: this.opt.walletBalance, locked: 0 });
    const token = `stub-${id}-${++this.seq.order}`;
    this.tokens.set(token, id);
    return { token, user: { id, nickname, email, role: 'user', locale: 'pl' } };
  }

  login({ email, password }) {
    const id = this.byEmail.get(String(email ?? '').toLowerCase());
    const user = id != null ? this.users.get(id) : null;
    if (!user || user.password !== password) throw new ApiError(422, { message: 'auth.failed' });
    const token = `stub-${id}-${++this.seq.order}`;
    this.tokens.set(token, id);
    return { token, user: { id: user.id, nickname: user.nickname, email: user.email, role: 'user', locale: 'pl' } };
  }

  logout(token) {
    this.tokens.delete(token);
    return { message: 'ok' };
  }

  me(token) {
    const user = this.#user(token);
    return { user: { id: user.id, nickname: user.nickname, email: user.email, role: 'user', locale: 'pl' }, wallet_balance: f8(this.wallets.get(user.id).balance) };
  }

  wallet(token) {
    const user = this.#user(token);
    const w = this.wallets.get(user.id);
    return { wallet: { balance: f8(w.balance), locked: f8(w.locked), currency: 'USDT' }, transactions: [] };
  }

  // ---------- turnieje ----------
  #canJoin() {
    return this.opt.status === 'registration_open' || this.opt.status === 'running';
  }

  #playerCount() {
    let n = 0;
    for (const p of this.players.values()) if (p) n++;
    return n;
  }

  #tournament() {
    return {
      id: this.opt.tournamentId,
      slug: 'sim-rally',
      name: this.opt.tournamentName,
      status: this.opt.status,
      is_paid: this.opt.isPaid,
      entry_fee: this.opt.isPaid ? f8(this.opt.entryFee) : null,
      prize_type: 'none',
      prize_amount: null,
      virtual_start_capital: f8(this.opt.virtualStartCapital),
      max_leverage: String(this.opt.maxLeverage),
      fee_percent: String(this.opt.feePercent),
      lending_fee_daily_percent: String(this.opt.lendingFeeDailyPercent),
      markets: this.markets.map((m) => ({ id: m.id, symbol: m.symbol, base: m.base, quote: m.quote })),
      start_registration_at: '2026-08-01T10:00:00+02:00',
      start_at: '2026-08-10T10:00:00+02:00',
      end_at: '2026-08-17T10:00:00+02:00',
      join_until: '2026-08-15T10:00:00+02:00',
      players_count: this.#playerCount(),
      prize_structure: { 1: '50%', 2: '30%', 3: '20%' },
      rules: { description: 'simulated tournament' },
      is_ad_supported: false,
      is_featured: false,
      can_join: this.#canJoin(),
      ads: null,
    };
  }

  listTournaments(status) {
    const t = this.#tournament();
    const list = status && t.status !== status ? [] : [t];
    return { tournaments: list };
  }

  getTournament(id, token) {
    if (Number(id) !== this.opt.tournamentId) throw new ApiError(404, { message: 'tournament not found' });
    const t = this.#tournament();
    let me = { joined: false };
    if (token) {
      const user = this.#userOrNull(token);
      if (user) {
        const p = this.players.get(user.id);
        if (p) me = { joined: true, player_id: p.id };
      }
    }
    return { tournament: t, me };
  }

  join(token, tournamentId) {
    const user = this.#user(token);
    if (Number(tournamentId) !== this.opt.tournamentId) throw new ApiError(404, { message: 'tournament not found' });
    if (this.players.get(user.id)) throw new ApiError(409, { message: 'already_joined' });
    if (!this.#canJoin()) throw new ApiError(422, { message: 'registration window closed' });
    const w = this.wallets.get(user.id);
    if (this.opt.isPaid && w.balance < this.opt.entryFee) {
      throw new ApiError(402, { message: 'Niewystarczające środki', code: 'insufficient_balance', wallet_balance: w.balance, required: this.opt.entryFee });
    }
    if (this.opt.isPaid) w.balance -= this.opt.entryFee;
    const player = {
      id: this.seq.player++,
      userId: user.id,
      tournamentId: this.opt.tournamentId,
      status: 'active',
      cash: this.opt.virtualStartCapital,
      startCapital: this.opt.virtualStartCapital,
      positions: [],
      transactions: [],
      busyLeft: this.opt.busyCount,
    };
    this.players.set(user.id, player);
    return { message: 'joined', player: { id: player.id, cash_balance: f8(player.cash), status: 'active' } };
  }

  // ---------- portfolio ----------
  #playerOf(token, playerId) {
    const user = this.#user(token);
    const player = this.players.get(user.id);
    if (!player) throw new ApiError(404, { message: 'player not found' });
    if (player.id !== Number(playerId)) throw new ApiError(403, { message: 'forbidden' });
    return player;
  }

  #symbolOf(marketId) {
    return this.markets.find((m) => m.id === marketId)?.symbol ?? null;
  }

  #positionView(p) {
    const symbol = this.#symbolOf(p.market_id);
    const price = this.current.get(symbol)?.price ?? Number(p.entry_price);
    const dir = p.side === 'long' ? 1 : -1;
    const upnl = (price - Number(p.entry_price)) * Number(p.qty) * dir;
    return {
      id: p.id,
      market_id: p.market_id,
      market_symbol: symbol,
      side: p.side,
      qty: f8(p.qty),
      entry_price: f8(p.entry_price),
      mark_price: f8(price),
      leverage: String(p.leverage),
      liquidation_price: f8(p.side === 'long' ? Number(p.entry_price) * (1 - 1 / p.leverage) : Number(p.entry_price) * (1 + 1 / p.leverage)),
      unrealized_pnl: f8(upnl),
      margin_used: f8((Number(p.qty) * Number(p.entry_price)) / p.leverage),
      status: p.status,
      realized_pnl: p.status === 'open' ? null : f8(p.realized_pnl ?? 0),
      close_price: p.close_price != null ? f8(p.close_price) : null,
    };
  }

  portfolio(token, playerId) {
    const player = this.#playerOf(token, playerId);
    const positions = player.positions.filter((p) => p.status === 'open').map((p) => this.#positionView(p));
    let unrealized = 0;
    for (const pv of positions) unrealized += Number(pv.unrealized_pnl);
    return {
      player: {
        id: player.id,
        tournament_id: player.tournamentId,
        status: player.status,
        cash_balance: f8(player.cash),
        start_capital: f8(player.startCapital),
        equity: f8(player.cash + unrealized),
        unrealized_pnl: f8(unrealized),
      },
      positions,
      computed_at: new Date().toISOString(),
    };
  }

  myOrders(token, playerId) {
    const player = this.#playerOf(token, playerId);
    const list = [];
    for (const o of this.orders.values()) if (o.player_id === player.id) list.push(o);
    return { orders: list.reverse() };
  }

  myTransactions(token, playerId) {
    const player = this.#playerOf(token, playerId);
    return { transactions: [...player.transactions].reverse() };
  }

  ranking(tournamentId) {
    const entries = [];
    for (const [userId, player] of this.players) {
      if (!player) continue;
      const port = this.portfolioByUser(userId);
      entries.push({ userId, nickname: this.users.get(userId).nickname, equity: port.equity });
    }
    entries.sort((a, b) => b.equity - a.equity);
    return {
      tournament_id: Number(tournamentId),
      computed_at: new Date().toISOString(),
      ranking: entries.map((e, i) => ({ rank: i + 1, player_id: e.userId, nickname: e.nickname, equity: f8(e.equity) })),
    };
  }

  portfolioByUser(userId) {
    const player = this.players.get(userId);
    if (!player) return { equity: 0 };
    let unrealized = 0;
    for (const p of player.positions) {
      if (p.status !== 'open') continue;
      const symbol = this.#symbolOf(p.market_id);
      const price = this.current.get(symbol)?.price ?? Number(p.entry_price);
      const dir = p.side === 'long' ? 1 : -1;
      unrealized += (price - Number(p.entry_price)) * Number(p.qty) * dir;
    }
    return { equity: player.cash + unrealized };
  }

  // ---------- zlecenia ----------
  createOrder(token, playerId, body) {
    const player = this.#playerOf(token, playerId);
    if (player.busyLeft > 0) {
      player.busyLeft--;
      throw new ApiError(422, { message: 'Portfolio is busy, try again.' });
    }
    const market = this.markets.find((m) => m.id === Number(body.market_id));
    if (!market) throw new ApiError(422, { message: 'market not available in tournament' });
    const side = body.side;
    if (side !== 'long' && side !== 'short') throw new ApiError(422, { message: 'side must be long or short' });
    const price = this.price(market.symbol).price;
    const leverage = Math.max(1, Math.min(Math.round(Number(body.leverage) || 1), this.opt.maxLeverage));
    const base = {
      id: ++this.seq.order,
      player_id: player.id,
      market_id: market.id,
      market_symbol: market.symbol,
      side,
      created_at: new Date().toISOString(),
    };

    if (body.type === 'limit') {
      const limitPrice = Number(body.price);
      if (!(limitPrice > 0)) throw new ApiError(422, { message: 'price is required for limit orders' });
      const qty = body.qty != null && body.qty !== '' ? Number(body.qty) : (Number(body.amount_usd) || 0) / price;
      if (!(qty > 0)) throw new ApiError(422, { message: 'qty or amount_usd is required' });
      const order = { ...base, qty: f8(qty), type: 'limit', price: limitPrice, status: 'pending', filled_price: null, filled_qty: null, position_id: null, leverage };
      this.pending.push({ ...order, userId: player.userId, playerId: player.id });
      this.orders.set(order.id, order);
      return { order };
    }

    if (body.type === 'tp' || body.type === 'sl') {
      const pos = player.positions.find((p) => p.id === Number(body.position_id) && p.status === 'open');
      if (!pos) throw new ApiError(422, { message: 'open position not found' });
      const stopPrice = Number(body.price);
      if (!(stopPrice > 0)) throw new ApiError(422, { message: 'price is required' });
      // qty opcjonalne dla tp/sl — domyślnie cała pozycja (API.md §4.1)
      const qty = body.qty != null && body.qty !== '' ? Number(body.qty) : Number(pos.qty);
      if (!(qty > 0) || qty > Number(pos.qty)) throw new ApiError(422, { message: 'qty exceeds position size' });
      const dir = pos.side === 'long' ? 1 : -1;
      const better = dir * (stopPrice - Number(pos.entry_price));
      if (body.type === 'tp' && better <= 0) throw new ApiError(422, { message: 'invalid take profit price' });
      if (body.type === 'sl' && better >= 0) throw new ApiError(422, { message: 'invalid stop loss price' });
      const order = { ...base, qty: f8(qty), type: body.type, price: stopPrice, status: 'pending', filled_price: null, filled_qty: null, position_id: pos.id, leverage };
      this.pending.push({ ...order, userId: player.userId, playerId: player.id, pos });
      this.orders.set(order.id, order);
      return { order };
    }

    // market
    const qty = body.qty != null && body.qty !== '' ? Number(body.qty) : (Number(body.amount_usd) || 0) / price;
    if (!(qty > 0)) throw new ApiError(422, { message: 'qty or amount_usd is required' });
    const notional = qty * price;
    const margin = notional / leverage;
    const fee = (notional * this.opt.feePercent) / 100;
    if (player.cash < margin + fee) {
      throw new ApiError(422, { message: 'Niewystarczające środki', need: margin + fee, available: player.cash });
    }
    player.cash -= margin + fee;
    const pos = {
      id: ++this.seq.position,
      playerId: player.id,
      market_id: market.id,
      side,
      qty,
      entry_price: price,
      leverage,
      status: 'open',
      realized_pnl: 0,
      close_price: null,
      opened_at: new Date().toISOString(),
    };
    player.positions.push(pos);
    player.transactions.push({
      id: ++this.seq.tx,
      playerId: player.id,
      position_id: pos.id,
      tournament_id: this.opt.tournamentId,
      tournament_name: this.opt.tournamentName,
      market_symbol: `${market.base}/${market.quote}`,
      type: 'open',
      side,
      qty: f8(qty),
      price: f8(price),
      fee: f8(fee),
      lending_fee: '0.00000000',
      pnl_realized: null,
      public_at: null,
      created_at: new Date().toISOString(),
    });
    const order = { ...base, qty: f8(qty), type: 'market', price: null, status: 'filled', filled_price: f8(price), filled_qty: f8(qty), position_id: pos.id, leverage };
    this.orders.set(order.id, order);
    return { order };
  }

  cancelOrder(token, orderId) {
    this.#user(token);
    const order = this.orders.get(Number(orderId));
    if (!order) throw new ApiError(404, { message: 'order not found' });
    if (order.status !== 'pending') throw new ApiError(422, { message: 'only pending orders can be cancelled' });
    order.status = 'cancelled';
    this.pending = this.pending.filter((p) => p.id !== order.id);
    return order;
  }

  closePosition(token, playerId, positionId) {
    const player = this.#playerOf(token, playerId);
    const pos = player.positions.find((p) => p.id === Number(positionId) && p.status === 'open');
    if (!pos) throw new ApiError(404, { message: 'position not found' });
    const price = this.price(this.#symbolOf(pos.market_id)).price;
    const closed = this.#closePositionInternal(player, pos, price);
    return { position: this.#positionView(closed) };
  }

  // ---------- silnik wypełnień ----------
  #fillPendingForSymbol(symbol) {
    const price = this.current.get(symbol)?.price;
    if (price == null) return;
    const triggered = [];
    for (const pend of this.pending) {
      const m = this.markets.find((x) => x.id === pend.market_id);
      if (m?.symbol !== symbol) continue;
      const hit =
        pend.type === 'limit'
          ? (pend.side === 'long' ? price <= pend.price : price >= pend.price)
          : pend.type === 'tp'
            ? (pend.side === 'long' ? price >= pend.price : price <= pend.price)
            : (pend.side === 'long' ? price <= pend.price : price >= pend.price);
      if (hit) triggered.push(pend);
    }
    for (const pend of triggered) {
      this.pending = this.pending.filter((x) => x !== pend);
      const order = this.orders.get(pend.id);
      order.status = 'filled';
      order.filled_price = f8(price);
      order.filled_qty = f8(pend.qty);
      const player = this.players.get(pend.userId);
      if (pend.type === 'limit') {
        this.#openPositionInternal(player, pend.market_id, pend.side, Number(pend.qty), pend.leverage ?? 1, price);
      } else if (pend.pos) {
        this.#closePositionInternal(player, pend.pos, price);
      }
    }
  }

  #openPositionInternal(player, marketId, side, qty, leverage, price) {
    const market = this.markets.find((m) => m.id === marketId);
    const notional = qty * price;
    const margin = notional / leverage;
    const fee = (notional * this.opt.feePercent) / 100;
    if (player.cash < margin + fee) return null;
    player.cash -= margin + fee;
    const pos = {
      id: ++this.seq.position,
      playerId: player.id,
      market_id: marketId,
      side,
      qty,
      entry_price: price,
      leverage,
      status: 'open',
      realized_pnl: 0,
      close_price: null,
      opened_at: new Date().toISOString(),
    };
    player.positions.push(pos);
    player.transactions.push({
      id: ++this.seq.tx,
      playerId: player.id,
      position_id: pos.id,
      tournament_id: this.opt.tournamentId,
      tournament_name: this.opt.tournamentName,
      market_symbol: `${market.base}/${market.quote}`,
      type: 'open',
      side,
      qty: f8(qty),
      price: f8(price),
      fee: f8(fee),
      lending_fee: '0.00000000',
      pnl_realized: null,
      public_at: null,
      created_at: new Date().toISOString(),
    });
    return pos;
  }

  #closePositionInternal(player, pos, price) {
    const dir = pos.side === 'long' ? 1 : -1;
    const gross = (price - Number(pos.entry_price)) * Number(pos.qty) * dir;
    const notional = Number(pos.qty) * price;
    const fee = (notional * this.opt.feePercent) / 100;
    const pnl = gross - fee;
    pos.status = 'closed';
    pos.close_price = price;
    pos.realized_pnl = pnl;
    player.cash += (Number(pos.qty) * Number(pos.entry_price)) / pos.leverage + pnl;
    player.transactions.push({
      id: ++this.seq.tx,
      playerId: player.id,
      position_id: pos.id,
      tournament_id: this.opt.tournamentId,
      tournament_name: this.opt.tournamentName,
      market_symbol: `${this.#symbolOf(pos.market_id)?.replace('USDT', '') ?? '?'}/USDT`,
      type: 'close',
      side: pos.side,
      qty: f8(pos.qty),
      price: f8(price),
      fee: f8(fee),
      lending_fee: '0.00000000',
      pnl_realized: f8(pnl),
      public_at: new Date().toISOString(),
      created_at: new Date().toISOString(),
    });
    // anuluj nieaktywne już tp/sl pozycji
    this.pending = this.pending.filter((x) => x.pos !== pos);
    return pos;
  }

  // ---------- pomocnicze ----------
  #user(token) {
    const id = this.tokens.get(token);
    const user = id != null ? this.users.get(id) : null;
    if (!user) throw new ApiError(401, { message: 'unauthorized' });
    return user;
  }

  #userOrNull(token) {
    const id = this.tokens.get(token);
    return id != null ? this.users.get(id) : null;
  }
}
