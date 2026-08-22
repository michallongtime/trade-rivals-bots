import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomBytes } from 'node:crypto';

export const now = () => new Date().toISOString();

export function shortId(len = 4) {
  return randomBytes(len).toString('hex');
}

export function abortedError() {
  return Object.assign(new Error('aborted'), { code: 'ABORTED' });
}

// Przerywalny sleep — kończy się natychmiast (reject) gdy signal zostanie abortowany.
export function sleep(ms, signal) {
  if (signal?.aborted) return Promise.reject(abortedError());
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    if (signal) {
      signal.addEventListener('abort', () => {
        clearTimeout(timer);
        reject(abortedError());
      }, { once: true });
    }
  });
}

export function loadJsonFile(file, fallback) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

// Zapis atomowy: tmp + rename (rename jest atomowy także na Windows w obrębie katalogu).
export function atomicWriteJson(file, data) {
  const tmp = file + '.tmp';
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  renameSync(tmp, file);
}

let logLevel = 'info';

export function setLogLevel(level) {
  logLevel = level;
}

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };

export function log(level, msg, extra = '') {
  if (LEVELS[level] < LEVELS[logLevel]) return;
  const line = `[${now()}] [${level.toUpperCase().padEnd(5)}] ${msg}`;
  console.log(line + (extra ? ' ' + extra : ''));
}

export function toNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
