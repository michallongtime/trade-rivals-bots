// prompts.js — budowa promptu AI + walidacja decyzji.
// validateDecision() to jedyny punkt wejścia modelu do prawdziwych pieniędzy:
// każdy garbage / przekroczony limit kończy się "hold", nigdy zleceniem.
import { toNumber } from './util.js';

const round2 = (n) => Math.round(n * 100) / 100;

export function buildSystemPrompt(tournament, cfg) {
  const markets = (tournament.markets ?? []).map((m) => m.symbol).join(', ') || '(none)';
  const t = cfg.trading;
  return [
    `You are a professional crypto futures trader in the tournament "${tournament.name}" (status: ${tournament.status}; ends: ${tournament.end_at ?? '?'}).`,
    `Available markets: ${markets}.`,
    `Rules: leverage 1..${tournament.max_leverage ?? t.maxLeverage}; max ${t.maxOpenPositions} open positions; max ${t.maxPositionAmountUsd} USDT notional per position; fee ${tournament.fee_percent ?? 0.1}% per trade; lending fee ${tournament.lending_fee_daily_percent ?? 0.02}% per day.`,
    'Safety: never exceed the limits above; prefer small, disciplined positions; set TP and SL when possible.',
    'Respond ONLY with valid JSON, no markdown, no text, exactly one object of one of these forms:',
    '{"action":"open","side":"long|short","market_symbol":"BTCUSDT","amount_usd":500,"leverage":3,"tp_price":100000,"sl_price":95000}',
    '{"action":"close","position_id":321}',
    '{"action":"set_tp_sl","position_id":321,"tp_price":100000,"sl_price":95000}',
    '{"action":"hold"}',
    'Use null for tp_price/sl_price when not setting them.',
  ].join('\n');
}

export function buildUserPrompt({ tournament, portfolio, positions, pendingOrders, candlesBySymbol, prices, rank, playersCount }) {
  const L = [];
  const p = portfolio ?? {};
  L.push(`TOURNAMENT: ${tournament.name} | ${tournament.status} | end ${tournament.end_at ?? '?'} | max_leverage ${tournament.max_leverage} | fee ${tournament.fee_percent}% | lending ${tournament.lending_fee_daily_percent}%/day`);
  L.push(`YOUR ACCOUNT: equity ${p.equity ?? '?'} | cash ${p.cash_balance ?? '?'} | unrealized ${p.unrealized_pnl ?? '?'} | realized ${p.realized_pnl ?? '?'} | rank ${rank ?? '?'}/${playersCount ?? '?'}`);
  L.push('OPEN POSITIONS:');
  if (!positions.length) L.push('  (none)');
  for (const pos of positions) {
    L.push(`  #${pos.id} ${pos.market_symbol} ${pos.side} qty ${pos.qty} entry ${pos.entry_price} mark ${pos.mark_price} lev ${pos.leverage} liq ${pos.liquidation_price} upnl ${pos.unrealized_pnl}`);
  }
  L.push('PENDING ORDERS:');
  if (!pendingOrders.length) L.push('  (none)');
  for (const o of pendingOrders) {
    L.push(`  #${o.id} ${o.type} ${o.side} qty ${o.qty} @ ${o.price}${o.position_id ? ` (pos ${o.position_id})` : ''}`);
  }
  for (const [sym, candles] of Object.entries(candlesBySymbol)) {
    L.push(`MARKET ${sym} (5m, last ${candles.length}, oldest->newest):`);
    L.push('  ts open high low close volume');
    for (const c of candles.slice(-15)) {
      L.push(`  ${c.ts} ${c.open} ${c.high} ${c.low} ${c.close} ${c.volume}`);
    }
  }
  L.push(`CURRENT PRICES: ${Object.entries(prices).map(([s, v]) => `${s} ${v}`).join(' | ')}`);
  L.push('DECISION (JSON only):');
  return L.join('\n');
}

// ctx: { markets, positions, pendingOrders, portfolio, prices, tournament, cfg (trading) }
export function validateDecision(raw, ctx) {
  const reject = (error) => ({ ok: false, error, decision: { action: 'hold' } });
  const pass = (decision) => ({ ok: true, error: null, decision });

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return reject('non-JSON or empty decision');
  }
  const action = raw.action;
  if (action === 'hold') return pass({ action: 'hold' });

  const markets = ctx.markets ?? [];
  const positions = ctx.positions ?? [];
  const cfg = ctx.cfg ?? {};

  if (action === 'open') {
    if (raw.side !== 'long' && raw.side !== 'short') return reject('open: bad side');
    const market = markets.find((m) => m.symbol === raw.market_symbol);
    if (!market) return reject(`open: unknown market ${raw.market_symbol}`);
    if (positions.length >= (cfg.maxOpenPositions ?? 3)) return reject('veto: max open positions reached');
    const price = Number(ctx.prices?.[market.symbol]);
    if (!Number.isFinite(price) || price <= 0) return reject(`open: no price for ${market.symbol}`);
    const equity = toNumber(ctx.portfolio?.equity, toNumber(ctx.tournament?.virtual_start_capital, 0)) || 0;
    const amount = Number(raw.amount_usd);
    if (!Number.isFinite(amount) || amount <= 0) return reject('open: bad amount_usd');
    const maxAmount = Math.max(0, Math.min(cfg.maxPositionAmountUsd ?? 1000, equity * (cfg.maxEquityFraction ?? 0.5)));
    const clamped = Math.min(amount, maxAmount);
    if (clamped < 1) return reject('open: amount too small after clamping');
    const maxLev = Math.max(1, Math.min(cfg.maxLeverage ?? 10, toNumber(ctx.tournament?.max_leverage, 1) || 1));
    const leverage = Math.max(1, Math.min(Math.round(Number(raw.leverage) || 1), maxLev));
    let tp_price = null;
    let sl_price = null;
    if (raw.tp_price != null && Number.isFinite(Number(raw.tp_price)) && Number(raw.tp_price) > 0) {
      const tp = Number(raw.tp_price);
      if ((raw.side === 'long' && tp > price) || (raw.side === 'short' && tp < price)) tp_price = round2(tp);
    }
    if (raw.sl_price != null && Number.isFinite(Number(raw.sl_price)) && Number(raw.sl_price) > 0) {
      const sl = Number(raw.sl_price);
      if ((raw.side === 'long' && sl < price) || (raw.side === 'short' && sl > price)) sl_price = round2(sl);
    }
    return pass({ action: 'open', side: raw.side, market_symbol: market.symbol, amount_usd: round2(clamped), leverage, tp_price, sl_price });
  }

  if (action === 'close' || action === 'set_tp_sl') {
    const pos = positions.find((p) => p.id === Number(raw.position_id));
    if (!pos) return reject(`${action}: unknown position ${raw.position_id}`);
    if (action === 'close') return pass({ action: 'close', position_id: pos.id });
    const entry = Number(pos.entry_price) || 0;
    let tp_price = null;
    let sl_price = null;
    if (raw.tp_price != null && Number.isFinite(Number(raw.tp_price)) && Number(raw.tp_price) > 0) {
      const tp = Number(raw.tp_price);
      if ((pos.side === 'long' && tp > entry) || (pos.side === 'short' && tp < entry)) tp_price = round2(tp);
    }
    if (raw.sl_price != null && Number.isFinite(Number(raw.sl_price)) && Number(raw.sl_price) > 0) {
      const sl = Number(raw.sl_price);
      if ((pos.side === 'long' && sl < entry) || (pos.side === 'short' && sl > entry)) sl_price = round2(sl);
    }
    if (tp_price == null && sl_price == null) return reject('set_tp_sl: no valid prices');
    return pass({ action: 'set_tp_sl', position_id: pos.id, tp_price, sl_price });
  }

  return reject(`unknown action: ${action}`);
}
