import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const DEFAULTS = {
  api: {
    baseUrl: 'http://localhost:8080/api',
    requestTimeoutMs: 15000,
    retriesOn5xx: 3,
  },
  ai: {
    // provider: openai | deepseek | custom | mock
    //   openai  -> baseURL https://api.openai.com/v1
    //   deepseek-> baseURL https://api.deepseek.com/v1
    //   custom  -> własny baseURL (dowolny OpenAI-compatible serwer)
    //   mock    -> cykliczna "decyzja" (open -> set_tp_sl -> close -> hold), bez sieci
    provider: 'mock',
    baseURL: 'https://api.openai.com/v1',
    apiKey: '',
    model: 'gpt-4o-mini',
    temperature: 0.4,
    responseFormat: 'auto', // auto | json_object | text
    maxTokens: 400,
    timeoutMs: 30000,
  },
  account: {
    nicknamePrefix: 'bot',
    emailDomain: 'tradebot.local',
    password: 'DefaultPass123!',
    registerIntervalMs: 6500, // >= 6000 (limit 10 rejestracji/min)
    count: 2, // ile kont utworzyć automatycznie przy pierwszym starcie (0 = nie)
    nicknameMode: 'realistic', // "realistic" (ludzkie nicki/emaile) | "simple" (bot_xxx)
    nameStyle: 'mixed', // dla realistic: "mixed" | "gamer" | "polish"
    emailDomains: null, // opcjonalnie: własna lista domen (null = domyślna z names.js)
  },
  tournament: {
    preferStatus: 'registration_open',
    fallbackStatus: 'running',
    maxEntryFeeUsd: 50, // górny próg opłaty wpisowej dla turniejów płatnych
    requireStatus: 'registration_open', // 'registration_open' | 'running' | null (dowolny)
  },
  trading: {
    intervalMs: 45000,
    // Kamuflaż aktywności. Aplikacja oznacza usera offline gdy brak calla > 120 s:
    //   - bot "obecny": max odstęp między callami ~90 s (< 120 s) — nie miga offline
    //   - po ticku szansa przerwy offline (idleChancePerTick) 10-90 min — bot znika,
    //     przez co liczba online na aplikacji naturalnie faluje
    // tickBase = intervalMs * los(0.7..1.3) per bot (seed z id) + jitter ±.
    tickJitterFraction: 0.5, // ±50% odstępu na każdy tick (max ~90 s przy bazie 45 s)
    idleChancePerTick: 0.15, // szansa przerwy offline po ticku (0 = wyłączone)
    idleMinMs: 600000, // przerwa: min (10 min)
    idleMaxMs: 5400000, // przerwa: max (90 min)
    symbols: ['BTCUSDT', 'ETHUSDT'], // pula kandydatów — boty grają TYLKO rynki turnieju
    symbolsPerBot: 1, // ile rynków z puli losuje każdy bot (1 = jeden rynek na bota)
    budgetMinFraction: 0.3, // budżet bota = maxPositionAmountUsd * los(0.3..1)
    candlesInterval: '5m',
    candlesLimit: 20,
    maxPositionAmountUsd: 1000,
    maxEquityFraction: 0.5,
    maxOpenPositions: 3,
    maxLeverage: 10,
    minOrderSpacingMs: 2100, // >= 2000 (limit 30 zlecen/min)
    portfolioBusyRetries: 8,
    maxTickFailures: 3,
    fundingCheckTicks: 12, // co ile ticków ponawiać próbę join płatnego turnieju
  },
  server: {
    host: '127.0.0.1',
    port: 3000,
    auth: { // puste = tryb dev (host loopback); komplet = wymagany poza loopbackiem
      user: '',
      pass: '',
      token: '',
      maxAttempts: 4, // tyle błędnych prób z jednego IP -> blokada
      lockMs: 1800000, // czas blokady (30 min)
    },
  },
};

export function loadConfig(configPath = null) {
  let file = {};
  const path = configPath || join(ROOT, 'config.json');
  try {
    file = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    // brak pliku — używamy defaultów
  }
  return deepMerge(structuredClone(DEFAULTS), file);
}

export function parseArgs(argv) {
  const args = { offline: false, dryRun: false, config: null, target: null };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--offline') args.offline = true;
    else if (a === '--dry-run') args.dryRun = true;
    else if (a === '--config' && argv[i + 1]) args.config = argv[++i];
    else if (a === '--target' && argv[i + 1]) args.target = argv[++i];
  }
  return args;
}

export function deepMerge(target, ...sources) {
  for (const src of sources) {
    if (!src || typeof src !== 'object') continue;
    for (const [k, v] of Object.entries(src)) {
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        target[k] = deepMerge(target[k] && typeof target[k] === 'object' ? target[k] : {}, v);
      } else {
        target[k] = v;
      }
    }
  }
  return target;
}
