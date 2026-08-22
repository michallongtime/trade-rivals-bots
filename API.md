# TradeContest API - Dokumentacja dla aplikacji zewnętrznych

Dokumentacja przeznaczona dla integratorów zewnętrznych: aplikacji mobilnych, botów
handlowych i innych klientów API. Pozwala w pełni korzystać z funkcjonalności serwisu:
rejestracja, turnieje, handel (market/limit/TP/SL), dane rynkowe, rankingi, profile
graczy oraz realny portfel (wpłaty i wypłaty).

---

## 1. Podstawy

### 1.1. Base URL

```
http://localhost:8080/api        (środowisko lokalne / docker)
https://<domena-produkcyjna>/api (produkcja)
```

Wszystkie ścieżki w tym dokumencie są względne względem base URL (np. `POST /auth/login`
oznacza `POST http://localhost:8080/api/auth/login`).

### 1.2. Format

- Wszystkie odpowiedzi to JSON.
- Requesty z ciałem muszą mieć nagłówek `Content-Type: application/json`.
- Requesty powinny mieć nagłówek `Accept: application/json`.
- Opcjonalny nagłówek `X-Locale: pl|en` - ustawia język komunikatów (domyślnie pl).
- Wartości pieniężne i ilości są zwracane jako **stringi z 8 miejscami po przecinku**
  (obliczenia po stronie serwera z precyzją bcmath) - nie używaj floatów do arytmetyki.
- Daty i godziny: format ISO 8601 (np. `2026-08-21T12:00:00+02:00`).

### 1.3. Uwierzytelnianie

Model: **tokeny Bearer (Laravel Sanctum)**. Po zalogowaniu serwer zwraca token,
który należy dołączać do każdego żądania jako:

```
Authorization: Bearer <token>
```

- Token nie wygasa z czasem - unieważnia go wylogowanie (logout) po stronie serwera.
- W aplikacji mobilnej trzymaj token w bezpiecznym magazynie (Keychain/Keystore),
  w webowej w localStorage (tak robi oficjalne SPA).
- Po utracie/odwołaniu tokenu każdy autoryzowany endpoint zwraca `401`.

### 1.4. Format błędów

Wszystkie błędy JSON:

```json
{ "message": "Opis błędu" }
```

Błąd walidacji (422) zawiera dodatkowo `errors`:

```json
{
  "message": "The given data was invalid.",
  "errors": {
    "email": ["The email field is required."]
  }
}
```

### 1.5. Kody HTTP

| Kod | Znaczenie |
|-----|-----------|
| 200 | OK |
| 201 | Utworzono (rejestracja, dołączenie, zlecenie wypełnione, wypłata zgłoszona) |
| 202 | Zaakceptowano (zlecenie oczekujące - limit/TP/SL przyjęte do pending) |
| 401 | Brak lub nieprawidłowy token |
| 402 | Brak środków (opłata wpisowa) - z dodatkowymi polami |
| 403 | Brak uprawnień (nie jesteś właścicielem portfolio / nie jesteś adminem) |
| 404 | Nie znaleziono (turniej, rynek, gracz, pozycja, zlecenie) |
| 409 | Konflikt (już zapisany do turnieju) |
| 422 | Walidacja lub błąd biznesowy (zamknięte okno zapisów, handel nieaktywny itd.) |
| 503 | Usługa niedostępna (brak ceny z feedu, Google OAuth nieaktywny) |

### 1.6. Ograniczenia (throttle)

| Endpoint | Limit |
|----------|-------|
| `/auth/register`, `/auth/login` | 10/min |
| `/nickname-availability` | 30/min |
| `/tournaments/{id}/join` | 20/min |
| `/portfolios/{player}/orders` | 30/min |

Po przekroczeniu limitu: `429 Too Many Requests`.

---

## 2. Uwierzytelnianie (endpointy)

### 2.1. Rejestracja

```
POST /auth/register
```

| Pole | Wymagane | Zasady |
|------|----------|--------|
| `nickname` | tak | 3-24 znaki, tylko `[a-zA-Z0-9_]`, unikalny globalnie (bez rozróżniania wielkości liter) |
| `email` | tak | poprawny adres, unikalny |
| `password` | tak | min. 8 znaków |
| `password_confirmation` | tak | musi być równe `password` |

Odpowiedź `201`:

```json
{
  "token": "1|abc123...",
  "user": { "id": 42, "nickname": "trader", "email": "t@example.com", "role": "user", "locale": "pl" }
}
```

Przed rejestracją warto sprawdzić dostępność nicku (p. 2.5) i obsłużyć błąd 422
`nickname_taken`.

### 2.2. Logowanie

```
POST /auth/login
```

| Pole | Wymagane | Zasady |
|------|----------|--------|
| `email` | tak | adres e-mail |
| `password` | tak | hasło |

Odpowiedź `200` - jak rejestracja (`token` + `user`).
Błędne dane: `422` z `message: auth.failed` (po polsku: "Nieprawidłowy e-mail lub hasło").

### 2.3. Wylogowanie (unieważnia token)

```
POST /auth/logout           (wymaga tokenu)
```

Odpowiedź: `200 {"message": "ok"}`. Token zostaje trwale usunięty z bazy - po
wylogowaniu nie można go już użyć.

### 2.4. Aktualny użytkownik

```
GET /me                     (wymaga tokenu)
```

```json
{
  "user": { "id": 42, "nickname": "trader", "email": "t@example.com", "role": "user", "locale": "pl" },
  "wallet_balance": "1250.50000000"
}
```

`role`: `user` | `admin`. `wallet_balance` - saldo realnego portfela (string).

### 2.5. Dostępność nicku

```
GET /nickname-availability?nick=trader
```

Odpowiedź:

```json
{ "available": true }
```

Gdy nick nieprawidłowy: `{ "available": false, "reason": "invalid" }`.

### 2.6. Google OAuth

```
GET /auth/google/redirect
```

Odpowiedź: `200 {"url": "https://accounts.google.com/o/oauth2/..."}` - otwórz ten URL
w przeglądarce użytkownika (przenosi do Google).

```
GET /auth/google/callback?code=...&state=...
```

Endpoint, na który Google przekierowuje po zalogowaniu. Odpowiada JSON-em jak
logowanie: `{ "token": "...", "user": {...} }`. Dla aplikacji mobilnych: otwórz
`/auth/google/redirect` w WebView, przechwyć odpowiedź callbacku (lub użyj
dedykowanego przepływu OAuth z przekierowaniem na własny deep link i wymianą kodu).

Uwaga: jeśli Google OAuth nie jest skonfigurowany, `/auth/google/redirect` zwraca
`503`.

---

## 3. Turnieje

### 3.1. Lista turniejów

```
GET /tournaments?status=running
```

Parametry (query):

| Parametr | Opcjonalny | Zasady |
|----------|------------|--------|
| `status` | tak | `draft`, `registration_open`, `running`, `settling`, `finished`, `archived`. Bez parametru zwracane są wszystkie poza `draft` i `archived`. |

Odpowiedź `200`:

```json
{
  "tournaments": [
    {
      "id": 7,
      "slug": "btc-rally-aug",
      "name": "BTC Rally Sierpień",
      "status": "running",
      "is_paid": true,
      "entry_fee": "25.00000000",
      "prize_type": "sponsored",
      "prize_amount": 1000.0,
      "virtual_start_capital": "10000.00000000",
      "max_leverage": "10.00000000",
      "fee_percent": "0.10000000",
      "lending_fee_daily_percent": "0.02000000",
      "markets": [
        { "id": 1, "symbol": "BTCUSDT", "base": "BTC", "quote": "USDT" }
      ],
      "start_registration_at": "2026-08-01T10:00:00+02:00",
      "start_at": "2026-08-10T10:00:00+02:00",
      "end_at": "2026-08-17T10:00:00+02:00",
      "join_until": "2026-08-15T10:00:00+02:00",
      "players_count": 87,
      "prize_structure": { "1": "50%", "2": "30%", "3": "20%" },
      "rules": { "description": "..." },
      "is_ad_supported": true,
      "is_featured": true,
      "can_join": true,
      "ads": null
    }
  ]
}
```

Pola kluczowe:

| Pole | Znaczenie |
|------|-----------|
| `status` | stan turnieju (patrz tabela statusów) |
| `is_paid` / `entry_fee` | turniej płatny: opłata wpisowa z realnego portfela |
| `prize_type` | `none` (tylko ranking) lub `sponsored` (nagroda sponsorowana przez serwis) |
| `prize_amount` | nagroda (tylko gdy `prize_type: sponsored`; inaczej `null`) |
| `virtual_start_capital` | kapitał wirtualny na start |
| `max_leverage` | maksymalna dźwignia |
| `fee_percent` | prowizja od każdej transakcji (w %) |
| `lending_fee_daily_percent` | opłata za finansowanie pozycji (dziennie, w %) |
| `markets` | rynki dopuszczone w turnieju |
| `join_until` | termin dołączenia (koniec - 48h; może być `null`) |
| `can_join` | serwer sam decyduje: `true` tylko w oknie zapisów |
| `players_count` | liczba zapisanych graczy |
| `ads` | slot reklamowy lub `null` |

Statusy turnieju: `draft` -> `registration_open` -> `running` -> `settling` ->
`finished` -> `archived`.

### 3.2. Szczegóły turnieju

```
GET /tournaments/{id}
```

Odpowiedź `200`: `{ "tournament": {...} }` (jak wyżej) plus informacja o tobie
(uwzględnia token, jeśli podany):

```json
{ "me": { "joined": true, "player_id": 1234 } }
```

gdy nie zapisany: `{ "me": { "joined": false } }`. `player_id` potrzebujesz do
wszystkich endpointow handlowych - zapisz go po dołączeniu.

### 3.3. Dołączenie do turnieju

```
POST /tournaments/{id}/join        (wymaga tokenu)
```

Bez ciała. Możliwe odpowiedzi:

- `201` - zapisano:

```json
{
  "message": "joined",
  "player": { "id": 1234, "cash_balance": "10000.00000000", "status": "active" }
}
```

- `422` - okno zapisów zamknięte (przed `start_registration_at` lub po `join_until`).
- `409` - już zapisany.
- `402` - brak środków na opłatę wpisową:

```json
{
  "message": "Niewystarczające środki",
  "code": "insufficient_balance",
  "wallet_balance": 10.0,
  "required": 25.0
}
```

Dołączenie do turnieju płatnego zdejmuje opłatę z realnego portfela. Do darmowych
turniejów (`is_paid: false`) dołączasz bez kosztu.

---

## 4. Handel

Wszystkie endpointy handlowe wymagają tokenu oraz `player_id` (z `/tournaments/{id}/join`
lub `/tournaments/{id}`). Dostęp do cudzego portfolio zwraca `403`.

Zasady silnika:

- Ceny wykonania liczy serwer z feedu (Redis) - żądania nie wpływają na cenę.
- Handel aktywny tylko gdy turniej ma status `running`; w innym stanie zlecenia
  zwracają błąd 422 ("Trading is not open").
- Rynek musi należeć do turnieju (i być aktywny) - inaczej 422.
- Pozycje liczą dźwignię `1..max_leverage` turnieju.
- Wartości (qty, kwoty, marża) wyliczane serwerowo - w polu `qty` albo `amount_usd`
  podajesz tylko jedno; serwer przelicza drugie po swojej cenie.

### 4.1. Złożenie zlecenia

```
POST /portfolios/{player}/orders
```

| Pole | Wymagane | Zasady |
|------|----------|--------|
| `market_id` | tak | id rynku z `markets` turnieju |
| `side` | tak | `long` (kupno) lub `short` (sprzedaż) |
| `type` | tak | `market`, `limit`, `tp`, `sl` |
| `qty` | nie* | ilość monet (liczba dodatnia) |
| `amount_usd` | nie* | kwota nominalna w USDT (serwer przelicza na qty) |
| `price` | zależnie | wymagany dla `limit`, `tp`, `sl` |
| `leverage` | nie | dźwignia, domyślnie 1 |
| `position_id` | dla tp/sl | id pozycji, do której odnosisz TP/SL |

\* dla `market` i `limit` wymagane jest `qty` LUB `amount_usd`.

**Typy zleceń:**

| Typ | Zachowanie |
|-----|------------|
| `market` | Wykonuje się natychmiast po aktualnej cenie z feedu. Odpowiedź `201`. |
| `limit` | Oczekuje (pending). Long wypełnia się gdy cena rynkowa <= `price`, short gdy >=. Odpowiedź `202`. |
| `tp` (take profit) | Wiąże się z otwartą pozycją (`position_id`). Domknięcie gdy cena pójdzie na zysk: long gdy mark >= `price`, short gdy <=. Cena musi być korzystniejsza niż entry (walidacja). |
| `sl` (stop loss) | Wiąże się z pozycją. Domknięcie gdy cena pójdzie na stratę: long gdy mark <= `price`, short gdy >=. Cena musi być gorsza niż entry. |

Odpowiedź `201` (wypełnione od razu):

```json
{
  "order": {
    "id": 5001,
    "market_id": 1,
    "market_symbol": "BTCUSDT",
    "type": "market",
    "side": "long",
    "qty": "0.10000000",
    "price": null,
    "status": "filled",
    "filled_price": "98000.00000000",
    "filled_qty": "0.10000000",
    "position_id": 321,
    "created_at": "2026-08-12T09:30:00+02:00"
  }
}
```

Odpowiedź `202` (zlecenie przyjęte do pending):

```json
{
  "order": { "id": 5002, "type": "limit", "side": "long", "qty": "0.50000000",
             "price": "95000.00000000", "status": "pending", "filled_price": null,
             "filled_qty": null, "position_id": null, "created_at": "..." }
}
```

**TP/SL częściowe:** `qty` w zleceniu tp/sl domyka tylko część pozycji (domyślnie
całość). `qty` nie może przekroczyć rozmiaru pozycji (422).

**Typowe błędy 422:**

- handel nieaktywny (turniej nie jest `running`)
- rynek niedostępny w turnieju
- dźwignia poza limitem turnieju
- brak `qty` ani `amount_usd`
- `price` wymagane dla `limit`/`tp`/`sl`
- nieprawidłowa cena stopu względem entry (TP w złą stronę)
- otwarta pozycja nie znaleziona (`position_id` błędny)
- brak środków (komunikat zawiera kwoty `need` i `available`)
- "Portfolio is busy, try again." (lock antirace - po prostu ponów)

### 4.2. Anulowanie zlecenia oczekującego

```
DELETE /orders/{orderId}
```

Anulować można tylko zlecenie ze statusem `pending` (422 w innym przypadku).
Odpowiedź `200` ze zleceniem: `{ "order": {...} }` (status `cancelled`).

### 4.3. Zamknięcie pozycji

```
POST /portfolios/{player}/positions/{positionId}/close
```

Bez ciała - domyka całą pozycję po aktualnej cenie rynkowej. Odpowiedź `200`:

```json
{
  "position": { "id": 321, "market_id": 1, "market_symbol": "BTCUSDT", "side": "long",
                "qty": "0.00000000", "entry_price": "98000.00000000",
                "mark_price": "99100.12345678", "leverage": "1.00000000",
                "liquidation_price": "0.00000000", "unrealized_pnl": "0.00000000",
                "margin_used": "0.00000000", "status": "closed",
                "realized_pnl": "110.12345678", "close_price": "99100.12345678" }
}
```

### 4.4. Symulacja TP/SL (estymacja PnL)

```
POST /portfolios/{player}/positions/{positionId}/estimate
```

| Pole | Wymagane | Zasady |
|------|----------|--------|
| `price` | tak | cena docelowa (liczba > 0) |
| `qty` | nie | ile domknąć (domyślnie całość; nie może przekroczyć pozycji) |

Czysty odczyt, bez mutacji. Odpowiedź `200`:

```json
{
  "estimate": {
    "position_id": 321, "price": "98000.00000000", "qty": "0.10000000",
    "gross_pnl": "100.00000000", "fee": "9.80000000",
    "lending_fee": "0.12345678", "net_pnl": "90.07654322"
  }
}
```

### 4.5. Moje zlecenia

```
GET /portfolios/{player}/orders
```

Odpowiedź: `{ "orders": [...] }` - ostatnie 50, od najnowszych. Statusy zleceń:
`pending`, `filled`, `cancelled`, `rejected`.

### 4.6. Moje transakcje

```
GET /portfolios/{player}/transactions
```

Odpowiedź: `{ "transactions": [...] }` - ostatnie 50 pozycji rejestru (ledger).
Typy: `open`, `close`, `liquidation`. Pole `public_at` ustawiane przy zamknięciu
(dane stają się publiczne).

### 4.7. Portfolio (pozycje + kapitał)

```
GET /portfolios/{player}
```

Odpowiedź `200` (wszystko przeliczone na żywej cenie z feedu):

```json
{
  "player": {
    "id": 1234, "tournament_id": 7, "status": "active",
    "cash_balance": "9500.00000000", "start_capital": "10000.00000000",
    "equity": "9610.50000000", "unrealized_pnl": "110.50000000"
  },
  "positions": [
    {
      "id": 321, "market_id": 1, "market_symbol": "BTCUSDT", "side": "long",
      "qty": "0.10000000", "entry_price": "98000.00000000",
      "mark_price": "99100.12345678", "leverage": "1.00000000",
      "liquidation_price": "0.00000000", "unrealized_pnl": "110.01234568",
      "margin_used": "9800.00000000", "status": "open",
      "realized_pnl": null, "close_price": null
    }
  ],
  "computed_at": "2026-08-12T09:31:05+02:00"
}
```

Definicje:

- `cash_balance` - wolne środki (kapitał - marża - prowizje + zrealizowane PnL)
- `equity` = `cash_balance` + suma `unrealized_pnl` wszystkich otwartych pozycji
- `mark_price` - aktualna cena serwerowa (live)
- `liquidation_price` - cena likwidacji (M6): long `entry * (1 - 1/leverage)`,
  short `entry * (1 + 1/leverage)`
- statusy pozycji: `open`, `closed`, `liquidated`, `forced_closed`

---

## 5. Dane rynkowe (publiczne)

### 5.1. Aktualna cena

```
GET /prices/{symbol}
```

`symbol` to para bez ukośnika, np. `BTCUSDT` (wielkość liter nie ma znaczenia).

Odpowiedź `200`:

```json
{ "symbol": "BTCUSDT", "price": 98000.5, "ts": 1783845060, "source": "binance" }
```

- `404` - nieznany symbol
- `503` - brak ceny z feedu

### 5.2. Świece (candles)

```
GET /candles?symbol=BTCUSDT&interval=5m&limit=200
```

| Parametr | Opcjonalny | Zasady |
|----------|------------|--------|
| `symbol` | nie | np. `BTCUSDT` |
| `interval` | tak | `1m` (domyślne), `5m`, `15m`, `30m`, `1h`, `4h`, `1d` |
| `limit` | tak | 1-1000, domyślnie 200 |

Odpowiedź `200`:

```json
{
  "symbol": "BTCUSDT", "interval": "5m", "source": "cache",
  "candles": [
    { "ts": 1783844700, "open": 98000.1, "high": 98100.0, "low": 97950.0,
      "close": 98050.2, "volume": 123.45 }
  ]
}
```

`source`: `cache` | `binance` | `db` - informacyjnie, nie steruj logiką.

---

## 6. Rankingi i profile graczy (publiczne)

### 6.1. Ranking turnieju

```
GET /tournaments/{id}/ranking
```

Odpowiedź `200`:

```json
{
  "tournament_id": 7,
  "computed_at": "2026-08-12T09:31:00+02:00",
  "ranking": [
    { "rank": 1, "player_id": 42, "nickname": "trader", "equity": "10250.50000000" }
  ]
}
```

Snapshoty liczone co minutę przez worker. Gdy brak snapshotu: `ranking: []`,
`computed_at: null`.

Uwaga: `player_id` w rankingu to **id użytkownika** (userId), nie id gracza
turniejowego. Do endpointów handlowych (`/portfolios/{player}/...`) używasz
`player_id` z odpowiedzi `/tournaments/{id}` (pole `me.player_id`) lub
`/tournaments/{id}/join` - to inna liczba.

### 6.2. Publiczny profil gracza

```
GET /players/{userId}/profile
```

Odpowiedź `200`:

```json
{
  "user": { "id": 42, "nickname": "trader", "joined_at": "2026-06-01T10:00:00+02:00" },
  "stats": { "tournaments_played": 3, "wins": 1, "best_rank": 1 },
  "participations": [
    { "tournament_id": 7, "tournament_name": "BTC Rally Sierpień",
      "status": "finished", "final_rank": 1, "equity": "15250.00000000", "prize": "500.00000000" }
  ]
}
```

### 6.3. Publiczne transakcje gracza

```
GET /players/{userId}/transactions?limit=50&offset=0&type=close
```

| Parametr | Opcjonalny | Zasady |
|----------|------------|--------|
| `limit` | tak | 1-200, domyślnie 50 |
| `offset` | tak | domyślnie 0 |
| `type` | tak | `open`, `close`, `liquidation` |

Odpowiedź `200`:

```json
{
  "user_id": 42, "count": 3,
  "transactions": [
    { "id": 9001, "position_id": 321, "tournament_id": 7,
      "tournament_name": "BTC Rally Sierpień", "market_symbol": "BTC/USDT",
      "type": "close", "side": "long", "qty": "0.10000000",
      "price": "99100.12345678", "fee": "9.91001235", "lending_fee": "0.02000000",
      "pnl_realized": "110.01234568", "public_at": "...", "created_at": "..." }
  ]
}
```

Transakcje są publiczne natychmiast po zamknięciu pozycji (`public_at`).
Otwarte pozycje i oczekujące zlecenia nigdy nie są publiczne.

---

## 7. Realny portfel (wymaga tokenu)

### 7.1. Saldo i historia

```
GET /me/wallet
```

```json
{
  "wallet": { "balance": "1250.50000000", "locked": "25.00000000", "currency": "USDT" },
  "transactions": [
    { "id": 1, "type": "deposit", "amount": "100.00000000",
      "balance_after": "100.00000000", "created_at": "..." }
  ]
}
```

- `balance` - środki dostępne
- `locked` - środki zablokowane (np. przez zgłoszoną wypłatę)
- typy transakcji portfela: `deposit`, `withdrawal`, `refund`, `tournament_fee` i inne

### 7.2. Wpłata przez Stripe

```
POST /me/deposits/stripe/session
```

| Pole | Wymagane | Zasady |
|------|----------|--------|
| `amount` | tak | liczba > 0 |

Odpowiedź: `{ "url": "https://checkout.stripe.com/...", "deposit_id": 15 }`.
Otwórz `url` w przeglądarce (Checkout); po zapłacie Stripe potwierdza wpłatę
webhookiem i środki zasilają portfel automatycznie. Status możesz śledzić na
`GET /me/deposits`.

### 7.3. Adres do wpłaty krypto

```
POST /me/deposits/crypto/address
```

| Pole | Wymagane | Zasady |
|------|----------|--------|
| `asset` | tak | `USDT` (siec TRC20) lub `USDC` (siec ERC20) |

Odpowiedź: `{ "address": { "address": "T...", "network": "trc20" } }`.

Użytkownik wysyła środki na ten adres; wpłata jest księgowana po potwierdzeniu
(`GET /me/deposits` pokazuje status i `confirmations`). Gdy krypto wyłączone - `422`.

### 7.4. Historia wpłat

```
GET /me/deposits
```

Odpowiedź: `{ "deposits": [...] }` - ostatnie 30. Pola: `method` (`stripe`/`crypto`),
`asset`, `amount`, `amount_credited`, `status`, `txid`, `confirmations`,
`credited_at`, `created_at`.

### 7.5. Dane do wypłaty (IBAN + posiadacz)

```
GET /me/payout-details
```

Odpowiedź: `{ "payout_iban": "...", "payout_holder": "..." }` (pola mogą być `null`).

```
PUT /me/payout-details
```

| Pole | Wymagane | Zasady |
|------|----------|--------|
| `payout_iban` | tak | maks. 34 znaki |
| `payout_holder` | tak | maks. 128 znaków |

Odpowiedź: zaktualizowane `{ "payout_iban", "payout_holder" }`.

### 7.6. Zgłoszenie wypłaty

```
POST /me/payouts
```

| Pole | Wymagane | Zasady |
|------|----------|--------|
| `amount` | tak | liczba > 0, nie mniejsza niż minimum serwisowe |

Odpowiedź `201`:

```json
{ "payout": { "id": 3, "method": "bank", "amount": "100.00000000",
              "fee": "2.00000000", "status": "pending", "usdt_address": null,
              "bank_details": { "iban": "PL...", "holder": "Jan Kowalski" },
              "txid": null, "created_at": "..." } }
```

Zasady:

- obecnie tylko metoda `bank` - środki idą na IBAN zapisany w profilu (7.5)
- zgłoszenie zdejmuje `amount + fee` z salda i blokuje `amount` w `locked`
- prowizja zależy od konfiguracji serwisu (procent + stała)
- błędy 422: `payments.details_required` (brak IBAN w profilu),
  `payments.payout_min` (za niska kwota), `payments.insufficient_balance`

Cykl wypłaty: `pending` -> `processing` -> `completed` | `rejected`.

### 7.7. Historia wypłat

```
GET /me/payouts
```

Odpowiedź: `{ "payouts": [...] }` - ostatnie 30, pola jak w 7.6.

---

## 8. Endpointy administracyjne

Wymagają tokenu użytkownika z rolą `admin` (`user.role === "admin"`, patrz `/me`).
Dla zwykłego użytkownika - `403`.

### 8.1. Lista i szczegóły turniejów (admin)

```
GET /admin/tournaments
GET /admin/tournaments/{id}
```

### 8.2. Tworzenie / edycja turnieju (admin)

```
POST /admin/tournaments
PUT /admin/tournaments/{id}
```

| Pole | Wymagane (POST) | Zasady |
|------|-----------------|--------|
| `name` | tak | max. 128 znaków |
| `virtual_start_capital` | tak | liczba >= 1 |
| `start_registration_at` | tak | data |
| `start_at` | tak | data, po `start_registration_at` |
| `end_at` | tak | data, po `start_at` |
| `market_ids` | tak | tablica id rynkow, min. 1, elementy muszą istnieć |
| `max_leverage` | nie | 1-100 |
| `fee_percent` | nie | 0-10 |
| `lending_fee_daily_percent` | nie | 0-10 |
| `entry_fee` | nie | >= 0 |
| `is_paid` | nie | boolean |
| `prize_type` | nie | `none` lub `sponsored` |
| `prize_amount` | nie | >= 0 |
| `prize_structure` | nie | tablica (schemat nagrod) |
| `rules` | nie | tablica (regulamin) |
| `is_ad_supported` / `is_featured` | nie | boolean |
| `tenant_id` | nie | id tenanta |

PUT jest częściowy - pominięte pola zachowują wartości.

### 8.3. Przejście statusu (admin)

```
POST /admin/tournaments/{id}/transition
```

| Pole | Wymagane | Zasady |
|------|----------|--------|
| `action` | tak | `start`, `settle`, `archive` |

`start` przesuwa `draft` -> `registration_open`, a po `start_at` do `running`.
`settle` ustawia `settling` (pełne rozliczenie zamyka pozycje i rozdziela nagrody).
`archive` ustawia `archived`.

### 8.4. Rynki (admin)

```
GET /admin/markets
POST /admin/markets
PUT /admin/markets/{id}
```

Pola rynku: `symbol` (max. 32, unikalny), `base_asset`, `quote_asset` (max. 16),
`exchange` (domyslnie `binance`), `status` (`active` | `paused`).

### 8.5. Wypłaty (admin)

```
GET /admin/payouts?status=pending
```

Odpowiedź: lista wypłat z użytkownikiem (`user: { id, nickname, email }`),
metoda, kwota, prowizja, status, dane bankowe, `txid`, `admin_note`.

```
POST /admin/payouts/{id}/action
```

| Pole | Wymagane | Zasady |
|------|----------|--------|
| `action` | tak | `approve` (pending -> processing), `complete` (processing -> completed, zwalnia locked), `reject` (zwraca srodki + prowizje) |
| `note` | nie | max. 500 znaków |
| `txid` | nie | max. 128 (przy `complete`) |

### 8.6. Ustawienia reklam (admin)

```
GET /admin/settings/ads
PUT /admin/settings/ads
```

Pola: `enabled` (boolean), `client` (pusty lub `ca-pub-...`).

### 8.7. Audyt (admin)

Każda mutacja admina jest logowana (`admin_audit_log`) - bez endpointu publicznego.

---

## 9. Endpointy pomocnicze

```
GET /health
```

Odpowiedź: status usługi (bazy, Redis, feed). `POST /webhooks/stripe` - wewnętrzny,
służy Stripe (weryfikacja sygnatury), nie używaj bezpośrednio.

---

## 10. Przepływy (use cases)

### 10.1. Logowanie i pobranie profilu

```
curl -X POST http://localhost:8080/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"trader@example.com","password":"secret123"}'
```

→ zapisz `token`, potem:

```
curl http://localhost:8080/api/me -H "Authorization: Bearer <token>"
```

### 10.2. Udział w turnieju (pełny cykl)

1. **Znajdź turniej:** `GET /tournaments` - szukaj `can_join: true`.
2. **Dołącz:** `POST /tournaments/{id}/join` (token). Dla `is_paid` sprawdź wczesniej
   `GET /me/wallet`; przy braku środków `402` - zasil portfel (10.6).
3. **Zapisz `player.id`** z odpowiedzi - potrzebny w handlu.
4. **Czekaj na start:** status zmieni się na `running` (`GET /tournaments/{id}`).
5. **Handluj** (10.3), **monitoruj pozycje** (`GET /portfolios/{player}`),
   **sprawdzaj ranking** (`GET /tournaments/{id}/ranking`).
6. **Po zakończeniu:** pozycje zostają zamknięte po ostatniej cenie
   (`forced_close`), wyniki i nagrody pojawiają się na profilu
   (`GET /players/{userId}/profile` - `final_rank`, `prize`).

### 10.3. Otwarcie i zamknięcie pozycji

Otwarcie rynkowe (long, 10x, kwota 1000 USDT):

```
curl -X POST http://localhost:8080/api/portfolios/1234/orders \
  -H "Authorization: Bearer <token>" -H "Content-Type: application/json" \
  -d '{"market_id":1,"side":"long","type":"market","amount_usd":1000,"leverage":10}'
```

Zlecenie limit (czeka na cenę 95000):

```
curl -X POST .../orders -d '{"market_id":1,"side":"long","type":"limit","qty":0.5,"price":95000}'
```

TP/SL dla pozycji 321 (long, TP 100000, SL 90000):

```
curl -X POST .../orders -d '{"market_id":1,"side":"long","type":"tp","position_id":321,"price":100000}'
curl -X POST .../orders -d '{"market_id":1,"side":"long","type":"sl","position_id":321,"price":90000}'
```

Sprawdź estymację przed ustawieniem stopa:

```
curl -X POST .../positions/321/estimate -d '{"price":90000}'
```

Zamknięcie ręczne:

```
curl -X POST .../positions/321/close
```

### 10.4. Aplikacja z wykresami

1. `GET /candles?symbol=BTCUSDT&interval=5m&limit=500` - historia do rysowania.
2. Odświeżaj świece co 15 s (tyle robi oficjalne SPA), a cenę live co 3 s
   (`GET /prices/BTCUSDT`) lub czekaj na `mark_price` w portfolio.
3. WebSocketów nie ma - polling jest oficjalnym mechanizmem.

### 10.5. Bot handlowy

Pętla robocza (przykładowe interwały):

1. co 5-10 s: `GET /prices/{symbol}` (lub `GET /portfolios/{player}` co 3-5 s dla
   equity i unrealized PnL);
2. po złożeniu zlecenia pending (`202`): `GET /portfolios/{player}/orders` co
   5-10 s, aż `status` zmieni się na `filled` / `cancelled` / `rejected` (wypełnienia
   realizuje worker co ~1 min + po każdym cyklu feedu);
3. likwidacje przetwarza ten sam worker - portfolio to zobaczy przy pollingu;
4. limit na zapytania: handel 30/min na zlecenia - grupuj operacje, nie spamuj;
5. przy 422 z komunikatem "Portfolio is busy, try again." - poczekaj ~1 s i ponów
   (lock antirace per portfolio, ważny 10 s).

### 10.6. Zasilenie portfela i wypłata

Wpłata Stripe:

```
curl -X POST http://localhost:8080/api/me/deposits/stripe/session \
  -H "Authorization: Bearer <token>" -H "Content-Type: application/json" \
  -d '{"amount":100}'
```

→ otwórz `url`; po zapłacie sprawdź `GET /me/deposits` (status płatności).

Wpłata krypto (USDT TRC20):

```
curl -X POST .../me/deposits/crypto/address -d '{"asset":"USDT"}'
```

→ wyświetl adres użytkownikowi; po przesłaniu śledź `GET /me/deposits`.

Wypłata (wymaga zapisanych danych w 7.5):

```
curl -X POST .../me/payouts -H "Content-Type: application/json" -d '{"amount":50}'
```

→ śledź `GET /me/payouts`: `pending` -> `processing` -> `completed` (lub
`rejected` - wtedy środki i prowizja wracają na saldo, a w historii pojawia się
transakcja `refund`).

### 10.7. Aplikacja mobilna - uwagi

- Token trzymaj w bezpiecznym magazynie (Keychain / Keystore / SecureStorage).
- Po `401` z dowolnego endpointu - wyczyść token i poproś o ponowne logowanie.
- Walutą portfela jest USDT (salda w stringach, 8 miejsc po przecinku).
- Nagłówek `X-Locale` pozwala ustawić język komunikatow (pl/en).
- Logowanie Google wymaga WebView + przechwycenia odpowiedzi callbacku.

---

## 11. Słownik statusów

| Encja | Wartości |
|-------|----------|
| Turniej | `draft`, `registration_open`, `running`, `settling`, `finished`, `archived` |
| Zlecenie | `pending`, `filled`, `cancelled`, `rejected` |
| Pozycja | `open`, `closed`, `liquidated`, `forced_closed` |
| Transakcja (ledger) | `open`, `close`, `liquidation` |
| Wypłata | `pending`, `processing`, `completed`, `rejected` |
| Rynek | `active`, `paused` |
| Użytkownik (rola) | `user`, `admin` |
| Typ zlecenia | `market`, `limit`, `tp`, `sl` |
| Strona | `long`, `short` |
| Typ nagrody | `none`, `sponsored` |

## 12. Ograniczenia i uwagi

- Tokeny nie wygasają same - wyloguj się, gdy użytkownik opuszcza aplikację.
- Handlować można wyłącznie w `running`; zapisy do `join_until` (koniec - 48h).
- Wszystkie decyzje biznesowe (okno zapisów, ceny, prowizje, likwidacje) podejmuje
  serwer - klient tylko renderuje i wysyła intencje.
- `amount_usd` przeliczany na ilosc po cenie serwerowej w momencie złożenia -
  finalna wartość pozycji może się różnić od podanej kwoty.
