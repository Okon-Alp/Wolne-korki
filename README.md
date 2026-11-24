# Wolne Korki

Prosta aplikacja dla jednego korepetytora, którą stawiasz u siebie. Rodzice i uczniowie sami rezerwują wolne terminy, a lekcja online odbywa się w przeglądarce: kamera, wspólna tablica (Excalidraw) i czat. Po lekcji czekają notatki i materiały. Bez abonamentu, prowizji, reklam i śledzenia. Dane zostają na Twoim serwerze.

Otwarte oprogramowanie na licencji MIT.

## Co potrafi

**Dla korepetytora**
- Kalendarz tygodniowy z dostępnością, urlopami i lekcjami. Kliknięcie w puste pole dodaje lekcję.
- Lekcje cykliczne („co tydzień, 12 razy”). Kolizje są pomijane i wypisywane.
- **Dwie lekcje nigdy nie trafią na tę samą godzinę.** Pilnuje tego wyzwalacz w bazie danych, więc działa nawet przy równoczesnych rezerwacjach (jest na to test).
- Uczniowie i rodzice: jedno konto rodzica może mieć kilkoro dzieci, a każde dziecko może mieć własną stawkę.
- Zaproszenia linkiem (SMS, WhatsApp, Messenger). Bez wysyłania maili i bez konfiguracji SMTP. Ten sam mechanizm służy do resetu hasła.
- Notatka po lekcji, praca domowa i prywatne notatki. Wzory LaTeX (`$\frac{a}{b}$`) renderują się ładnie (KaTeX).
- Płatności bez bramki: odhaczasz „opłacona”, widzisz, kto ile jest winien, i masz przycisk „oznacz wszystko jako opłacone”.
- Raport miesięczny i kwartalny, eksport CSV (Excel/LibreOffice) i pasek limitu działalności nierejestrowanej.
- Odliczanie do egzaminu ósmoklasisty i matury na pulpicie (daty do zmiany w ustawieniach).
- Kalendarz `.ics` do subskrypcji w Google Calendar, iPhone czy Thunderbirdzie.

**Dla rodzica / ucznia**
- Wolne terminy na najbliższe tygodnie. Jedno kliknięcie, potwierdzenie i lekcja jest w kalendarzu.
- Odwołanie lekcji: do 24 h przed (do ustawienia) bez opłaty, później według zasad.
- Kwota do zapłaty razem z informacją, jak zapłacić (np. numer do BLIK-a).
- Notatki, praca domowa i materiały. Można też wgrać zdjęcie zeszytu z pracą domową.

**Lekcja online**
- Wideo 1:1 przez WebRTC, bezpośrednio między przeglądarkami. Bez instalowania czegokolwiek.
- Wspólna tablica oparta na [Excalidraw](https://github.com/excalidraw/excalidraw) (MIT), po polsku i w kratkę:
  - nieskończone płótno, kształty, strzałki, tekst, rysowanie odręczne i gumka;
  - zaznaczanie, przesuwanie i zmiana rozmiaru;
  - wklejanie zdjęć (np. zadania z podręcznika);
  - wskaźnik laserowy i kursor drugiej osoby.
- Obie osoby rysują naraz. Zmiany scalają się po pojedynczych elementach, tak jak w oficjalnej współpracy Excalidraw, ale przez Twój serwer.
- Tablica zapisuje się sama, wraca po odświeżeniu strony, a jednym kliknięciem trafia do materiałów lekcji (PNG).
- Udostępnianie ekranu, wyciszanie mikrofonu i kamery.
- Czat ze wzorami, zapisywany w historii lekcji.

## Czego celowo nie ma

To wersja do prywatnego użytku, dla jednego korepetytora i jego uczniów. Dlatego odpadły rzeczy potrzebne tylko w serwisie z wieloma nauczycielami:

- płatności online (Stripe, BLIK przez bramkę) i automatyczne zwroty, bo pieniądze idą prosto od rodzica do Ciebie;
- wypłaty dla nauczycieli, prowizje, bony podarunkowe i polecenia;
- wyszukiwarka nauczycieli, profile publiczne, opinie i wyróżnienia;
- rejestracja „z ulicy”, bo konta zakłada się wyłącznie z Twojego zaproszenia.

## Uruchomienie bez instalowania czegokolwiek (GitHub Codespaces)

Aplikacja potrzebuje serwera, bo ma bazę danych i łączy dwie osoby na lekcji. Do tego kamera działa w przeglądarce tylko przez HTTPS. Codespaces daje jedno i drugie za darmo, a całość klikasz w przeglądarce. Konto GitHub Free ma w cenie 120 „godzin rdzeniowych” miesięcznie, czyli **60 godzin** działania na standardowej maszynie 2-rdzeniowej, oraz 15 GB miejsca.

**Za pierwszym razem (ok. 10 minut):**

1. Załóż darmowe konto na <https://github.com> (jeśli jeszcze nie masz).
2. Wejdź na <https://github.com/codespaces/templates>, wybierz **Blank** i kliknij **Use this template**. W karcie przeglądarki otworzy się edytor z terminalem na dole.
3. Przeciągnij plik `wolne-korki.zip` z komputera do panelu plików po lewej stronie edytora.
4. W terminalu wpisz:
   ```bash
   unzip -q wolne-korki.zip && rm wolne-korki.zip && npm install --omit=dev && npm start
   ```
   Jeśli pojawi się komunikat o za starym Node.js, wpisz `nvm install 22` i powtórz ostatnią komendę.
5. W prawym dolnym rogu pojawi się okienko „Open in Browser”. Kliknij je (albo otwórz zakładkę **Ports** i kliknij ikonę globusa przy porcie 3000).
6. Jeśli zobaczysz błąd 404, poczekaj minutę i odśwież stronę.
7. Na stronie wpisz **kod konfiguracji** z terminala i załóż konto korepetytora.

**Żeby rodzice i uczniowie mogli wejść:** w zakładce **Ports** kliknij prawym przyciskiem port 3000 i wybierz **Port Visibility → Public**. Bez tego adres działa tylko dla Ciebie. Linki z zaproszeniami same używają poprawnego adresu `https://…app.github.dev`.

**Warto wiedzieć:**
- **Usypianie:** Codespace usypia się po okresie bezczynności, domyślnie po 30 minutach. Ruch na udostępnionym porcie się nie liczy. Aplikacja co minutę wypisuje do terminala „aktywność”, gdy ktoś z niej korzysta, i to powinno podtrzymywać środowisko podczas lekcji. Dla pewności ustaw dłuższy czas w **GitHub → Settings → Codespaces → Default idle timeout** (maks. 240 minut).
- **Uśpiony Codespace = wyłączona aplikacja.** Dopóki go nie uruchomisz ponownie na <https://github.com/codespaces>, rodzice nie zarezerwują lekcji. Po wznowieniu wpisz w terminalu `npm start`.
- **Dane** (baza, pliki) zostają w Codespace między uruchomieniami. Nieużywany, zatrzymany Codespace GitHub usuwa jednak domyślnie po 30 dniach, więc rób eksport CSV i kopię zapasową.
- **Repozytorium:** gdy chcesz mieć kod na GitHubie (np. pod stały hosting), na <https://github.com/codespaces> kliknij „…” przy swoim Codespace i wybierz **Publish to a new repository**. Kolejne Codespace utworzone z tego repozytorium uruchomią aplikację same (gotowa konfiguracja jest w `.devcontainer/`).

Codespaces świetnie nadaje się do wypróbowania i do pojedynczych lekcji. Do stałej pracy, kiedy rodzice rezerwują o dowolnej porze, potrzebny jest serwer działający cały czas (niżej).

## Na stałe w internecie

### Railway (też tylko przeglądarka)

1. Opublikuj kod jako repozytorium GitHub (punkt „Repozytorium” wyżej).
2. Na <https://railway.com> zaloguj się kontem GitHub, kliknij **New Project → Deploy from GitHub repo** i wybierz repozytorium. Railway sam zbuduje aplikację z `Dockerfile`.
3. W usłudze dodaj **Volume** zamontowany w `/data`. Tam będzie baza i pliki.
4. W **Variables** ustaw:
   - `TRUST_PROXY=1`
   - `RAILWAY_RUN_UID=0` (Railway montuje wolumeny jako root, a bez tego aplikacja nie zapisze bazy)
   - `PUBLIC_URL` = adres z kroku 5
5. W **Settings → Networking** kliknij **Generate Domain**. Dostaniesz adres `https://…up.railway.app`.
6. Kod konfiguracji znajdziesz w **Deploy Logs**.

**Koszt:** darmowy plan to 30-dniowy okres próbny z 5 USD kredytu, potem 1 USD zużycia miesięcznie (do 0,5 GB RAM i 0,5 GB na wolumen). Plan Hobby kosztuje 5 USD miesięcznie i tyle zużycia obejmuje. Ta aplikacja jest mała, ale czy zmieści się w darmowym limicie, sprawdzisz dopiero po tygodniu działania.

### Własny serwer albo komputer (Node.js lub Docker)

Na Linuksie wystarczy Node.js w wersji **22.13 lub nowszej**. Rozpakuj zip do osobnego folderu i w nim uruchom:

```bash
npm install --omit=dev
npm start
```

Albo przez Dockera:

```bash
docker compose up -d --build
docker compose logs wolne-korki   # tu znajdziesz kod konfiguracji
```

Dostęp z internetu wymaga HTTPS. Najprościej postawić aplikację za [Caddy](https://caddyserver.com/), który sam załatwi certyfikat:

```
# Caddyfile
korki.twoja-domena.pl {
    reverse_proxy localhost:3000
}
```

i ustawić `PUBLIC_URL=https://korki.twoja-domena.pl` oraz `TRUST_PROXY=1`. Bez domeny wystarczy domowy komputer albo Raspberry Pi i darmowy tunel (Cloudflare Tunnel, Tailscale Funnel).

### Zmienne środowiskowe

| Zmienna | Domyślnie | Opis |
|---|---|---|
| `PORT` | `3000` | port serwera |
| `HOST` | `0.0.0.0` | adres nasłuchu |
| `PUBLIC_URL` | (z nagłówków; w Codespaces wykrywany sam) | publiczny adres, używany w linkach z zaproszeniami i w `.ics` |
| `TRUST_PROXY` | (wył.; w Codespaces wł.) | `1`, gdy aplikacja stoi za reverse proxy |
| `DATA_DIR` | `./data` | baza `wolne-korki.db` i katalog `uploads/` |
| `SETUP_CODE` | (losowy) | stały kod pierwszej konfiguracji |
| `MAX_UPLOAD_MB` | `25` | limit wielkości pliku |
| `MAX_CLIENT_STORAGE_MB` | `100` | ile miejsca na pliki może zająć jedna rodzina |
| `ACTIVITY_LOG` | (wył.; w Codespaces wł.) | `1` = co minutę wpis „aktywność”, gdy ktoś korzysta z aplikacji |

## Wideo: STUN i TURN

Wideo płynie bezpośrednio między przeglądarkami, nie przez Twój serwer. Domyślny serwer STUN (Google) pomaga tylko ustalić adres sieciowy i nie widzi obrazu ani dźwięku. Adres zmienisz w **Ustawienia → Lekcje online**.

W części sieci (szkolne Wi-Fi, niektórzy operatorzy komórkowi) bezpośrednie połączenie się nie uda. Wtedy potrzebny jest serwer TURN, który przekaże obraz. Przykład z [coturn](https://github.com/coturn/coturn):

```
# /etc/turnserver.conf
listening-port=3478
fingerprint
lt-cred-mech
user=korki:ZMIEN_TO_HASLO
realm=korki.twoja-domena.pl
```

Wtedy w ustawieniach aplikacji wpisz:

```json
[
  { "urls": "stun:korki.twoja-domena.pl:3478" },
  { "urls": "turn:korki.twoja-domena.pl:3478", "username": "korki", "credential": "ZMIEN_TO_HASLO" }
]
```

Te dane widzi przeglądarka każdego zalogowanego ucznia. Przy prywatnym użyciu to nie problem, ale użyj osobnego hasła, nie żadnego ze swoich.

Jako zapas możesz też podać w ustawieniach stały link do pokoju Jitsi albo Google Meet. Pojawi się w pokoju lekcji jako „Zapasowe wideo”.

## Kopie zapasowe

Wszystko jest w katalogu danych: plik `wolne-korki.db` i katalog `uploads/`. Bezpieczna kopia w trakcie działania:

```bash
sqlite3 data/wolne-korki.db ".backup 'kopia-$(date +%F).db'"
tar czf uploads-$(date +%F).tgz data/uploads
```

## Prywatność i dane dzieci

- Dane leżą wyłącznie na Twoim serwerze. Strona nie ładuje zewnętrznych skryptów, fontów ani analityki. KaTeX oraz tablica razem z czcionkami Excalidraw są serwowane lokalnie, a nagłówki CSP blokują wszystko spoza Twojej domeny.
- Zbierasz tylko to, co potrzebne: imię ucznia, opcjonalnie poziom i przedmiot. Nazwisko, PESEL czy data urodzenia dziecka nie są potrzebne.
- Hasła są hashowane (scrypt, parametry wg OWASP). Sesja trzymana jest w ciasteczku `HttpOnly` i `SameSite=Lax` (przez HTTPS z flagą `Secure`). Aplikacja ma ochronę CSRF i limity: nieudanych logowań, zapytań, miejsca na pliki rodziny, rezerwacji i wiadomości w pokoju lekcji.
- Aplikacja przeszła testy penetracyjne (wyniki, model zagrożeń i sposób zgłaszania luk opisuje [SECURITY.md](SECURITY.md)).
- Rodzic widzi wyłącznie swoje dzieci, lekcje i materiały (są na to testy).
- Wgrane pliki HTML/SVG nigdy nie otwierają się jako strona, tylko pobierają się jako plik.
- Usunięcie klienta kasuje jego konto, uczniów, lekcje, notatki, materiały i czat. Przed usunięciem możesz pobrać CSV do rozliczeń.
- Jako korepetytor jesteś administratorem tych danych. W ustawieniach jest miejsce na zasady, które rodzic widzi przy zakładaniu konta.

## Rozliczenia

Raport liczy **przychód** jako odbyte lekcje plus opłaty za późne odwołania, według daty lekcji. Osobno liczy **wpłaty** według dnia oznaczenia lekcji jako opłaconej. Pasek limitu domyślnie pokazuje kwartalny limit działalności nierejestrowanej na 2026 r.: 10 813,50 zł, czyli 225% płacy minimalnej. Kwotę zmienisz w ustawieniach. Co roku sprawdź aktualną wartość. To pomoc w liczeniu, nie porada podatkowa.

## Dla programistów

- Backend: Node.js 22+, Express 5, `node:sqlite`, `ws`. Bez ORM-a i bez natywnych modułów.
- Frontend: czysty JavaScript (moduły ES), bez kroku budowania. Szablony automatycznie escapują dane.
- Tablica: React + Excalidraw, zbudowane esbuildem do `public/board/`. Gotowa paczka jest w repozytorium, więc do uruchomienia wystarczy `npm install --omit=dev`. Po zmianach w `board-src/` uruchom `npm install && npm run build`. Build podmienia zapasowy CDN czcionek Excalidraw na Twój serwer i zbiera licencje bibliotek do `public/board/THIRD_PARTY_LICENSES.txt`.
- Czasy w bazie są w UTC (ms). Dostępność trzymana jest w czasie lokalnym korepetytora (`Europe/Warsaw`), a zmiany czasu letni/zimowy są obsłużone przez `Intl`.

```
src/
  server.js   start serwera, nagłówki bezpieczeństwa, Codespaces, log aktywności
  api.js      REST API
  db.js       schemat, wyzwalacz blokujący kolizje, ustawienia
  slots.js    liczenie wolnych terminów
  room.js     WebSocket: sygnalizacja WebRTC, synchronizacja tablicy, czat
  auth.js     hasła, sesje, CSRF, limit logowań
  ical.js     kanał kalendarza .ics
board-src/    komponent tablicy (Excalidraw) i jego synchronizacja
public/js/
  app.js      router
  lib.js      szablony, API, daty, okna dialogowe
  room.js     pokój lekcji; rtc.js wideo
  views/      ekrany korepetytora, rodzica i wspólne
test/         testy end-to-end API i pokoju (npm test)
```

```bash
npm test      # 18 testów: rezerwacje równoległe, uprawnienia, odwołania, płatności, tablica, proxy, regresje z pentestu…
npm run dev   # restart po zmianie plików
```

## Licencja

MIT, zobacz [LICENSE](LICENSE). Biblioteki zawarte w tablicy mają własne licencje (głównie MIT), wypisane w `public/board/THIRD_PARTY_LICENSES.txt`. Niezależny projekt open source, niepowiązany z żadnym komercyjnym serwisem korepetycji.
