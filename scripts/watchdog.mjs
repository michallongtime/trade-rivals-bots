// watchdog.mjs — PID1 w kontenerze: startuje main.js (target prod), co 30 s
// sprawdza /api/health, po 3 kolejnych błędach ubija main (wyjście kontenera ->
// restart: unless-stopped podnosi go ponownie). Przekazuje SIGTERM/SIGINT do main,
// który ma już graceful shutdown (zapis kont/stanu).
import { spawn } from 'node:child_process';

const PORT = 4001; // musi się zgadzać z config.json server.port i docker-compose.yml
const CHECK_MS = 30000, TIMEOUT_MS = 5000, MAX_FAILS = 3, KILL_GRACE_MS = 15000;
const HEALTH_URL = `http://127.0.0.1:${PORT}/api/health`;
const log = (msg) => console.log(`${new Date().toISOString()} [watchdog] ${msg}`);

// --target prod jest KRYTYCZNE: bez flagi proces bez TTY cicho wybiera default "local"
// (targets.json), czyli http://localhost:8080 wewnątrz kontenera.
let child = spawn(process.execPath, ['src/main.js', '--target', 'prod'], { stdio: 'inherit' });
let fails = 0;

function killMain() {
  log('SIGTERM do main');
  child.kill('SIGTERM');
  const t = setTimeout(() => { log('main nie zakończył — SIGKILL'); child.kill('SIGKILL'); }, KILL_GRACE_MS);
  t.unref();
}

child.on('exit', (code, signal) => {
  log(`main zakończony (code=${code}, signal=${signal}) — wyjście kontenera`);
  process.exit(code ?? 1);
});
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { log(`${sig} -> main`); child.kill(sig); });

async function check() {
  try {
    const r = await fetch(HEALTH_URL, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    fails = 0;
    log('health OK');
  } catch (e) {
    fails += 1;
    log(`health FAIL (${fails}/${MAX_FAILS}): ${e.message}`);
    if (fails >= MAX_FAILS) { fails = 0; killMain(); }
  }
}
setInterval(check, CHECK_MS);
check();
