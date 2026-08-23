// auth.js — autoryzacja dashboardu: HTTP Basic + X-Auth-Token + lockout per IP.
// Czysta logika (bez zależności od serwera) — testowalna w test/smoke.js.
import { createHash, timingSafeEqual } from 'node:crypto';

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);

// Bezpieczne porównanie: hashe obu stron (ta sama długość) -> timingSafeEqual.
function safeEqual(a, b) {
  const ha = createHash('sha256').update(String(a)).digest();
  const hb = createHash('sha256').update(String(b)).digest();
  return timingSafeEqual(ha, hb);
}

// Parsowanie nagłówka Basic: "Basic base64(user:pass)".
// Pierwszy dwukropek dzieli login od hasła — hasło może zawierać ':'.
export function parseBasic(header) {
  if (typeof header !== 'string' || !header.startsWith('Basic ')) return null;
  const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
  const i = decoded.indexOf(':');
  if (i < 0) return null;
  return { user: decoded.slice(0, i), pass: decoded.slice(i + 1) };
}

// Fail-closed: bind poza loopbackiem wymaga kompletnego server.auth.
// Bez tego publiczny dashboard mógłby wystartować bez żadnej ochrony.
export function assertAuthConfig(cfg) {
  const host = cfg.server?.host;
  const a = cfg.server?.auth ?? {};
  if (!LOOPBACK.has(host) && !(a.user && a.pass && a.token)) {
    throw new Error(
      `server.host "${host}" (poza loopbackiem) wymaga server.auth {user, pass, token} w config.json — odmowa startu.`);
  }
}

// Guard zwraca: { allowed: true } | { allowed: false, status: 401 }
// | { allowed: false, status: 429, retryAfter } (blokada per IP).
export function createAuthGuard(cfg) {
  const { user, pass, token, maxAttempts = 4, lockMs = 1800000 } = cfg.server?.auth ?? {};
  const enabled = Boolean(user && pass && token); // loopback bez auth = tryb dev, guard wyłączony
  const failures = new Map(); // ip -> { count, lockedUntil } — stan per instancja

  function isLocked(ip) {
    const e = failures.get(ip);
    if (!e) return false;
    if (e.lockedUntil && e.lockedUntil > Date.now()) return true;
    if (e.lockedUntil) failures.delete(ip); // tylko wygasły lock — reset; licznik błędów zostaje
    return false;
  }

  function fail(ip) {
    const e = failures.get(ip) ?? { count: 0 };
    e.count += 1;
    if (e.count >= maxAttempts) { e.lockedUntil = Date.now() + lockMs; e.count = 0; }
    failures.set(ip, e);
    if (failures.size > 10000) { // ochrona przed wzrostem pamięci
      for (const [k, v] of failures) if (v.lockedUntil < Date.now()) failures.delete(k);
      if (failures.size > 10000) failures.clear();
    }
  }

  return function guard(req) {
    if (!enabled) return { allowed: true };
    const ip = req.socket?.remoteAddress ?? 'unknown';
    if (isLocked(ip)) { // blokada ma pierwszeństwo — nawet poprawne dane -> 429
      const until = failures.get(ip).lockedUntil;
      return { allowed: false, status: 429, retryAfter: Math.ceil((until - Date.now()) / 1000) };
    }
    const b = parseBasic(req.headers.authorization);
    // Bez nagłówka Authorization to NIE jest próba logowania (np. poll dashboardu
    // bez creds) — 401 bez licznika; inaczej 4 puste żądania zablokowałyby IP.
    if (!b) return { allowed: false, status: 401, retryAfter: null };
    const t = req.headers['x-auth-token'];
    const good = safeEqual(b.user, user) && safeEqual(b.pass, pass)
      && typeof t === 'string' && safeEqual(t, token);
    if (!good) { fail(ip); return { allowed: false, status: 401, retryAfter: null }; }
    failures.delete(ip); // sukces resetuje licznik
    return { allowed: true };
  };
}
