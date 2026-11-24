# Bezpieczeństwo

## Zgłaszanie podatności

Znalazłeś lukę? Nie zakładaj publicznego zgłoszenia (issue). Użyj prywatnego zgłoszenia w repozytorium: **Security → Report a vulnerability**. Właściciel repozytorium musi je raz włączyć w **Settings → Code security → Private vulnerability reporting**.

## Co chronimy i przed kim

Aplikacja przechowuje dane dzieci i rodziców: imiona, terminy lekcji, notatki, materiały, czat i rozliczenia. Zakładamy czterech przeciwników:

| Kto | Czego może próbować |
|---|---|
| Anonim z internetu | przejęcie świeżej instancji, zgadywanie haseł, sprawdzanie, czy konto istnieje, przeciążenie serwera |
| Złośliwy rodzic (zalogowany) | podgląd cudzych dzieci i lekcji, uprawnienia korepetytora, złośliwe pliki i treści (XSS), zapchanie dysku, kalendarza i pokoju lekcji |
| Obca strona otwarta w przeglądarce zalogowanej osoby | działania w jej imieniu (CSRF), podsłuch lekcji przez WebSocket |
| Ktoś z dostępem do kopii bazy | odzyskanie haseł |

## Zabezpieczenia

- **Hasła:** scrypt z parametrami według OWASP (N=2^14, r=8, p=5), z solą. Starsze hashe są przeliczane przy logowaniu. Czas odpowiedzi logowania nie zdradza, czy konto istnieje.
- **Sesje:** losowy token w ciasteczku `HttpOnly` i `SameSite=Lax` (przez HTTPS z flagą `Secure`). Na serwerze trzymany jest tylko skrót tokenu. Wylogowanie i zmiana hasła unieważniają sesje.
- **Pierwsza konfiguracja:** wymaga jednorazowego kodu z logów serwera.
- **CSRF:** zmiany wymagają własnego nagłówka i zgodnego nagłówka `Origin`. WebSocket przyjmuje tylko połączenia z własnej domeny.
- **Uprawnienia:** każdy dostęp do lekcji, ucznia i materiału sprawdza, czy należy do zalogowanego rodzica. Funkcje korepetytora są dostępne tylko dla roli korepetytora.
- **Limity:**
  - nieudane logowania (na e-mail i na IP);
  - liczba zapytań do API;
  - wgrywanie i pobieranie plików;
  - miejsce na pliki jednej rodziny (`MAX_CLIENT_STORAGE_MB`, domyślnie 100);
  - liczba przyszłych rezerwacji rodzica (ustawienie, domyślnie 12);
  - wiadomości w pokoju lekcji;
  - rozmiar tablicy.
- **Dane wejściowe:**
  - zapytania SQL tylko z parametrami;
  - pola jednowierszowe bez znaków sterujących;
  - wyrażenia regularne odporne na ReDoS;
  - eksport CSV neutralizuje formuły;
  - kalendarz `.ics` nie pozwala wstrzyknąć pól.
- **Treści w przeglądarce:** szablony automatycznie escapują dane, a markdown dopuszcza tylko linki `http(s)`. KaTeX działa bez opcji `trust`.
- **Nagłówki:**
  - restrykcyjne CSP (`script-src 'self'`, WebSocket tylko do własnego hosta, brak zewnętrznych zasobów);
  - `X-Frame-Options`;
  - COOP i CORP;
  - `Referrer-Policy: no-referrer`;
  - HSTS przy HTTPS;
  - `Cache-Control: no-store` dla API.
- **Pliki:** zapisywane pod losowymi nazwami. Wszystko poza obrazkami i PDF jest pobierane jako `application/octet-stream`, z `nosniff` i `CSP sandbox`.
- **Zależności:** `npm audit` bez zgłoszeń. Podatne pakiety wewnątrz Excalidraw są wymuszone na wersje z poprawkami (`overrides` w `package.json`). Build tablicy usuwa adresy zewnętrzne i nieużywaną konfigurację Firebase.

## Testy penetracyjne (24.11.2026)

Testowana była lokalna instancja, czarną skrzynką (HTTP, WebSocket, przeglądarka) i przeglądem kodu. Testy wykonało to samo narzędzie, które napisało kod (Claude), więc nie zastępują niezależnego audytu.

**Znalezione i naprawione:**

| Problem | Waga | Poprawka |
|---|---|---|
| E-mail sprawdzany wyrażeniem o kwadratowym czasie (ReDoS): 20 tys. znaków zajmowało serwer ponad 3 minuty | wysoka | limit długości i wyrażenie liniowe |
| Wstrzykiwanie pól do kalendarza `.ics` przez temat lekcji (samotny znak CR) | średnia | usuwanie znaków sterujących przy zapisie i w `.ics` |
| CSV injection: formuła z tematu lekcji aktywna w Excelu korepetytora | średnia | apostrof przed `= + - @` |
| Brak limitu wiadomości w pokoju (3000 wiadomości czatu na sekundę zapisanych w bazie) | średnia | limity na połączenie |
| Brak limitu rozmiaru tablicy (47 MB zapisane w bazie) | średnia | limit elementu i całej tablicy, komunikat dla użytkownika |
| Brak limitu miejsca na pliki rodziny (115 MB w kilka sekund) | średnia | limit na rodzinę |
| Czas logowania zdradzał istnienie konta (59 ms vs 3 ms) | niska | sprawdzanie hasła zawsze, także na losowym hashu |
| Parametry scrypt słabsze od minimum OWASP (p=1) | niska | p=5 i przeliczanie starych hashy |
| CSP dopuszczało WebSocket do dowolnego hosta, brak COOP/CORP i `no-store` w API | niska | nagłówki uzupełnione |
| Brak limitu rezerwacji jednego rodzica | niska | ustawienie, domyślnie 12 |
| Limity zapytań własnej roboty, nierozpoznawane przez CodeQL | informacyjna | `express-rate-limit` |

**Sprawdzone bez uwag:**
- dostęp do cudzych danych (IDOR) dla wszystkich ścieżek API i WebSocket;
- eskalacja roli;
- CSRF i CSWSH;
- SQL injection;
- prototype pollution;
- XSS w imionach, tematach, materiałach, czacie, nazwach plików, linkach markdown i wzorach LaTeX;
- złośliwe pliki (HTML, SVG, fałszywe obrazki, path traversal, CRLF w nazwie);
- unieważnianie sesji;
- brute force;
- wyścig przy pierwszej konfiguracji.

Testy regresji tych poprawek są w `test/api.test.js` (`npm test`).

## Znane ograniczenia

- Domyślny serwer STUN (Google) widzi adresy IP uczestników lekcji. Własny serwer STUN/TURN ustawisz w ustawieniach.
- Dane do serwera TURN są widoczne dla zalogowanych uczniów. Użyj osobnego hasła.
- Adres kalendarza `.ics` działa bez logowania (tak działają subskrypcje kalendarzy). W razie wycieku wygeneruj nowy na stronie Konto.
- Wideo jest szyfrowane przez WebRTC (DTLS-SRTP) bezpośrednio między przeglądarkami. Serwer TURN, jeśli go użyjesz, przekazuje zaszyfrowany strumień.
- Bezpieczeństwo całości zależy też od hostingu: aktualnego systemu, HTTPS i kopii zapasowych.
