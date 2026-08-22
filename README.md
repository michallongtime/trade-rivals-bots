# 🤖 TradeContest Bot

Lekka aplikacja (Node.js, **zero zależności npm**) do gry w turniejach TradeContest
przez jego API (`API.md`). Tworzy konta, dołącza je do turniejów i handluje
**zgodnie z decyzjami AI** (OpenAI lub DeepSeek), a całość zarządzasz z lokalnego
dashboardu w przeglądarce.

Nie potrzebuje żadnego serwera — działa jako jeden lokalny proces: silnik botów
+ mini-dashboard na `http://127.0.0.1:3000`.

## Wymagania

- **Node.js 18+** (używa wbudowanego `fetch`). Sprawdź: `node --version`
- Dostęp do API TradeContest (`config.json → api.baseUrl`), domyślnie `http://localhost:8080/api`
- Klucz AI (OpenAI lub DeepSeek) — tylko jeśli używasz prawdziwego AI

## Start

```bash
npm start              # tryb live; bez --target zapyta o cel serwera
npm run start:local    # od razu cel „local" (http://localhost:8080/api)
npm run start:prod     # od razu cel „prod" (produkcja)
npm start -- --dry-run # odczyty live, zlecenia tylko logowane (bezpieczny test)
npm start -- --offline # pełny tryb testowy bez sieci (symulator w pamięci)
```

## Cel serwera (targety)

`targets.json` definiuje nazwane cele — serwery, na których grają boty. Każdy
cel to nadpisania configu (głównie `api.baseUrl`) nakładane **po** `config.json`
(cel wygrywa) oraz **osobny katalog danych** `data/<target>/` z `accounts.json`
i `state.json`. Tokeny i `player_id` są specyficzne dla serwera — oddzielne
pliki zapobiegają mieszaniu kont locala z produkcją.

```jsonc
{
  "default": "local",              // używane przy Enter / braku terminala
  "targets": {
    "local": { "api": { "baseUrl": "http://localhost:8080/api" } },
    "prod":   { "api": { "baseUrl": "https://twoja-domena/api" } }
  }
}
```

- `npm start` bez flagi → w terminalu pojawia się lista targetów (15 s na
  wybór, Enter = `default`; poza terminalem od razu default),
- `--target <nazwa>` (lub `npm run start:local` / `start:prod`) pomija prompt;
  nieznana nazwa kończy się błędem z listą dostępnych,
- dashboard pokazuje aktywny cel jako badge **🎯**.

Po starcie otwórz **http://127.0.0.1:3000** — dashboard:

- formularz **„Stwórz boty"** — liczba kont do utworzenia (rejestracja w tle,
  pacing 6,5 s z limitu 10/min API),
- tabela botów: equity, PnL, ranking, pozycje, ostatnia decyzja AI, błędy,
- akcje **⏸ wstrzymaj / ▶ wznów / 🗑 usuń** (usuń = logout tokenu + wykluczenie),
- klik w wiersz → log bota (200 ostatnich wpisów),
- odświeżanie co 3 s.

## Konfiguracja (`config.json`)

```jsonc
{
  "api": {
    "baseUrl": "http://localhost:8080/api"   // adres API TradeContest
  },
  "ai": {
    "provider": "mock",        // "mock" | "openai" | "deepseek" | "custom"
    "baseURL": "https://api.openai.com/v1",  // deepseek: https://api.deepseek.com/v1
    "apiKey": "sk-...",        // klucz API (dla mock niewymagany)
    "model": "gpt-4o-mini",    // deepseek: "deepseek-chat"
    "temperature": 0.4
  },
  "account": {
    "nicknamePrefix": "bot",   // konta: bot_abc123
    "emailDomain": "tradebot.local",
    "password": "DefaultPass123!",
    "count": 0                 // ile kont utworzyć przy pierwszym starcie (0 = ręcznie z dashboardu)
  },
  "tournament": {
    "preferStatus": "registration_open",  // szukaj turnieju w tym statusie
    "fallbackStatus": "running",
    "maxEntryFeeUsd": 50,      // górny próg opłaty wpisowej (turnieje płatne)
    "forceId": null            // opcjonalnie: id konkretnego turnieju
  },
  "trading": {
    "intervalMs": 45000,       // co ile sekund tick (decyzja AI)
    "symbols": ["BTCUSDT", "ETHUSDT"],   // pula kandydatów — boty grają TYLKO rynki turnieju
    "symbolsPerBot": 1,        // ile rynków z puli losuje każdy bot (1 = jeden rynek na bota)
    "budgetMinFraction": 0.3,  // budżet bota = maxPositionAmountUsd * los(0.3..1)
    "maxPositionAmountUsd": 1000,        // twardy limit kwoty na pozycję
    "maxEquityFraction": 0.5,  // max frakcja equity na pozycję
    "maxOpenPositions": 3,     // max równocześnie otwartych pozycji
    "maxLeverage": 10          // max dźwignia (i tak ograniczona max_leverage turnieju)
  },
  "server": { "host": "127.0.0.1", "port": 3000 }
}
```

> ⚠️ `ai.provider: "mock"` (domyślny) — boty grają według prostego cyklu
> (open → TP/SL → close) bez sieci, żeby wszystko działało od razu.
> Ustaw `"deepseek"` lub `"openai"` i klucz, aby decyzje podejmowało prawdziwe AI.

## Jak to działa (przepływ bota)

1. **Rejestracja** — `POST /auth/register` (limit 10/min → kolejka z pacingiem).
2. **Turniej** — wybiera turniej z `can_join: true` (lub `tournament.forceId`).
   Dla turniejów płatnych (`is_paid`) sprawdza `GET /me/wallet`; brak środków →
   status `needs_funding` (bot czeka, próbuje co `fundingCheckTicks` ticków).
   Zapamiętuje `player_id` (potrzebny do handlu).
3. **Tick** (co `intervalMs`):
   - status turnieju → handluje tylko gdy `running` (inaczej `waiting`),
   - portfolio + transakcje (realizowany PnL), świece 5m, ceny, ranking
     (uwaga: w rankingu `player_id` to **id użytkownika** — API.md §6.1),
   - buduje prompt (zasady turnieju, portfel, pozycje, świece, ceny) → AI
     odpowiada JSON-em → `validateDecision` (weta bezpieczeństwa) → egzekucja.
4. **Decyzje AI** (JSON): `open` (market + opcjonalnie TP/SL), `close`,
   `set_tp_sl`, `hold`.
5. **Odporność**: lock „Portfolio is busy, try again." → retry 1 s ×8;
   429 → backoff z `Retry-After`; 401 → automatyczny re-login; błąd ticka ×3 →
   status `error` + backoff 5 s–5 min, potem automatyczny powrót.

## Bezpieczeństwo środków

- `validateDecision` to jedyny punkt wejścia AI do pieniędzy: kwota i dźwignia
  są **clampowane** do limitów z configu i turnieju, TP/SL sanity-checkowane
  względem ceny, garbage/non-JSON → zawsze `hold`, przy pełnym portfolio → weto.
- `--dry-run` nigdy nie wysyła mutacji (zlecenia/join/rejestracja tylko logowane).

## Testy

```bash
npm test        # 25 testów: storage, walidacja decyzji, cykl bota (offline + HTTP), 429/401
npm run stub    # osobno: atrapa API na http://127.0.0.1:8081 (do ręcznych prób)
```

Testy używają wbudowanego symulatora (`src/mock.js`) i nie dotykają prawdziwego
serwera ani sieci.

## Pliki

```
src/main.js      entrypoint (flagi --offline / --dry-run / --config / --target)
src/config.js    domyślna konfiguracja + merge z config.json
src/targets.js   targety z targets.json: rezolucja, nadpisania, data/<target>
src/store.js     accounts.json (konta+tokeny) i state.json (snapshoty botów), zapis atomic
targets.json     cele serwera: local / prod (+ własne dane per cel)
src/api.js       klient HTTP: throttle (10/min, 20/min, 30/min), backoff 429, re-login 401
src/llm.js       klient OpenAI-compatible (OpenAI/DeepSeek/custom/mock)
src/prompts.js   builder promptu + walidacja decyzji AI (weta bezpieczeństwa)
src/engine.js    pętla handlowa bota (tick, egzekucja, busy-retry, error recovery)
src/manager.js   cykl życia: rejestracja, pause/resume/delete
src/server.js    dashboard REST (czysty http)
src/mock.js      symulator API (tryb --offline i rdzeń stub-servera)
public/dashboard.html   strona dashboardu
test/            stub-server + smoke testy
```

## Uwagi

- **Turnieje płatne**: bot nie może sam wpłacić (Stripe/krypto wymagają ręki
  użytkownika). Gdy wykryje brak środków — czeka w statusie `needs_funding`
  aż zasilisz portfel konta.
- Konta nie da się usunąć przez API — „usuń" w dashboardzie wylogowuje token
  i wyklucza konto z zarządzania.
- Tokeny trzymane w `accounts.json` (zwykły tekst, plik lokalny) — nie udostępniaj
  tego pliku.
- Decyzje o cenie, prowizjach i likwidacjach podejmuje **serwer** — bot tylko
  wysyła intencje, tak jak opisuje API.md §12.
