// TradeContest Bot — entrypoint.
//   node src/main.js            — tryb live (wymaga config.json: baseUrl + AI key)
//   node src/main.js --dry-run  — odczyty live, mutacje tylko logowane
//   node src/main.js --offline  — pełny tryb testowy bez sieci (symulator)
import { loadConfig, parseArgs } from './config.js';
import { setLogLevel, log } from './util.js';
import { Store } from './store.js';
import { LlmClient } from './llm.js';
import { TradeSimulator } from './mock.js';
import { BotManager } from './manager.js';
import { createServer } from './server.js';

const args = parseArgs(process.argv);
const cfg = loadConfig(args.config);
setLogLevel(cfg.log?.level ?? 'info');

const store = new Store();
const llm = new LlmClient(cfg.ai);
const sim = args.offline
  ? new TradeSimulator({ symbols: cfg.trading.symbols, maxLeverage: cfg.trading.maxLeverage })
  : null;

const manager = new BotManager({ store, cfg, llm, offline: args.offline, dryRun: args.dryRun, sim });

// Automatyczne utworzenie początkowej liczby kont przy pierwszym starcie.
if (cfg.account.count > 0 && store.accounts.accounts.length === 0) {
  log('info', `creating ${cfg.account.count} initial account(s)`);
  manager.createAccounts(cfg.account.count);
}

// Wznowienie botów z poprzedniego uruchomienia (poza zapauzowanymi).
manager.startAllActive();

// Okresowy flush stanu (crash-safe; zapis atomic tmp+rename).
setInterval(() => store.saveState(), 2000);

const server = createServer({ manager, store, cfg, offline: args.offline, dryRun: args.dryRun, startedAt: Date.now() });
server.listen(cfg.server.port, cfg.server.host, () => {
  log('info', `dashboard: http://${cfg.server.host}:${cfg.server.port}`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    log('info', `received ${sig}, shutting down`);
    server.close();
    manager.stopAll();
    store.saveAccounts();
    store.saveState();
    process.exit(0);
  });
}
