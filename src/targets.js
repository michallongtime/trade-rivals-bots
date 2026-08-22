// targets.js — zarządzanie docelowym serwerem (targety).
//
// targets.json definiuje nazwane cele: każdy to nadpisania configu (głównie
// api.baseUrl), nakładane PO config.json (target wygrywa). Każdy target ma też
// OSOBNE pliki danych (data/<target>/accounts.json, state.json) — tokeny i
// player_id są specyficzne dla serwera, nie wolno ich mieszać między celami.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, deepMerge } from './config.js';

const TARGETS_FILE = join(ROOT, 'targets.json');

export function loadTargets() {
  try {
    return JSON.parse(readFileSync(TARGETS_FILE, 'utf8'));
  } catch {
    return null; // brak pliku — tryb legacy (sam config.json)
  }
}

export function listTargets(t) {
  if (!t || !t.targets || typeof t.targets !== 'object') return [];
  return Object.entries(t.targets).map(([name, overrides]) => ({
    name,
    baseUrl: overrides?.api?.baseUrl ?? null,
  }));
}

// Flaga --target wymusza konkretny target (błąd przy nieznanej nazwie).
export function resolveTargetName(flag, targets, defaultName) {
  if (!flag) return defaultName;
  if (targets?.targets?.[flag]) return flag;
  const known = listTargets(targets).map((t) => t.name).join(', ') || '(brak targetów w targets.json)';
  throw new Error(`nieznany target: "${flag}" — dostępne: ${known}`);
}

// Nadpisania targetu nałożone na cfg (mutuje cfg).
export function applyTargetOverrides(cfg, overrides) {
  if (overrides && typeof overrides === 'object') deepMerge(cfg, overrides);
  return cfg;
}

export function dataDirFor(name) {
  return join(ROOT, 'data', name);
}
