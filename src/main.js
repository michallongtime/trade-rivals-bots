// TradeContest Bot — entrypoint.
//   node src/main.js            — tryb live (wymaga config.json: baseUrl + AI key)
//   node src/main.js --dry-run  — odczyty live, mutacje tylko logowane
//   node src/main.js --offline  — pełny tryb testowy bez sieci (symulator)
//   node src/main.js --target <nazwa>  — cel serwera (targets.json); bez flagi prompt
import readline from 'node:readline';
import { loadConfig, parseArgs } from './config.js';
import { loadTargets, listTargets, resolveTargetName, applyTargetOverrides, dataDirFor } from './targets.js';
import { setLogLevel, log } from './util.js';
import { Store } from './store.js';
import { LlmClient } from './llm.js';
import { TradeSimulator } from './mock.js';
import { BotManager } from './manager.js';
import { createServer } from './server.js';

// Interaktywny wybór targetu (tylko gdy terminal, 15 s na odpowiedź).
function promptTarget(defaultName, t) {
  const entries = listTargets(t);
  if (!process.stdin.isTTY || entries.length === 0) return Promise.resolve(defaultName);
  console.log('Docelowy serwer (target):');
  for (const [i, e] of entries.entries()) {
    console.log(`  ${i + 1}) ${e.name}${e.baseUrl ? ' — ' + e.baseUrl : ''}`);
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      rl.close();
      resolve(defaultName);
    }, 15000);
    rl.question(`Wybierz (Enter = ${defaultName}): `, (answer) => {
      clearTimeout(timer);
      rl.close();
      answer = answer.trim();
      if (!answer) return resolve(defaultName);
      const i = parseInt(answer, 10);
      if (!Number.isNaN(i) && i >= 1 && i <= entries.length) return resolve(entries[i - 1].name);
      try {
        resolve(resolveTargetName(answer, t, defaultName));
      } catch (e) {
        console.error(e.message);
        resolve(defaultName);
      }
    });
  });
}

async function main() {
  const args = parseArgs(process.argv);
  const cfg = loadConfig(args.config);
  setLogLevel(cfg.log?.level ?? 'info');

  // Target: --target <nazwa> | prompt w terminalu | default z targets.json ('local').
  const targets = loadTargets();
  const defaultName = targets?.default ?? 'local';
  const targetName = args.target ? resolveTargetName(args.target, targets, defaultName) : await promptTarget(defaultName, targets);
  if (targets?.targets?.[targetName]) applyTargetOverrides(cfg, targets.targets[targetName]);
  const dataDir = targets ? dataDirFor(targetName) : null; // null = legacy pliki w ROOT
  log('info', `target: ${targetName} (${cfg.api.baseUrl})`);

  const store = new Store({ dataDir });
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

  const server = createServer({ manager, store, cfg, offline: args.offline, dryRun: args.dryRun, startedAt: Date.now(), targetName });
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
}

main().catch((e) => {
  log('error', e.message);
  process.exit(1);
});
