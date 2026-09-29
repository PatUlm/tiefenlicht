# Spielmechanik – Tech-Prototyp v0.1

Dieses Dokument hält die Mechanik-Entscheidungen für v0.1 fest. Grundlage ist
`dungeon-game-concept.md` (Abschnitte 4, 15–21). Alles, was dort als „noch nicht
erforderlich“ markiert ist (Kampf, Würfel, Inventar, Klassen, Monster-KI, Persistenz,
Accounts), bleibt bewusst draußen.

**Die Festlegungen gelten nur für v0.1 und präjudizieren die offenen Punkte aus
Konzept §25 (Bewegungsregeln, Zugreihenfolge, Sichtlinien, Türen) nicht.**

Status: überarbeitet nach Review 01 (`docs/reviews/01-mechanics-review.md`),
Review 02 (`docs/reviews/02-core-review.md`) und Review 03
(`docs/reviews/03-server-client-review.md`). Übernahmen sind mit `[R: …]`, `[R2: …]`
bzw. `[R3: …]` markiert. Alle drei Reviews: keine Blocker; alle Major-Findings umgesetzt.

---

## M1 Spielbrett

- Das Brett ist ein logisches Raster aus quadratischen Feldern `(x, y)`.
  `x` wächst nach Osten, `y` nach Süden.
- Jedes **existierende** Feld gehört genau zu **einem Bereich** (`Area`). Bereiche sind
  Räume (`room`) oder Gänge (`corridor`). Blockieren ist eine Eigenschaft von Props und
  Monstern, nicht von Feldern. [R: m-1]
- **Wände liegen auf Feldkanten**, nicht auf Feldern (Brettspiel-Prinzip). Sie werden
  nicht gespeichert, sondern abgeleitet: Eine Kante ist eine Wand, wenn die beiden
  angrenzenden Felder nicht zum selben Bereich gehören (oder eines davon nicht existiert)
  **und** auf dieser Kante keine Tür liegt.
- **Türen liegen auf einer oder mehreren Kanten** zwischen orthogonal benachbarten Feldern
  zweier verschiedener Bereiche. Eine Tür mit zwei Kanten ist eine Doppeltür und wird
  als Einheit geöffnet. Zustand: `geschlossen` / `offen`. In v0.1 kein Schließen,
  Abschließen oder Aufbrechen. [R: M-1/A]
- **Props** (Säulen, Fässer, Sarkophag, Regale …) belegen ein oder mehrere Felder.
  Standard: blockierend. Nicht blockierend nur explizit (`blocking: false`).
  **Wanddeko** (Fackeln, Banner, Schilde) hängt an Kanten und hat keine Spielwirkung.
- Die Karte ist vollständig datengetrieben (JSON), damit ein späterer Editor sie erzeugen
  kann. Regelparameter (Bewegungspunkte, Aktionen) sind Teil der Karte. [R: m-2]

## M2 Figuren

- Zwei Heldenfiguren: **Zwerg** und **Dunkelelf**. Unterschiede nur Modell, Farbe, Name
  (Konzept §17). Identische Werte.
- Jeder Spieler steuert genau **eine** Figur. Slots sind 0-basiert (wie `heroStarts[].slot`):
  Slot 0 (Ersteller) → Zwerg, Slot 1 (Beitretender) → Dunkelelf. [R2: m-11]
- **Monster** sind statisch: kein eigener Zug, keine Bewegung, kein Angriff. Sie blockieren
  ihr Feld. Reaktion nur präsentational (Erwachen-Animation beim Aufdecken). [R: m-9]

## M3 Zugstruktur

- Strikt rundenbasiert, feste Reihenfolge: Slot 0 → Slot 1 → Slot 0 …
  Eine **Runde** ist abgeschlossen, wenn beide Spieler je einen Zug hatten.
- Das Spiel startet erst, wenn beide Spieler beigetreten sind. Slot 0 beginnt.
- Jeder Zug hat ein Budget (Kartenparameter, v0.1-Karte):
  - **8 Bewegungspunkte** (fest, kein Würfel). [R: M-1/A]
  - **1 Aktion**.
- Bewegung und Aktion sind frei kombinierbar (Konzept §4: Bewegung → Aktion →
  Restbewegung). Bewegung darf auf mehrere Teilbewegungen aufgeteilt werden.
- Ein Zug endet **nur explizit** durch „Zug beenden“. Nicht verbrauchte Punkte verfallen.
- UI-Hinweis „nichts mehr möglich“ (`canStillAct`): `true` genau dann, wenn mit der
  Restbewegung noch ein Feld erreichbar ist **oder** die Aktion verfügbar ist und eine
  geschlossene Tür von einem erreichbaren Feld (inkl. aktuellem) aus geöffnet werden kann.
  Sonst wird „Zug beenden“ hervorgehoben. Keine Server-Wirkung. [R: m-7]

## M4 Bewegung

- Nur **orthogonal** (4er-Nachbarschaft), keine Diagonalen. Jeder Schritt kostet 1 Punkt.
- Prüfreihenfolge für das Ziel (verrät nichts über Verborgenes) [R: m-3.3]:
  1. Ziel ist ein **entdecktes** Feld, nicht das aktuelle Feld, kein blockierendes Prop
     → sonst `INVALID_TARGET`.
  2. Ziel ist nicht von Monster oder anderem Helden belegt → sonst `TARGET_OCCUPIED`.
  3. Pfad existiert → sonst `UNREACHABLE`; Länge ≤ Restbewegung → sonst
     `NOT_ENOUGH_MOVEMENT`.
- Ein Schritt A→B ist erlaubt, wenn B entdeckt ist, kein blockierendes Prop und kein
  Monster trägt und die Kante A–B weder Wand noch geschlossene Tür ist.
- **Verbündete** Helden dürfen durchquert werden, das **Zielfeld** muss frei sein.
- Der Client schickt nur das **Zielfeld**. Der Server berechnet den kürzesten Pfad
  (BFS, deterministische Nachbar-Reihenfolge N, O, S, W) und liefert ihn zurück.
- Der Client nutzt dieselbe `game-core`-Funktion für Hervorhebung und Pfadvorschau;
  maßgeblich ist ausschließlich die Server-Prüfung.

## M5 Aktion „Tür öffnen“

- Voraussetzungen: Spieler ist am Zug, Figur gehört ihm, Tür ist geschlossen, Figur steht
  auf einem Feld, das an **eine** der Türkanten grenzt, Aktion noch verfügbar.
- Effekt: Tür wird dauerhaft offen, Aktion verbraucht. Alle an die Tür grenzenden
  Bereiche gelten als **entdeckt**.
- Danach darf die Restbewegung genutzt werden, auch durch die neue Tür.
- Kein automatisches Hinlaufen zur Tür in v0.1; die UI zeigt, ob die Tür nutzbar ist.

## M6 Sichtbarkeit / Fog of War

- Sichtbarkeit ist **bereichsbasiert** und für alle Spieler gemeinsam (kooperativ).
  Bewusste Vereinfachung statt Sichtlinienregel. [R: m-2]
- Initial entdeckt: nur die Eingangshalle. Ein Bereich wird entdeckt, sobald eine an ihn
  grenzende Tür geöffnet wird. Aufdecken ist endgültig.
- **Der Server filtert den Zustand**: Clients erhalten nur Felder, Props, Wanddeko und
  Monster entdeckter Bereiche sowie Türen, die an mindestens einen entdeckten Bereich
  grenzen. Zusätzlich [R: m-3]:
  - Das Karten-JSON wird **nie** vom Client importiert. Der Subpfad
    `@dungeon/game-core/content` ist nur unter der Export-Condition `node` definiert; ein
    Browser-Build (Vite) kann ihn nicht auflösen und bricht ab. [R2: m-1]
  - Türen tragen **neutrale IDs und Namen** (`door-1`, „Eisentür“), keinen Hinweis auf den
    Bereich dahinter. Der Türstil ist ein bewusster Teaser.
  - Ablehnungscodes unterscheiden nicht zwischen „verborgen“ und „existiert nicht“.
- **Zulässige Metadaten** (bewusst akzeptiert, sie verraten nur den Umfang, nicht den
  Inhalt) [R2: m-8]: `objective.totalAreas` (Fortschrittsanzeige „2/4 entdeckt“),
  fortlaufende Monster-IDs (Lücken deuten weitere Monster an) sowie `width`/`height` der
  Karte (Kamera-Begrenzung).
- Beim Aufdecken erhält der Client `AREA_REVEALED` und inszeniert:
  Boden → Wände → Props → Licht → Monster erwachen.

## M7 Spielziel (minimal, nicht blockierend) [R: M-2, m-5]

- Datengetriebene Siegbedingung, v0.1 nur ein Typ: `revealAllAreas`.
- Beim ersten Erreichen sendet der Server einmalig `GAME_WON`; die Clients zeigen
  „Gewölbe erkundet“ nach der Aufdeck-Inszenierung. **Das Spiel läuft weiter**:
  Bewegen und Zug beenden bleiben möglich, damit die zuletzt entdeckten Räume betreten
  werden können.
- **Neues Spiel** (`RESTART_GAME`): jeder der beiden Spieler jederzeit, solange die Partie
  läuft (UI mit Bestätigung). In der Wartephase (`waiting`) wird es mit `GAME_NOT_RUNNING`
  abgelehnt, weil es dort nichts zurückzusetzen gibt. [R2: m-13]
  Partie wird im selben Spiel mit denselben Slots und Tokens zurückgesetzt, `version` läuft
  weiter, das Spielziel gilt wieder als offen, alle Clients erhalten einen Snapshot ohne
  Inszenierung.

## M8 Karte v0.1

Koordinaten inklusive. Raster 20 × 20.

| Bereich | Typ | Felder | Initial |
|---|---|---|---|
| Eingangshalle | room, Theme `hall` | x 5–14, y 0–6 | entdeckt |
| Gang | corridor, Theme `corridor` | x 9–10, y 7–10 **und** x 3–16, y 11–12 (T-Form) | verborgen |
| Krypta | room, Theme `crypt` | x 1–8, y 13–19 | verborgen |
| Magierstube | room, Theme `mage` | x 11–18, y 13–19 | verborgen |

Türen (neutrale IDs):

| ID | Name | Kanten | Stil |
|---|---|---|---|
| door-1 | Große Doppeltür | (9,6)–(9,7) und (10,6)–(10,7) | grand |
| door-2 | Eisentür | (4,12)–(4,13) | iron |
| door-3 | Arkane Tür | (15,12)–(15,13) | arcane |

Startfelder: Zwerg (9,1), Dunkelelf (10,1), beide Blick Süden.

Props (alle blockierend, Größe 1×1 falls nicht angegeben):

| Bereich | Prop | Feld(er) |
|---|---|---|
| Halle | Säulen | (7,2), (12,2), (7,4), (12,4) |
| Halle | Statue | (14,3) |
| Halle | Fass / Kisten / Fässchen / Kisten | (5,0) / (14,0) / (5,6) / (14,6) |
| Gang | Fass / Geröll | (3,12) / (16,12) |
| Krypta | Sarkophag (1×2) | (4,16)–(4,17) |
| Krypta | Kerzen | (3,15), (5,15) |
| Krypta | Truhe / Geröll | (1,19) / (8,13) |
| Magierstube | Bücherregale | (11,15), (11,16), (18,13) |
| Magierstube | Tisch (2×1) | (14,16)–(15,16) |
| Magierstube | Kessel / Kristall | (12,18) / (17,18) |

Monster (statisch, nicht auf und nicht neben Tür-Anliegerfeldern):

| Bereich | Monster | Feld |
|---|---|---|
| Krypta | Grabwächter (Skelettkrieger) | (4,18) |
| Krypta | Knochenknecht (Skelett) | (7,15) |
| Magierstube | Aschemagier (Skelettmagier) | (16,17) |

Wanddeko (ohne Spielwirkung; Feld und Wandseite, an der sie hängt) [R2: m-12]:

| Bereich | Deko | Feld : Wandseite |
|---|---|---|
| Halle | Fackeln | (6,0) : N, (13,0) : N, (5,4) : W |
| Halle | Banner | (8,0) : N, (11,0) : N |
| Halle | Schild | (5,2) : W |
| Gang | Fackeln | (9,8) : W, (3,11) : W, (13,11) : N |
| Krypta | Fackeln | (1,14) : W, (1,18) : W |
| Krypta | Banner | (1,16) : W |
| Magierstube | Fackeln | (17,13) : N, (11,18) : W |
| Magierstube | Banner | (11,14) : W |

Erwarteter Ablauf mit 8 BP [R: M-1/A]: Zug 1 Zwerg öffnet Doppeltür und geht bis (9,9);
Zug 2 Elf bis (10,9); Zug 3 Zwerg öffnet Eisentür (genau 8 Schritte); Zug 4 Elf öffnet
Arkane Tür (genau 8 Schritte). Jeder Spieler erlebt einen Monster-Reveal in Runde 2.

**Kartenvalidierung** (`validateDungeon`, per Test auf die v0.1-Karte und beim
Serverstart) [R: M-3]. Sie wirft nie, sondern liefert eine Fehlerliste.

1. **Form** [R2: m-2]: alle Listen vorhanden, Koordinaten, Rechtecke und Größen
   ganzzahlig, Enum-Werte gültig (Richtung, Prop-, Monster-, Deko-Art, Türstil, Theme,
   Bereichsart), `slot` in 0–1, Regelparameter ≥ 1. Bei Formfehlern endet die Prüfung hier.
2. **Struktur und Spielbarkeit:** IDs eindeutig (auch Deko) · Bereiche disjunkt, nicht
   leer, im Raster · Türkanten orthogonal, zwischen zwei verschiedenen Bereichen, pro Tür
   genau ein Bereichspaar, höchstens zwei Kanten, bei zwei Kanten parallel und direkt
   benachbart [R2: m-10] · kein Feld doppelt belegt (Prop, Monster, Start) · Props
   vollständig in einem Bereich · Starts in initial entdeckten Bereichen und frei · alle
   Tür-Anliegerfelder frei von blockierenden Props und Monstern · Monster auch nicht
   neben Tür-Anliegerfeldern [R2: m-5] · pro Wandseite höchstens eine Deko, Deko hängt an
   einer Wand · bei offenen Türen jeder Bereich von jedem Start erreichbar ·
   Siegbedingung erfüllbar.

Zusätzlicher Regressionstest: Bei offenen Türen ist jedes freie Feld der v0.1-Karte vom
Start erreichbar (keine eingeschlossenen Taschen).

## M9 Netzwerk-, Autoritäts- und Sitzungsregeln

- Server ist autoritativ. Aktionen: `MOVE_CHARACTER`, `OPEN_DOOR`, `END_TURN`,
  `RESTART_GAME`.
- Jede Aktion wird geprüft auf: Partie läuft, Spieler am Zug (außer `RESTART_GAME`: nur
  Mitspieler), Figur gehört Spieler, aktionsspezifische Regeln (M4/M5).
- Eingang wird schema-validiert (Typ, ganzzahlige Koordinaten, ID-Format, Namenslänge,
  Framegröße ≤ 4 KiB). Ungültiges → `ERROR/BAD_MESSAGE`; keine Exception erreicht den
  Prozess. [R: m-4] Das Framelimit greift doppelt: `maxPayload` am WebSocket-Server und
  eine Längenprüfung im Parser. Unbekannte Aktionstypen lehnt auch `applyAction` ab,
  statt zu werfen. [R2: m-6, m-9]
- **Spielernamen** werden serverseitig bereinigt (Steuerzeichen entfernt, Tabs und
  Zeilenumbrüche zu Leerzeichen, Kürzung auf 20 Codepoints ohne zerschnittene Emoji),
  aber **nicht** HTML-maskiert. Clients rendern Namen deshalb ausschließlich als Text
  (`textContent`), nie per `innerHTML`. [R2: m-7]
- Erfolg → an **alle** Clients: Ereignisliste plus neuer, gefilterter Zustand mit
  steigender `version`. Fehler → nur an den Anfragenden: `ACTION_REJECTED` mit Code.
- Client: Ereignisse laufen durch eine Animations-Queue; neu entdeckte Bereiche bleiben
  bis zu ihrem `AREA_REVEALED`-Schritt unsichtbar; Eingaben sind gesperrt, solange die
  Queue läuft oder eine eigene Anfrage offen ist. Reconnect/Neustart liefert nur einen
  Snapshot ohne Inszenierung. [R: m-6]
  - Der Server spiegelt die `requestId` im `GAME_UPDATE` nur an den Auslöser; nur diese
    Antwort (oder `ACTION_REJECTED`) hebt die Eingabesperre auf. [R3: m-1]
  - Der Zielzustand eines Updates wird **immer** angewendet: Wirft oder hängt eine
    Animation (> 20 s), baut der Client den Zustand als Snapshot neu auf. [R3: M-1]
  - Spielaktionen werden bei Verbindungsverlust nicht gepuffert; „Neues Spiel“ nur bei
    bestehender Verbindung. Hotkeys wirken nicht in Dialogen, Buttons oder Eingabefeldern;
    „Zug beenden“ liegt nur auf der Leertaste. [R3: m-2, m-7]
- **Sitzung/Token** [R: M-4]:
  - Token wird serverseitig mit `crypto.randomUUID()` erzeugt, **nur** an den Besitzer
    gesendet und nie gebroadcastet. Client speichert es in `sessionStorage` (pro Tab).
  - Neue Verbindung mit gültigem Token **ersetzt** die alte; der alte Socket wird mit
    Code 4001 geschlossen und verbindet nicht automatisch neu.
  - Verbindungsverlust: Spieler bleibt im Spiel (getrennt markiert); das Spiel wartet.
  - **Slot-Übernahme:** Ist ein Spiel voll, aber ein Slot getrennt, darf ein Client ohne
    Token diesen Slot nach Bestätigung in der UI übernehmen (neues Token, altes ungültig).
    In der Wartephase wird eine Übernahme-Anfrage wie ein normaler Beitritt behandelt, der
    Platz des Erstellers bleibt geschützt. [R3: m-3]
    Bekanntes Risiko v0.1: Wer den Spielcode kennt, kann einen getrennten Platz übernehmen.
  - Spiele ohne verbundene Spieler werden nach 30 Minuten verworfen; max. 200 Spiele
    gleichzeitig. Unbekannte Spiele → `GAME_NOT_FOUND`. Trifft das einen Client beim
    (Wieder-)Verbinden, kehrt er mit Hinweis in die Lobby zurück. [R3: M-2]
- **Härtung** [R3: m-4, m-5, m-6, m-8]:
  - Nach 5 fehlgeschlagenen `JOIN_GAME`/`RESUME_SESSION`-Lookups wird der Socket
    geschlossen (Code 4008), um das Raten von Spielcodes und Tokens zu bremsen.
  - WebSocket-Verbindungen aus Browsern werden nur von derselben Origin (Host-Header)
    oder aus `ALLOWED_ORIGINS` angenommen.
  - Server und Vite binden standardmäßig nur an `127.0.0.1`; Docker setzt `HOST=0.0.0.0`.
  - Statische Auslieferung per `stream.pipeline` (kein Prozessabsturz bei Dateifehlern).
  - Der Debug-Handle `window.__dungeon` existiert nur im Dev-Build oder mit `?debug`.
  - **Bekannte v0.1-Grenzen vor einem öffentlichen Deployment (Konzept §22):** kein Limit
    für Spielerstellung pro IP, 5-stellige Spielcodes, keine TLS-Terminierung im Container
    (gehört in den Reverse Proxy).
