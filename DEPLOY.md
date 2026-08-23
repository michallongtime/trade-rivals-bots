# 🚀 Wdrożenie produkcyjne (Docker na VPS)

Runbook dla produkcji: bot działa na VPS jako kontener Docker, dashboard na
publicznym porcie **4001**, chroniony **Basic Auth + token** (oba wymagane,
blokada po 4 błędnych próbach na 30 min), auto-restart po awarii i po rebootcie.

## Architektura

```
VPS (np. Debian/Ubuntu)
└── Docker
    └── kontener tradecontest-bot (node:20-alpine)
        ├── src/main.js --target prod   ← silnik bota (API: https://trade-rivals.com/api)
        └── scripts/watchdog.mjs (PID1) ← /api/health co 30 s, 3 błędy → restart
    Wolumeny:
        ./config.json → /app/config.json (ro)  ← sekrety (gitignored, tylko na hoście)
        ./data        → /app/data              ← accounts.json + state.json (żywe konta!)
Port: 4001 → 4001 (publiczny; auth w aplikacji)
```

## Wymagania

- Docker 24+ z pluginem compose v2 (`docker compose version`).
- SSH do VPS + klucz GitHub (deploy key, read-only) do `michallongtime/trade-rivals-bots`.
- Node.js 18+ na maszynie lokalnej (tylko do testów; na VPS niepotrzebny).

## Pierwsze wdrożenie (provisioning)

### 1. Docker na VPS (jeśli brak)

```bash
ssh user@VPS
docker --version 2>/dev/null || { curl -fsSL https://get.docker.com | sudo sh; sudo usermod -aG docker $USER; newgrp docker; }
docker compose version || sudo apt-get install -y docker-compose-plugin
```

### 2. Klucz GitHub (deploy key, read-only, generowany NA VPS)

```bash
ssh-keygen -t ed25519 -f ~/.ssh/id_ed25519_tradebot -N "" -C "tradebot-deploy"
cat ~/.ssh/id_ed25519_tradebot.pub   # skopiuj zawartość
```
Następnie **lokalnie** dodaj klucz do repo (tytuł np. `vps-prod`):
```bash
gh repo deploy-key add -R michallongtime/trade-rivals-bots - --title "vps-prod" --read-only
```
(albo ręcznie: GitHub → repo → Settings → Deploy keys → Add deploy key, **Read-only**).
Sprawdź na VPS: `ssh -o StrictHostKeyChecking=accept-new -T git@github.com`.

### 3. Klon repo

```bash
mkdir -p ~/apps && cd ~/apps
git clone git@github.com:michallongtime/trade-rivals-bots.git && cd trade-rivals-bots
```

### 4. `config.json` na VPS — stwórz ODRĘCZNIE (nie kopiuj lokalnego!)

Lokalny config ma `127.0.0.1:3000` i w kontenerze opublikowany port byłby
nieosiągalny. Klucz AI weź z lokalnego (gitignored) `config.json`.

```bash
node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"  # -> TOKEN
openssl rand -base64 18                                                          # -> HASLO
cat > config.json <<'EOF'
{
  "ai": {
    "provider": "deepseek",
    "baseURL": "https://api.deepseek.com/v1",
    "apiKey": "sk-TUTAJ-KLUCZ",
    "model": "deepseek-chat"
  },
  "server": {
    "host": "0.0.0.0",
    "port": 4001,
    "auth": { "user": "admin", "pass": "HASLO", "token": "TOKEN", "maxAttempts": 4, "lockMs": 1800000 }
  }
}
EOF
```

> ⚠️ `server.host` w kontenerze MUSI być `0.0.0.0` (bez tego port 4001 nie jest
> osiągalny z zewnątrz). Resztę configu (trading, account itd.) dostosuj jak
> chcesz — działa merge z domyślnymi wartościami.
> ⚠️ Nigdy nie wykonuj `git add -f config.json` — plik jest gitignored.

### 5. Dane produkcyjne z komputera lokalnego — ZANIM pierwszy start!

```bash
scp -r "C:\Users\longtime\claude\trade-contest-bot\data\prod" user@VPS:~/apps/trade-rivals-bots/data/
sudo chown -R 1000:1000 data   # kontener działa jako uid 1000 (USER node)
```

Bez tego boty zarejestrują **nowe** konta na realnym serwerze (stare tokeny
i `player_id` zostaną porzucone).

### 6. Firewall

```bash
sudo ufw allow 4001/tcp    # albo otwórz port 4001 w panelu dostawcy VPS
```

### 7. Start

```bash
docker compose up -d --build
docker compose ps          # STATUS: healthy
docker compose logs -f bot # oczekiwane: "target: prod (https://trade-rivals.com/api)" + "dashboard: http://0.0.0.0:4001"
```

## Wdrożenie rutynowe (release)

Wszystko po tagu — wersja zawsze = `v` + `package.json`:

```bash
# lokalnie:
git switch -c feat/<nazwa> main      # feature branch ZAWSZE z aktualnego maina
# ...zmiany... npm test
git add -A && git commit -m "..."
gh pr create --fill && gh pr merge --merge --delete-branch
git switch main && git pull
# bump wersji (edytuj package.json -> 0.x.y):
git add package.json && git commit -m "bump: v0.x.y"
git tag v0.x.y && git push origin main --tags

# na VPS:
cd ~/apps/trade-rivals-bots
git fetch --tags && git checkout v0.x.y     # detached HEAD — OK, wdrożenie zawsze po tagu
docker compose up -d --build
docker compose ps && curl -s http://127.0.0.1:4001/api/health
```

`config.json` i `data/` są gitignored → przeżywają checkout. Rollback:
`git checkout v0.1.0 && docker compose up -d --build`.

## Weryfikacja

```bash
curl -s  http://VPS:4001/api/health                         # {"ok":true}
curl -si http://VPS:4001/api/status                         # 401
curl -si -u admin:HASLO -H "X-Auth-Token: TOKEN" http://VPS:4001/api/status   # 200 + totals
```
Przeglądarka: `http://VPS:4001` → ekran logowania (login + hasło + token) →
dashboard. Totals powinny pokazywać **istniejące** boty — dowód, że `data/prod`
się podpięło (bez re-rejestracji).

Test auto-restartu:
```bash
docker compose exec bot sh -c "pkill -f 'node src/main.js'; true"
# watchdog widzi exit -> kontener wychodzi -> restart: unless-stopped -> po ~20 s health OK
```

## Rozwiązywanie problemów

| Objaw | Postępowanie |
|---|---|
| Crashloop (`ps` pokazuje `restarting`) | `docker compose logs --tail 50 bot` — najczęściej błąd configu (np. brak `server.auth` na `0.0.0.0` — celowo, fail-closed) |
| Dashboard nieosiągalny z zewnątrz | sprawdź bind: `server.host` musi być `0.0.0.0`; port w firewallu (`ss -ltnp` na VPS) |
| 429 "zbyt wiele prób logowania" | poczekaj na `Retry-After` albo zrestartuj kontener (blokada jest w pamięci) |
| Kontener nie może pisać do `data/` | `sudo chown -R 1000:1000 data` |
| Boty grają w "local" zamiast "prod" | log powinien mieć `target: prod`; watchdog zawsze startuje z `--target prod` |
| Lockout kluczuje po jednym IP | bezpośredni publish portu → `req.socket.remoteAddress` = realny IP klienta; jeśli nginx stanie przed aplikacją, lockout zadziała per-IP nginx |

## Poświadczenia dashboardu

Login, hasło i token są w `config.json` na VPS (`server.auth`). Generuj mocne:
`node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"`.
Zapisz je w menedżerze haseł — dashboard pyta o nie przy każdym logowaniu.
