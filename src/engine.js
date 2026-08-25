// engine.js — pętla handlowa jednego bota.
// tick(): join assurance (do maxTournamentsPerBot turniejów) -> per turniej:
// status -> portfolio/dane -> decyzja AI -> egzekucja -> snapshot. Obsługa:
// lock "Portfolio is busy" (retry 1s), 429/401 (w api.js), weta bezpieczeństwa
// (w prompts.js), error recovery z backoffem.
import { ApiError, AlreadyJoined, InsufficientFunds } from './api.js';
import { buildSystemPrompt, buildUserPrompt, validateDecision } from './prompts.js';
import { now, randBetween, seededRandom, shortId, shuffle, sleep, toNumber } from './util.js';

export class BotEngine {
  constructor({ account, api, llm, store, cfg, botId }) {
    this.account = account;
    this.api = api;
    this.llm = llm;
    this.store = store;
    this.cfg = cfg;
    this.botId = botId ?? account.id;
  }

  log(level, msg) {
    this.store.addLogEntry(this.botId, level, msg);
  }

  getState() {
    return this.store.getBotState(this.botId);
  }

  // Historia dołączonych turniejów (dla dashboardu) — deduplikacja po id.
  recordJoin(state, t) {
    const list = state.joinedTournaments ??= [];
    const existing = list.find((x) => x.id === t.id);
    if (existing) { existing.status = t.status; return; }
    list.push({ id: t.id, name: t.name, status: t.status, joined_at: now() });
  }

  // Konto może grać w wielu turniejach: players = { [tournamentId]: player_id }.
  // Migracja ze starych pól player_id/tournament_id (pierwszy turniej).
  ensureAccountPlayers(account) {
    if (!account.players && account.player_id && account.tournament_id) {
      account.players = { [account.tournament_id]: account.player_id };
    }
    account.players ??= {};
  }

  // Stan per turniej: state.tournaments = { [tid]: {...} } — migracja ze
  // starych pojedynczych pól (state.tournament/portfolio/positions/...).
  ensureStateShape(state) {
    if (!state.tournaments && state.tournament?.id) {
      state.tournaments = {
        [state.tournament.id]: {
          ...state.tournament,
          portfolio: state.portfolio ?? null,
          positions: state.positions ?? [],
          pending_orders: state.pending_orders ?? [],
          rank: state.rank ?? null,
          players_count: state.players_count ?? null,
          last_decision: state.last_decision ?? null,
          trading_plan: state.trading_plan ?? null,
        },
      };
    }
    state.tournaments ??= {};
  }

  // Dołączanie do turniejów aż do maxTournamentsPerBot: discovery
  // (forceId | preferStatus | fallbackStatus | can_join), gate opłaty
  // wpisowej, join z obsługą AlreadyJoined (player_id z /tournaments/{id}),
  // InsufficientFunds i 422 (okno zamknięte -> pomiń turniej).
  async joinMore(state) {
    const account = this.account;
    this.ensureAccountPlayers(account);
    const max = this.cfg.account.maxTournamentsPerBot ?? 1;
    if (Object.keys(account.players).length >= max) return;

    // Przy czekaniu ponawiamy rzadziej (co fundingCheckTicks), żeby nie
    // spamować serwera odrzuconymi joinami.
    if (state.status === 'waiting' || state.status === 'needs_funding') {
      state.funding_counter = (state.funding_counter ?? 0) + 1;
      if (state.funding_counter % this.cfg.trading.fundingCheckTicks !== 0) return;
    }

    const list = await this.api.listTournaments();
    const ts = list?.tournaments ?? [];
    const joined = new Set(Object.keys(account.players).map(Number));
    const prefer = this.cfg.tournament.preferStatus;
    const fallback = this.cfg.tournament.fallbackStatus;
    const forced = this.cfg.tournament.forceId;
    // can_join bywa false mimo otwartych zapisów (aplikacja turniejowa) —
    // kandydat = status zgodny z preferencją LUB can_join; ostateczną prawdę
    // mówi endpoint join (422 = pomijamy turniej na 30 min).
    const candidates = ts.filter((t) => {
      if (joined.has(Number(t.id))) return false;
      if (forced && Number(t.id) !== Number(forced)) return false;
      const rejected = state.rejected_joins?.[t.id];
      if (rejected && Date.now() - rejected < 1800000) return false;
      return t.can_join || t.status === prefer || t.status === fallback;
    });
    const ordered = [
      ...candidates.filter((t) => t.status === prefer),
      ...candidates.filter((t) => t.status === fallback),
      ...candidates,
    ];

    for (const tournament of ordered) {
      if (Object.keys(account.players).length >= max) break;

      if (tournament.is_paid) {
        const fee = toNumber(tournament.entry_fee);
        if (fee > this.cfg.tournament.maxEntryFeeUsd) {
          this.log('warn', `entry fee ${fee} > max allowed ${this.cfg.tournament.maxEntryFeeUsd}, skipping`);
          continue;
        }
        const wallet = await this.api.getWallet();
        const balance = toNumber(wallet?.wallet?.balance);
        if (balance < fee) {
          this.log('warn', `needs funding: wallet ${balance} USDT, entry fee ${fee} USDT`);
          state.status = 'needs_funding';
          continue;
        }
      }

      try {
        const res = await this.api.joinTournament(tournament.id);
        account.players[tournament.id] = res.player.id;
        this.store.upsertAccount(account);
        state.status = 'running';
        this.log('info', `joined tournament #${tournament.id} as player ${res.player.id}`);
        this.recordJoin(state, tournament);
      } catch (e) {
        if (e instanceof AlreadyJoined) {
          const t = await this.api.getTournament(tournament.id);
          const pid = t?.me?.player_id;
          if (pid) {
            account.players[tournament.id] = pid;
            this.store.upsertAccount(account);
            state.status = 'running';
            this.log('info', `already joined as player ${pid}`);
            this.recordJoin(state, tournament);
          }
        } else if (e instanceof InsufficientFunds) {
          this.log('warn', 'insufficient wallet funds to join');
          state.status = 'needs_funding';
          continue;
        } else if (e instanceof ApiError && e.status === 422) {
          // okno zapisów zamknięte / nie można teraz dołączyć — pomijamy
          // ten turniej na 30 min (żeby nie spamować odrzuconymi joinami)
          state.rejected_joins ??= {};
          state.rejected_joins[tournament.id] = Date.now();
          this.log('info', `join rejected (${e.message}), skipping for 30 min`);
          continue;
        } else {
          throw e;
        }
      }
    }

    if (!Object.keys(account.players).length && state.status !== 'needs_funding') {
      this.log('info', 'no joinable tournament, waiting');
      state.status = 'waiting';
    }
  }

  // Jedna iteracja pętli handlowej: dołączanie + cykl per turniej.
  async tick() {
    const account = this.account;
    const state = this.getState();
    this.ensureAccountPlayers(account);
    this.ensureStateShape(state);

    await this.joinMore(state);
    if (!Object.keys(account.players).length) return;

    let anyRunning = false;
    let anyFunding = false;
    let anyError = false;
    let anyWaiting = false;
    for (const [tidStr, playerId] of Object.entries(account.players)) {
      const tid = Number(tidStr);
      const tstate = state.tournaments[tid] ??= { id: tid, status: 'new' };
      let st;
      try {
        st = await this.#tickTournament(tid, playerId, tstate);
      } catch (e) {
        this.log('error', `tournament #${tid} tick failed: ${e.message}`);
        st = { status: 'error', last_error: e.message };
      }
      tstate.last_error = st.last_error ?? null;
      if (st.status === 'running') anyRunning = true;
      else if (st.status === 'needs_funding') anyFunding = true;
      else if (st.status === 'error') anyError = true;
      else anyWaiting = true;
    }

    // Status zagregowany bota (dla dashboardu i sterowania)
    state.status = anyRunning ? 'running' : anyFunding ? 'needs_funding' : anyError ? 'error' : anyWaiting ? 'waiting' : state.status;
    state.last_tick = now();
  }

  // Cykl handlowy jednego turnieju (jeden z maxTournamentsPerBot bota).
  async #tickTournament(tid, playerId, tstate) {
    const account = this.account;
    const state = this.getState();

    // 1. Status turnieju (odświeżany co tick — bot musi wykryć start)
    let tournament = tstate;
    try {
      const fresh = (await this.api.getTournament(tid))?.tournament ?? null;
      if (fresh) {
        tournament = {
          id: fresh.id,
          name: fresh.name,
          status: fresh.status,
          is_paid: !!fresh.is_paid,
          entry_fee: fresh.entry_fee,
          max_leverage: fresh.max_leverage,
          fee_percent: fresh.fee_percent,
          lending_fee_daily_percent: fresh.lending_fee_daily_percent,
          markets: fresh.markets ?? [],
        };
        Object.assign(tstate, tournament);
        // żywy status w historii dołączonych turniejów
        const hist = state.joinedTournaments ??= [];
        const h = hist.find((x) => x.id === tid);
        if (h) h.status = tournament.status;
      }
    } catch (e) {
      this.log('warn', `tournament ${tid} refresh failed: ${e.message}`);
    }
    if (!tournament.id) {
      this.log('warn', `tournament ${tid} not found`);
      return { status: 'error', last_error: `tournament ${tid} not found` };
    }
    if (tournament.status !== 'running') {
      if (tstate.status !== 'waiting') this.log('info', `tournament #${tid} ${tournament.status}, waiting for running`);
      return { status: 'waiting' };
    }
    if (tstate.status !== 'running') this.log('info', `tournament #${tid} is running`);
    tstate.status = 'running';

    const markets = tournament.markets ?? [];
    if (!markets.length) {
      this.log('warn', `tournament #${tid} has no markets`);
      return { status: 'waiting' };
    }

    // 2. Plan handlowy per turniej: rynki ZALEŻĄ OD TURNIEJU — losowy subset
    // z (config.symbols ∩ rynki turnieju), budżet = maxPositionAmountUsd * los(0.3..1).
    let plan = tstate.trading_plan;
    if (!plan || plan.tournament_id !== tid) {
      const pool = (this.cfg.trading.symbols.length ? this.cfg.trading.symbols : markets.map((m) => m.symbol))
        .filter((s) => markets.some((m) => m.symbol === s));
      const candidates = pool.length ? pool : markets.map((m) => m.symbol);
      const n = Math.max(1, Math.min(this.cfg.trading.symbolsPerBot ?? 1, candidates.length));
      const minFrac = this.cfg.trading.budgetMinFraction ?? 0.3;
      const frac = minFrac + Math.random() * (1 - minFrac);
      plan = {
        tournament_id: tid,
        symbols: shuffle(candidates).slice(0, n),
        maxPositionAmountUsd: Math.max(50, Math.round(this.cfg.trading.maxPositionAmountUsd * frac)),
      };
      tstate.trading_plan = plan;
      this.log('info', `tournament #${tid} plan: ${plan.symbols.join(', ')}, budżet do ${plan.maxPositionAmountUsd} USDT`);
    }
    const symbols = plan.symbols;

    // 3. Portfolio + transakcje (realized PnL z ledgera)
    const port = await this.api.getPortfolio(playerId);
    const tx = await this.api.getMyTransactions(playerId);
    const realized = (tx?.transactions ?? [])
      .filter((t) => t.type === 'close')
      .reduce((s, t) => s + toNumber(t.pnl_realized), 0);
    const portfolio = {
      equity: port?.player?.equity ?? null,
      cash_balance: port?.player?.cash_balance ?? null,
      unrealized_pnl: port?.player?.unrealized_pnl ?? null,
      realized_pnl: realized.toFixed(8),
    };
    tstate.portfolio = portfolio;
    tstate.positions = port?.positions ?? [];

    const myOrders = await this.api.getMyOrders(playerId);
    tstate.pending_orders = (myOrders?.orders ?? [])
      .filter((o) => o.status === 'pending')
      .map((o) => ({ id: o.id, type: o.type, side: o.side, market_id: o.market_id, position_id: o.position_id, price: o.price, qty: o.qty }));

    // 3b. Gwarancja TP/SL (requireTpSl): każda otwarta pozycja musi mieć tp i sl.
    // AI może pominąć poziomy przy otwarciu — doganiamy je tu z bieżącej ceny
    // (dotyczy też pozycji otwartych przed włączeniem tej opcji).
    if (this.cfg.trading.requireTpSl) {
      const haveStops = new Map(); // position_id -> Set(type)
      for (const o of tstate.pending_orders) {
        if ((o.type === 'tp' || o.type === 'sl') && o.position_id != null) {
          const s = haveStops.get(o.position_id) ?? new Set();
          s.add(o.type);
          haveStops.set(o.position_id, s);
        }
      }
      for (const pos of tstate.positions) {
        const have = haveStops.get(pos.id);
        const need = [];
        if (!have?.has('tp')) need.push('tp');
        if (!have?.has('sl')) need.push('sl');
        if (!need.length) continue;
        const price = toNumber(pos.mark_price) || toNumber(pos.entry_price);
        if (!price) continue;
        const dir = pos.side === 'long' ? 1 : -1;
        const tpP = toNumber(this.cfg.trading.autoTpPercent ?? 2) / 100;
        const slP = toNumber(this.cfg.trading.autoSlPercent ?? 1.5) / 100;
        for (const type of need) {
          const mult = type === 'tp' ? 1 + tpP * dir : 1 - slP * dir;
          try {
            await this.withBusyRetry(() =>
              this.api.createOrder(playerId, { market_id: pos.market_id, side: pos.side, type, price: price * mult, position_id: pos.id }),
            );
            this.log('info', `auto-${type} ${(price * mult).toFixed(2)} set for pos ${pos.id}`);
          } catch (e) {
            this.log('warn', `auto-${type} failed for pos ${pos.id}: ${e.message}`);
          }
        }
      }
    }

    // 4. Dane rynkowe
    const prices = {};
    const candlesBySymbol = {};
    for (const sym of symbols) {
      try {
        const p = await this.api.getPrice(sym);
        prices[sym] = toNumber(p?.price);
      } catch (e) {
        this.log('warn', `no price for ${sym}: ${e.message}`);
      }
      try {
        candlesBySymbol[sym] = (await this.api.getCandles(sym, this.cfg.trading.candlesInterval, this.cfg.trading.candlesLimit))?.candles ?? [];
      } catch (e) {
        this.log('warn', `no candles for ${sym}: ${e.message}`);
      }
    }
    if (!Object.keys(prices).length) {
      this.log('warn', `no prices available for tournament #${tid}, skipping tick`);
      return { status: 'waiting' };
    }

    // 5. Ranking (player_id w rankingu to userId!)
    try {
      const rank = await this.api.getRanking(tid);
      const entry = (rank?.ranking ?? []).find((r) => r.player_id === account.user_id);
      tstate.rank = entry?.rank ?? null;
      tstate.players_count = (rank?.ranking ?? []).length || null;
    } catch (e) {
      this.log('warn', `ranking failed: ${e.message}`);
    }

    // 6. Decyzja AI + walidacja (AI widzi TYLKO rynki z planu bota,
    // a budżet walidacji = budżet bota). Ustawienia z dashboardu:
    //   - aiInstruction: instrukcja operatora doklejana do promptu systemowego,
    //   - aiAskIntervalMin: cooldown — bot pyta AI najwyżej co X minut.
    // Efektywne = własne bota (state.bots[id].ai_settings) z fallbackiem do
    // globalnych (state.meta.settings). nextAiAt resetowany przy zmianie
    // własnych ustawień, więc nowe wartości obowiązują od razu.
    const settings = this.store.getBotAiSettings(state.id);
    const instruction = settings.aiInstruction ?? '';
    const askIntervalMin = settings.aiAskIntervalMin ?? 0;
    const nowMs = Date.now();
    if (askIntervalMin > 0 && state.nextAiAt && nowMs < state.nextAiAt) {
      tstate.last_decision = { action: 'hold', at: now(), cooldown: true };
      return { status: 'running', last_error: null };
    }
    const effTrading = { ...this.cfg.trading, maxPositionAmountUsd: plan.maxPositionAmountUsd };
    const ctx = {
      markets: markets.filter((m) => symbols.includes(m.symbol)),
      positions: tstate.positions,
      pendingOrders: tstate.pending_orders,
      portfolio,
      prices,
      tournament,
      cfg: effTrading,
    };
    const system = instruction
      ? `${buildSystemPrompt(tournament, { ...this.cfg, trading: effTrading })}\n\nOPERATOR INSTRUCTIONS:\n${instruction}`
      : buildSystemPrompt(tournament, { ...this.cfg, trading: effTrading });
    const user = buildUserPrompt({
      tournament,
      portfolio,
      positions: tstate.positions,
      pendingOrders: tstate.pending_orders,
      candlesBySymbol,
      prices,
      rank: tstate.rank,
      playersCount: tstate.players_count,
    });
    const llmRes = await this.llm.decide({ system, user, ctx });
    const v = validateDecision(llmRes.decision, ctx);
    tstate.last_decision = {
      action: v.decision.action,
      ...(v.error ? { error: v.error } : {}),
      raw: typeof llmRes.raw === 'string' ? llmRes.raw.slice(0, 400) : null,
      at: now(),
    };

    // Podgląd wymian AI (dashboard): pełny prompt + surowa odpowiedź,
    // ostatnie 10 per bot; licznik zapytań per bot (monotoniczny).
    state.ai_requests = (state.ai_requests ?? 0) + 1;
    const exchanges = state.ai_exchanges ??= [];
    exchanges.push({
      at: now(),
      tournament_id: tid,
      tournament_name: tournament.name ?? null,
      system,
      user,
      response: typeof llmRes.raw === 'string' ? llmRes.raw : null,
    });
    if (exchanges.length > 10) exchanges.splice(0, exchanges.length - 10);
    // Każda decyzja AI ląduje w logu (także hold) — bez tego nie widać, że bot
    // pytał AI i co odpowiedziało.
    this.log('info', `tournament #${tid} AI decision: ${JSON.stringify(v.decision)}${v.error ? ` (invalid: ${v.error})` : ''}`);
    if (askIntervalMin > 0) state.nextAiAt = nowMs + askIntervalMin * 60000;

    // 7. Egzekucja. Gwarancja TP/SL przy otwieraniu: jeśli AI pominęło poziomy,
    // uzupełniamy je z bieżącej ceny ZANIM złożymy zlecenie open.
    if (v.decision.action === 'open' && this.cfg.trading.requireTpSl) {
      const price = ctx.prices[v.decision.market_symbol];
      if (price && price > 0) {
        const dir = v.decision.side === 'long' ? 1 : -1;
        const tpP = toNumber(this.cfg.trading.autoTpPercent ?? 2) / 100;
        const slP = toNumber(this.cfg.trading.autoSlPercent ?? 1.5) / 100;
        if (v.decision.tp_price == null) v.decision.tp_price = Math.round(price * (1 + tpP * dir) * 100) / 100;
        if (v.decision.sl_price == null) v.decision.sl_price = Math.round(price * (1 - slP * dir) * 100) / 100;
        this.log('info', `auto-tp/sl dla otwarcia: tp ${v.decision.tp_price}, sl ${v.decision.sl_price}`);
      }
    }
    if (v.decision.action !== 'hold') {
      await this.executeDecision(v.decision, ctx, playerId);
    }

    return { status: 'running', last_error: null };
  }

  async executeDecision(decision, ctx, playerId) {
    try {
      if (decision.action === 'open') {
        const market = ctx.markets.find((m) => m.symbol === decision.market_symbol);
        if (!market) {
          this.log('warn', `open: market ${decision.market_symbol} unknown`);
          return;
        }
        const res = await this.withBusyRetry(() =>
          this.api.createOrder(playerId, {
            market_id: market.id,
            side: decision.side,
            type: 'market',
            amount_usd: decision.amount_usd,
            leverage: decision.leverage,
          }),
        );
        const positionId = res?.order?.position_id;
        this.log('info', `opened ${decision.side} ${decision.market_symbol} ${decision.amount_usd} USDT x${decision.leverage} -> pos ${positionId ?? '?'}`);
        if (positionId && (decision.tp_price != null || decision.sl_price != null)) {
          const stops = [];
          if (decision.tp_price != null) stops.push({ type: 'tp', price: decision.tp_price });
          if (decision.sl_price != null) stops.push({ type: 'sl', price: decision.sl_price });
          for (const s of stops) {
            try {
              await this.withBusyRetry(() =>
                this.api.createOrder(playerId, {
                  market_id: market.id,
                  side: decision.side,
                  type: s.type,
                  price: s.price,
                  position_id: positionId,
                }),
              );
              this.log('info', `${s.type} ${s.price} set for pos ${positionId}`);
            } catch (e) {
              this.log('warn', `${s.type} failed: ${e.message}`);
            }
          }
        }
      } else if (decision.action === 'close') {
        const res = await this.withBusyRetry(() => this.api.closePosition(playerId, decision.position_id));
        this.log('info', `closed pos ${decision.position_id}, realized pnl ${res?.position?.realized_pnl}`);
      } else if (decision.action === 'set_tp_sl') {
        const pos = ctx.positions.find((p) => p.id === decision.position_id);
        const market = pos && ctx.markets.find((m) => m.id === pos.market_id);
        if (!market) {
          this.log('warn', `set_tp_sl: position ${decision.position_id} market unknown`);
          return;
        }
        const orders = (await this.api.getMyOrders(playerId))?.orders ?? [];
        for (const o of orders) {
          if (o.status === 'pending' && o.position_id === decision.position_id && (o.type === 'tp' || o.type === 'sl')) {
            try {
              await this.withBusyRetry(() => this.api.cancelOrder(o.id));
              this.log('info', `cancelled old ${o.type} #${o.id}`);
            } catch (e) {
              this.log('warn', `cancel #${o.id} failed: ${e.message}`);
            }
          }
        }
        const stops = [];
        if (decision.tp_price != null) stops.push({ type: 'tp', price: decision.tp_price });
        if (decision.sl_price != null) stops.push({ type: 'sl', price: decision.sl_price });
        for (const s of stops) {
          try {
            await this.withBusyRetry(() =>
              this.api.createOrder(playerId, {
                market_id: market.id,
                side: pos.side,
                type: s.type,
                price: s.price,
                position_id: decision.position_id,
              }),
            );
            this.log('info', `${s.type} ${s.price} set for pos ${decision.position_id}`);
          } catch (e) {
            this.log('warn', `${s.type} failed: ${e.message}`);
          }
        }
      }
    } catch (e) {
      if (e instanceof ApiError && e.status === 422 && /insufficient/i.test(e.message)) {
        this.log('warn', `trade rejected: ${e.message}`);
        return;
      }
      if (e instanceof ApiError && e.status === 403) {
        this.log('error', '403: wrong player_id? check account');
        return;
      }
      throw e;
    }
  }

  // Lock antirace: "Portfolio is busy, try again." -> sleep 1s i ponów.
  async withBusyRetry(fn) {
    for (let i = 0; i < this.cfg.trading.portfolioBusyRetries; i++) {
      try {
        return await fn();
      } catch (e) {
        if (e instanceof ApiError && e.status === 422 && /busy/i.test(e.message)) {
          if (i > 0) this.log('debug', `portfolio busy, retry ${i}`);
          await sleep(1000);
          continue;
        }
        throw e;
      }
    }
    throw new ApiError(422, { message: 'Portfolio is busy, try again.' });
  }
}

// Async runner: pętla tick -> sleep(interval). Abort (pause/delete) kończy
// natychmiast (sleep jest przerywalny). Po maxTickFailures -> status error
// i backoff 2^k*5s (max 5 min); sukces resetuje licznik.
export async function runBotLoop(botId, deps, controller) {
  const { account, api, llm, store, cfg } = deps;
  const engine = new BotEngine({ account, api, llm, store, cfg, botId });
  const signal = controller.signal;
  let failures = 0;

  // Kamuflaż aktywności: własne tempo ticków + jitter (max odstęp < 120 s —
  // próg "offline" w aplikacji), a czasem krótka przerwa offline 1-10 min
  // (zero zapytań), żeby na aplikacji nie wisiała zawsze ta sama grupa online.
  // Seed = id bota + LOSOWY składnik: sam botId odtwarzałby po każdym
  // restarcie kontenera identyczną sekwencję (te same przerwy w tych samych
  // momentach = maszynowy wzorzec).
  const rng = seededRandom(botId + ':' + shortId(8));
  const base = Math.round(cfg.trading.intervalMs * (0.7 + 0.6 * rng()));
  const jitter = cfg.trading.tickJitterFraction ?? 0;
  const idleChance = cfg.trading.idleChancePerTick ?? 0;
  const idleMin = cfg.trading.idleMinMs ?? 0;
  const idleMax = cfg.trading.idleMaxMs ?? 0;

  while (!signal.aborted) {
    try {
      await engine.tick();
      failures = 0;
      const s = store.getBotState(botId);
      if (s.status === 'error') {
        s.status = 'running';
        s.last_error = null;
        store.addLogEntry(botId, 'info', 'recovered');
      }
    } catch (e) {
      if (e.code === 'ABORTED') break;
      failures++;
      const s = store.getBotState(botId);
      s.last_error = e.message;
      store.addLogEntry(botId, 'error', `tick failed: ${e.message}`);
      if (failures >= cfg.trading.maxTickFailures) {
        s.status = 'error';
        const delay = Math.min(5000 * 2 ** Math.max(0, failures - cfg.trading.maxTickFailures), 300000);
        store.addLogEntry(botId, 'warn', `too many failures, backoff ${Math.round(delay / 1000)}s`);
        await sleep(delay, signal);
        continue;
      }
    }
    // Odstęp z jitterem (losowy, per tick)
    const j = 1 + (rng() * 2 - 1) * jitter;
    await sleep(Math.max(5000, Math.round(base * j)), signal);
    // Czasem krótka przerwa offline — bot "znika" na 1-10 min (żadnych zapytań API)
    if (idleChance > 0 && idleMax > idleMin && rng() < idleChance) {
      const idleMs = Math.round(randBetween(rng, idleMin, idleMax));
      store.addLogEntry(botId, 'info', `idle (human-like), resume in ${Math.round(idleMs / 60000)} min`);
      await sleep(idleMs, signal);
    }
  }
}
