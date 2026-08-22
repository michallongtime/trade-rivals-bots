// LlmClient — klient OpenAI-compatible chat completions (OpenAI / DeepSeek / dowolny
// zgodny serwer). Provider "mock" zwraca cykliczne decyzje bez sieci (do testów
// i trybu --offline). Zawsze odpowiada { ok, decision, raw } — błędy nigdy nie
// rzucają wyjątków, tylko wymuszają decyzję "hold".
import { log } from './util.js';

const round2 = (n) => Math.round(n * 100) / 100;

export function parseJsonResponse(text) {
  if (!text || typeof text !== 'string') return null;
  let t = text.trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) t = fence[1].trim();
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    return JSON.parse(t.slice(start, end + 1));
  } catch {
    return null;
  }
}

export class LlmClient {
  constructor(aiCfg) {
    this.cfg = aiCfg;
    this.baseURL = this.#resolveBaseURL();
  }

  #resolveBaseURL() {
    switch (this.cfg.provider) {
      case 'openai':
        return 'https://api.openai.com/v1';
      case 'deepseek':
        return 'https://api.deepseek.com/v1';
      case 'mock':
        return null;
      default:
        return this.cfg.baseURL;
    }
  }

  async decide({ system, user, ctx }) {
    if (this.cfg.provider === 'mock') {
      const decision = mockDecision(ctx);
      return { ok: true, decision, raw: JSON.stringify(decision) };
    }
    if (!this.cfg.apiKey) {
      log('warn', 'AI: brak apiKey w config.json — decyzja hold');
      return { ok: false, decision: { action: 'hold' }, raw: null };
    }
    const body = {
      model: this.cfg.model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      temperature: this.cfg.temperature,
      max_tokens: this.cfg.maxTokens ?? 400,
    };
    if (this.cfg.responseFormat !== 'text') body.response_format = { type: 'json_object' };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.cfg.timeoutMs ?? 30000);
    try {
      const res = await fetch(`${this.baseURL}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.cfg.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!res.ok) {
        const detail = (await res.text()).slice(0, 200);
        log('warn', `AI HTTP ${res.status}: ${detail}`);
        return { ok: false, decision: { action: 'hold' }, raw: null };
      }
      const data = await res.json();
      const text = data?.choices?.[0]?.message?.content ?? '';
      const parsed = parseJsonResponse(text);
      if (!parsed) {
        log('warn', `AI zwróciło nie-JSON: ${text.slice(0, 120)}`);
        return { ok: false, decision: { action: 'hold' }, raw: text };
      }
      return { ok: true, decision: parsed, raw: text };
    } catch (e) {
      log('warn', `AI request failed: ${e.message}`);
      return { ok: false, decision: { action: 'hold' }, raw: null };
    } finally {
      clearTimeout(timer);
    }
  }
}

// Cykliczna "decyzja" mocka: open (bez pozycji) -> set_tp_sl (pozycja bez stopów)
// -> close (pozycja ze stopami) -> powtórka. Deterministyczna, napędza --offline.
function mockDecision(ctx) {
  const positions = ctx?.positions ?? [];
  const markets = ctx?.markets ?? [];
  const pending = ctx?.pendingOrders ?? [];
  if (!positions.length && markets.length) {
    const m = markets[0];
    return { action: 'open', side: 'long', market_symbol: m.symbol, amount_usd: 500, leverage: 3, tp_price: null, sl_price: null };
  }
  const pos = positions[0];
  if (pos) {
    const hasStops = pending.some((o) => o.position_id === pos.id && (o.type === 'tp' || o.type === 'sl'));
    const entry = Number(pos.entry_price) || 0;
    if (!hasStops && entry > 0) {
      const tp = entry * (pos.side === 'long' ? 1.05 : 0.95);
      const sl = entry * (pos.side === 'long' ? 0.95 : 1.05);
      return { action: 'set_tp_sl', position_id: pos.id, tp_price: round2(tp), sl_price: round2(sl) };
    }
    return { action: 'close', position_id: pos.id };
  }
  return { action: 'hold' };
}
