# Projo – Discovery-Befunde

Stand: 2026-10-27 · Quelle: lesende Analyse mit echter Sitzung (`npm run discover`) + ein vorgeführter
Buchungsablauf (Training durch Vorführen, Request-Mitschnitt). Keine personenbezogenen Daten in dieser Datei –
IDs sind Platzhalter (`<user_id>`, `<booking_id>`, `<task_id>`, `<leaf_id>`, `<treaty_id>`).

## Technik & Sitzung

- Rails-Monolith (Heroku EU), serverseitig gerendert; Interaktion über **rails-ujs** (`data-remote`, `data-method`)
  und **best_in_place** – die meisten Schreib-Antworten sind server-generiertes JavaScript, das HTML einsetzt
  (`$("#show").html("…")`, `document.getElementById("show").innerHTML = "…"`).
- Login: `POST /login` (`session[email]`, `session[password]`, `authenticity_token`), SSO: `POST /auth/entra_id`.
- Cookie `_projo_session` wird **bei jedem Request neu gesetzt (rollierend, +14 Tage)** → täglicher Keep-alive
  hält die Sitzung dauerhaft aktiv.
- CSRF: `<meta name="csrf-token">`; XHR-Writes schicken `X-CSRF-Token` + `X-Requested-With: XMLHttpRequest`.
- Nach Login landet der Nutzer auf `/app/dates/today?user_id=<user_id>`; `/` → `/work/super_group_searches/<id>`
  (Bürobereich), `/app` → `/app/dates/<heute>`.
- Nutzer erkennbar an `#userDropdown` (Name + `.led[title]` = Online-Status), User-ID aus
  `/app/employees/<user_id>/contact_data` bzw. `user_id=`-Parametern.

## Navigation (Persönlicher Bereich)

| Menü | Route | Hinweis |
|---|---|---|
| Zeiten (Tag) | `GET /app/dates/<YYYY-MM-DD>?user_id=<user_id>` (`/app/dates/today`) | Buchungen eines Tages |
| Woche | `GET /app/weeks/index?date=<YYYY-MM-DD>&user_id=` | Raster Aufgabe × Tag |
| Monat | `GET /app/months?date=<YYYY-MM-DD>&user_id=` | Tage mit Buchungen, Soll/Ist, AZ-Konto |
| Jahr | `GET /app/years?date=<YYYY-MM-DD>&user_id=` | Monatsübersicht AZ-Konto |
| Stunden pro Projekt | `GET /app/bookings_analysis?user_id=&date=<TT.MM.JJJJ>&end_date=<TT.MM.JJJJ>` | Zeitraum frei |
| Projekte (Einsatzplanung) | `GET /app/planning2s` | „mich einem Projekt hinzufügen“ |
| Abwesenheit | `GET /app/absences` (Menülink selbst ist ein **PATCH** auf eine Nutzereinstellung) | Urlaubskonto + Liste |
| Reisekosten / Auslagen | `GET /app/travel_expense_reports?expense_report_type=travel_expense\|general_expense` | M2+ |
| Bürobereich Projekte | `GET /work/super_group_searches/<id>` (+ `/search?search=`) | M3 |

## Zeiten – Lesen

**Tagesansicht** `/app/dates/<datum>?user_id=`: Tabelle `Dauer | Leistung | Rechnungskommentar | (Aktionen)`.
- Zeile `tr#booking-<booking_id>` (`data-row-id`), Dauer im best_in_place-Span (`data-bip-attribute="duration_in_hour_min_str"`,
  `data-bip-value="02:00 h"`) bzw. als Text bei gesperrten Zeiten, Leistung als `span.label` (Text
  `<Vertragscode> - <Leistung>`, `title` = Leistungsname), Beschreibung im best_in_place-Span `description`.
- Summenzeile ohne ID. Gesperrte Tage: Dauer als reiner Text, Hinweis „Kommentar kann noch geändert werden, obwohl
  Zeiten gesperrt sind!“ (nur die Beschreibung bleibt editierbar).
- Kopf `#show > h2`: Vor/Heute/Zurück-Links und `a#datepicker` mit `current_date=<datum>` und
  `current_url=…/app/dates/<datum>` – das einzige sichere Merkmal für **Tage ohne Buchung in einem gesperrten
  Zeitraum** (Sperre je Person, z. B. „Arbeitszeit im Persönlichen Bereich bis zum <datum> gesperrt“ als `span[title]`
  im Kopf): dort fehlen Button „Zeitbuchung“ und Tabelle, ggf. steht die Abwesenheitsart im Kopf. Bis 2026-11 hielt der
  Parser solche Tage für eine geänderte Oberfläche (Drift → KI-Reserve, `degraded`).

**Monatsansicht** `/app/months?date=`: Kopf mit „Sollstunden (bis heute Abend)“, „Sollstunden (ab morgen)“,
„Gebuchte Stunden“, „Abwesenheiten“, „Differenz“, „AZ-Konto“; Tabelle `Tag | Gebuchte Stunden | AZ-Konto`,
Zeilen `tr.js-click-row[data-href=/app/dates/<datum>]` mit verschachtelter `table.slim-table`
(je Buchung: Dauer, Label mit vollem Namen im `title`, Beschreibung; `th[colspan=3]` = Tagessumme).
Keine Buchungs-IDs → für Änderungen die Tagesansicht nutzen.

**Woche** `/app/weeks/index?date=`: Formular `#new_time_tracking_week_form` (`PATCH /app/weeks/<datum>`),
Felder `bookings[<task_id>][<YYYY-MM-DD>]` mit Wert `"08:00 h"`; gesperrte Tage `disabled`.

## Zeiten – Auswahl der Leistung

- `GET /app/bookings/new?date=&user_id=` (Modal-Variante per XHR + `X-Projo-RenderType: modal`):
  Formular `#new_time_tracking_booking` → `POST /app/bookings?date=&user_id=` (`data-remote="true"`), Felder
  `time_tracking_booking[duration_in_hour_min_str]` (`"00:00 h"`, 15-min-Raster in der UI),
  `time_tracking_booking[task_id]` (select `#task_select`), `time_tracking_booking[description]`, `commit=Arbeitszeit buchen`.
- Das Task-Select enthält nur die Leistungen des **gefilterten Vertrags**. Der Vertragsfilter
  („Filtern auf Vertrag“) ist ein `PATCH /app/dates/<datum>/filter_treaty?filtered_treaty_id=<treaty_id>&user_id=`
  (XHR, Nutzereinstellung). Die **Antwort (JS) enthält das Leistungs-Select des Vertrags mit vollen Namen** – große
  HOAI-Verträge haben mehrere hundert Leistungen mit langen Pfaden („Leistungsstufe 2 - … - Standort“).
  `projo_time_options` nutzt das gezielt und stellt den Filter danach immer zurück: Die ID des aktiven Vertrags steht
  nicht im Chip, sondern im Link „alle Leistungen“ (`structure_bookings/new?treaty_id=`); ohne aktiven Vertrag =
  `filter_treaty?user_id=` ohne ID. Verträge und Leistungen unterscheiden sich je Person und Büro.
- Option: `value=<task_id>`, `data-time-tracking-leaf-url=/time_tracking/leaves/<leaf_id>`; „Pause“ hat `value=" "`.
- **Alle** buchbaren Leistungen: `GET /app/bookings/<booking_id>/edit_task?date=&user_id=` (XHR) liefert ein select2 mit
  allen Leistungen über alle Verträge (`<Vertragscode> - <voller Pfad ab Ebene 1>`, lange Namen in der Mitte mit „ ... “
  gekürzt – in großen HOAI-Verträgen rund 90 % der Einträge, anders sortiert als der Baum). Gleich endende Pfade sind
  dort nicht unterscheidbar (z. B. derselbe Standort unter verschiedenen Tätigkeiten); Optionen ohne `leaf_id`.
- **Leistungsbaum** je Vertrag („alle Leistungen“): `GET /app/structure_bookings/new?treaty_id=<treaty_id>&user_id=`
  (XHR) – funktioniert für **jeden** Vertrag der Person und ändert den Vertragsfilter nicht (nur lesend, geprüft am
  2026-11-09). Tabelle `table#treaty_tree`, je Zeile: Gliederungsnummer (`2.1.1.1.7`, Ebene = Anzahl der Teile),
  Name (Einrückung `padding-left` 0.5em + 1.2em je Ebene), Status-Badge (`laufend`, `nicht abrechenbar`, `fertig`,
  `auf Abruf`). Buchbare Leistungen tragen den Link `PATCH /app/structure_bookings/<leaf_id>/leaf_chosen` – dieselbe
  `leaf_id` wie im Leistungs-Select. Gruppen: `tr.big_leaf_group` ohne Link; nicht buchbar:
  `tr.text-decoration-line-through.hide` (`title="Leistung ist nicht buchbar"`). **Keine task_ids** im Baum.
- `projo_time_options` sucht deshalb im Baum (volle Namen, Pfad, Nummer, Status) und holt die task_ids nur für
  Verträge mit Treffern über den Vertragsfilter (Join über `leaf_id`); für den aktiven Vertrag reicht das Formular.
  Ein GET-Parameter (`filtered_treaty_id`, `treaty_id`) an `bookings/new` wechselt die Liste nicht – der Filter-PATCH
  bleibt der einzige Weg zu den task_ids anderer Verträge.
- Beschreibungs-Vorschläge: `GET /work/tasks/<task_id>/descriptions?q=` (≥ 2 Zeichen).

## Zeiten – Schreiben (aus dem Mitschnitt)

| Aktion | Request | Antwort |
|---|---|---|
| Anlegen | `POST /app/bookings?date=&user_id=` (XHR, `X-CSRF-Token`, Formularfelder s. o.) | 200 JS: neu gerenderte Tagesansicht |
| Leistung ändern | `PATCH /app/bookings/<booking_id>/update_task?date=&task_id=&user_id=` (XHR, ohne Body) | 200 JS: Tagesansicht |
| Dauer ändern | `PUT` (als `POST` + `_method=put`) `/app/bookings/<booking_id>?date=&user_id=`, Body `time_tracking_booking[duration_in_hour_min_str]=HH:MM h` + `authenticity_token`, `Accept: application/json` | **204** – auch bei ungültigem Wert |
| Beschreibung ändern | wie Dauer, Attribut `time_tracking_booking[description]` (best_in_place `textarea`) | 204 |
| Löschen | `DELETE /app/bookings/<booking_id>?date=&user_id=` (XHR) | 200 JS: Tagesansicht |
| Danach | `GET /app/dates/<datum>/refresh?user_id=` (XHR) | 200 JS: Tagesansicht |

**Wichtig:** Projo validiert serverseitig praktisch nicht – eine Buchung ohne Leistung und mit `00:00 h` wird
angelegt, ein ungültiger Dauerwert mit 204 quittiert. Das MCP-Tool muss deshalb selbst prüfen (Leistung Pflicht,
Dauer > 0 im 15-min-Raster) und nach jedem Write die Tagesansicht auswerten (Antwort oder `refresh`).

- **Gesperrte Zeiträume** (Sperre je Person, vom Büro fortgeschrieben, z. B. „bis zum 08.11.2026 gesperrt“): Die
  Oberfläche blendet nur Button „Zeitbuchung“, Löschen-Link und Dauer-Bearbeitung aus – `POST /app/bookings` und
  `DELETE /app/bookings/<id>` nimmt projo dort trotzdem an (beobachtet am 2026-11-12). Die Tools prüfen die Sperre
  deshalb selbst (Sperrhinweis im Tageskopf bzw. fehlender Button) und buchen, ändern oder löschen dort nicht.
- **Zukunft** lehnt projo ab: „Arbeitszeiterfassung für die Zukunft ist nicht möglich“ (Formularfehler) – die Tools
  prüfen das vorab, damit eine Sammelbuchung nicht mittendrin abbricht.

**CSRF:** Das Buchungsformular verschachtelt ein inneres Formular (`action="/time_tracking/bookings"`), dessen
`authenticity_token` ein *formularbezogenes* Token für dieses andere Ziel ist. Für `POST /app/bookings` reicht es
allein nicht – rails-ujs schickt zusätzlich das globale Token aus `<meta name="csrf-token">` als `X-CSRF-Token`.
Fehlt das, antwortet projo mit `200` und JavaScript `Turbo.visit("…/login")` (Request als „nicht angemeldet“
behandelt, Sitzung bleibt gültig). Der Session-Manager unterscheidet das per Kontroll-GET von echtem Sitzungsablauf.

Verifiziert am 2026-10-27 mit einer echten Testbuchung über die MCP-Tools: anlegen → Doppelbuchungsschutz →
Dauer, Beschreibung, Leistung ändern → löschen.

## Anmeldung „Mit Microsoft“ (Server-Browser)

Verifiziert am 2026-10-28 (lokal, kennwortlose Anmeldung per Authenticator-App):

- `POST /auth/entra_id` → `login.microsoftonline.com/common/oauth2/v2.0/authorize` (klassische Oberfläche:
  `input[name=loginfmt]` + `#idSIButton9`; das Passwortfeld `input[name=passwd]` liegt dort bereits unsichtbar per
  `.moveOffScreen` außerhalb des Bildschirms → Sichtbarkeit immer inkl. Viewport prüfen).
- Konten mit Passkey werden nach der E-Mail auf `login.microsoft.com/common/bridge/fido` geleitet – ein
  Server-Browser kann das nicht bedienen. Meldet der Browser **kein WebAuthn** (`PublicKeyCredential` undefined),
  fällt Microsoft auf die nächste Methode zurück: hier **„Anmeldung genehmigen“** mit Zahl in
  `#idRemoteNGC_DisplaySign` (Beschreibung `#idDiv_RemoteNGC_PollingDescription`), kein Passwort nötig.
- Push nach Passwort (Number Matching): `#idDiv_SAOTCAS_Description` + Zahl in `#idRichContext_DisplaySign`;
  Code: `input[name=otc]`; „Angemeldet bleiben?“: `#KmsiDescription`, Ja `#idSIButton9`, Nein `#idBtn_Back`.
- Danach Callback zu projo, die Sitzung steht. Gespeichert werden standardmäßig nur die projo-Cookies.
- Entwicklungsfalle: `tsx`/esbuild fügt Funktionen `__name()`-Aufrufe hinzu, die in `page.evaluate()` im Browser
  fehlen → Skripte für `evaluate` als Text übergeben.

## Gefährliche Links (nie automatisch auslösen)

- `DELETE /app/dates/<datum>` – „Arbeitszeiten des ganzen Tages löschen“
- `PATCH /user/users/<user_id>/change_online_status?…` – Online-Status
- `PATCH /user/settings/<id>?user_setting[absence_display_option]=…` – Ansichtseinstellungen
- `PATCH /user/settings/<id>/change_to_absence_list_and_redirect`, `PATCH …/leaf_chosen`
  (`PATCH …/filter_treaty` nutzt nur `projo_time_options` gezielt – mit Wiederherstellung)
- `POST /app/breaks?date=` – Pause anlegen
- `DELETE /logout`

## Abwesenheiten (für M2)

- `GET /app/absences` (`?filter_on_not_working=true|false&month=<YYYY-MM-01>`): Kopf „Urlaub <Jahr>“ mit Anspruch,
  Restbudget Vorjahr (Verfall), „Urlaubstage (<Jahr>)“, „genommen/genehmigt“, „beantragt“, „noch verfügbar“.
- Tabelle `Zeitraum | Tage | Status | Abwesenheitsart | Interne Anmerkung | Öffentliche Anmerkung | Vertretung`
  (Zeitraum z. B. „05. - 06.03.2026“, Tage „2 Tage“ bzw. „1 Tag von 5 Tage“ bei jahresübergreifenden Einträgen).
- Antrag: `GET /app/absences/new` (Formular noch nicht ausgewertet), Erklärung Anspruch:
  `/absence/german_vacation_budgets/explanation?user_id=&year=`.
- Ansichtswechsel (Liste/Auswertung/Jahr/mit Kollegen) sind `PATCH`-Nutzereinstellungen.

## Bürobereich / Projekte (für M3)

- `GET /work/super_group_searches/<id>`: Tabelle `Projekt | Status der Verträge | Kommentar | eigene Auftragssumme |
  Einsatzbudget | Leistungsstand | Rechnungsstand | Zahlungsstand`, Suche `GET …/search?search=`.
