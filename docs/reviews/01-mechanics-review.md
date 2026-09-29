# Review 01 – Spielmechanik v0.1

Gegenstand: `docs/game-mechanics.md` (Entwurf), geprüft gegen `dungeon-game-concept.md`
(v. a. §4, §15–21, §25). Datum: 2026-09-29. Rolle: Review-Agent Spielmechanik.

## Gesamturteil

Solider, gut abgegrenzter Entwurf. Die Kernregeln (Kanten-Wände, Kanten-Türen, BFS-Pfad
serverseitig, bereichsbasierter Fog of War, Server-Filterung) sind konsistent und passen zu
§7, §18, §19 und §21. **Keine Blocker.** Die Geometrie in M8 ist gültig: alle Türen liegen
auf echten Bereichsgrenzen, alle Bereiche sind erreichbar, die angegebene Distanz von 5 ist
korrekt. Handlungsbedarf gibt es vor allem in vier Punkten:

1. das **Pacing** der Demo: erster Gegner frühestens in Zug 5, drei von sechs Zügen sind
   reines Laufen,
2. das **harte Spielende** direkt nach dem letzten Aufdecken: Es entwertet den stärksten
   Moment,
3. **fehlende Prop- und Monster-Koordinaten plus fehlender Karten-Validator**, dadurch
   Softlock-Risiko,
4. **Reconnect-Lücken**: sessionStorage plus Abweisung einer dritten Verbindung macht ein
   Spiel unrettbar.

Scope ist eingehalten. Einzige echte Erweiterung ist M7 (siehe M-2).

---

## Geometrie-Nachrechnung M8

Per BFS nachgerechnet (orthogonal, alle Türen offen, keine Props/Monster, da keine
Koordinaten angegeben sind).

**Gültigkeit**

- Die Bereiche sind disjunkt und liegen im 20×20-Raster (max. x = 18, max. y = 19).
  Feldanzahl: Halle 70, Gang 36, Krypta 56, Magierstube 56.
- Alle drei Türkanten sind orthogonal benachbart und trennen verschiedene Bereiche:
  - (9,6)–(9,7): Halle | Gang
  - (4,12)–(4,13): Gang | Krypta
  - (15,12)–(15,13): Gang | Magierstube
- Stamm (x 9–10, y 7–10) und Querbalken (y 11–12) gehören zum selben Bereich. Die Kanten
  (9,10)–(9,11) und (10,10)–(10,11) sind deshalb offen, die T-Form funktioniert.
- Zwischen verschiedenen Bereichen gibt es 14 Grenzkanten, 3 davon sind Türen. Nach der
  M1-Regel ist der Rest Wand. Das ist korrekt; es entstehen keine ungewollten Durchgänge.

**Distanzen (Schritte)**

| von | → (9,6) Hallenseite große Tür | → (4,12) vor Kryptator | → (15,12) vor Arkaner Tür |
|---|---|---|---|
| Zwerg (9,1) | **5** ✓ | 16 | 17 |
| Dunkelelf (10,1) | **6** (= volles Budget) | 17 | 18 |
| (9,7) Gangseite | – | 10 | 11 |

Das weiteste Feld vom Start ist (11,19) mit 28 Schritten.

**Optimaler Ablauf mit 6 BP (aktueller Stand)**

| Zug | Figur | Ablauf |
|---|---|---|
| 1 | Zwerg | 5 → (9,6), öffnet große Tür (Gang), 1 → (9,7) |
| 2 | Elf | 6 → (9,6). Der Gang ist mit 7 Schritten nicht erreichbar. |
| 3 | Zwerg | 6 Schritte Richtung Krypta, noch 4 übrig |
| 4 | Elf | 6 Schritte Richtung Arkaner Tür, noch 6 übrig |
| 5 | Zwerg | 4 Schritte, öffnet Kryptator. **Erster Gegner.** |
| 6 | Elf | 6 Schritte, öffnet Arkane Tür, 0 BP. **GAME_WON**, Spiel gesperrt |

Engstellen: Die große Tür ist eine einzelne Kante auf dem linken Fahrstreifen eines 2 Felder
breiten Stamms. Wegen der Verbündeten-Durchquerung entsteht zwischen den Helden kein
Softlock, der Elf zahlt aber einen Umweg (siehe M-1, m-8).

---

## Findings

### Blocker

Keine.

### Major

#### M-1 Pacing: Der Entdeckungsmoment kommt zu spät und ist ungleich verteilt

- **Bezug:** M3 (6 BP), M8. Konzept §15, §18 (Schritte 10–15 in *einem* Zug), §19, §21
  (letzter Punkt).
- **Problem:**
  - Die erste Tür deckt nur den leeren Gang auf. Der erste Gegner erscheint frühestens in
    Zug 5, also Runde 3.
  - Die Züge 2, 3 und 4 bestehen nur aus Laufen.
  - Der Elf hat in Runde 1 und 2 nichts zu tun außer Laufen.
  - §18 skizziert den Kernablauf „Tür → Raum → Licht → Gegner“ als Erlebnis *eines* Zuges.
    M8 streckt ihn auf drei Runden.
- **Vorschlag** (Variante wählen; alle Werte nachgerechnet):
  - **A (empfohlen):** Bewegung **8 BP** und große Tür als **Doppeltür** über beide
    Stammkanten (9,6)–(9,7) und (10,6)–(10,7). Starts bleiben.
    - Zug 1: Zwerg öffnet nach 5 Schritten und läuft weiter nach (9,9).
    - Zug 2: Elf läuft nach (10,9).
    - Zug 3: Zwerg öffnet die Krypta (genau 8 Schritte).
    - Zug 4: Elf öffnet die Magierstube (genau 8 Schritte).
    - Ergebnis: jeder Spieler hat einen Gegner-Reveal, beide in Runde 2.
    - Die Doppeltür passt zudem zur „großen Holztür“ (§16) und zum Modul „Double Door 2“
      (§12).
    - Kosten: Türmodell braucht Mehrkanten-Türen (`edges: Edge[]`) oder eine gekoppelte
      Türgruppe.
  - **B:** 6 BP beibehalten, Doppeltür, Starts auf (9,5)/(10,5). Ebenfalls Reveals in
    Runde 2 (Zwerg 12, Elf 12 Schritte). Nachteil: Die Halle, der einzige anfangs sichtbare
    Showcase-Raum, wird praktisch nicht durchlaufen.
  - **C:** Alles lassen und das Pacing bewusst akzeptieren. Dann M8 um eine Notiz
    „erwartete Dauer: 3 Runden, erster Gegner Zug 5“ ergänzen.
  - Den BP-Wert in jedem Fall als Regel- oder Kartenparameter führen, nicht als Konstante
    im Code (siehe m-2).

#### M-2 Hartes Spielende nach dem letzten Aufdecken entwertet den Höhepunkt

- **Bezug:** M7. Konzept §19 („emotional funktionieren“), §21 („attraktiv genug …“), §18
  (kein Spielziel gefordert).
- **Problem:**
  - Mit `revealAllAreas` endet das Spiel genau beim Öffnen der letzten Tür. In beiden
    Abläufen oben geschieht das mit 0 Rest-BP.
  - Die zuletzt aufgedeckte Magierstube (Kristall, farbiges Licht, Partikel: der optische
    Showcase) wird **nie betreten**. Danach werden keine Aktionen mehr angenommen.
  - Außerdem ist M7 die einzige Regel, die über §18 hinausgeht. Sie ist nicht
    ausgeschlossen (§9 nennt Siegbedingungen als Datenfeld), aber auch nicht gefordert.
- **Vorschlag:** Ende nicht blockierend machen. Beim Erreichen der Bedingung einmalig
  `GAME_WON` bzw. den Banner „Gewölbe erkundet“ senden. Die Phase bleibt `playing`
  (oder `explored`), `MOVE_CHARACTER` und `END_TURN` sind weiter erlaubt, `OPEN_DOOR`
  ergibt sich von selbst, und „Neues Spiel“ ist jederzeit verfügbar. Alternativ M7
  komplett streichen und nur das Datenfeld `victory` im Kartenformat vorsehen.

#### M-3 Props/Monster ohne Koordinaten, kein Karten-Validator: Softlock-Risiko

- **Bezug:** M1 (Props standardmäßig blockierend), M2, M8 („Platzierung so, dass …“).
- **Problem:**
  - Die zentrale Softlock-Freiheit ist nur als Prosa formuliert und damit nicht prüfbar.
  - Konkrete Softlocks bei naheliegender Deko:
    - Säule, Fass oder Statue auf **(9,6)**: große Tür nicht öffenbar, Spiel unlösbar.
    - Blockierendes Objekt auf (4,12) oder (15,12): ebenso.
  - Monster oder Prop auf (4,13) bzw. (15,13) blockiert nicht den Sieg, aber das Betreten
    des Raums.
  - Ein Prop auf einem Startfeld führt zu einem ungültigen Startzustand.
  - Ohne Koordinaten lässt sich M8 in diesem Punkt nicht nachrechnen.
- **Vorschlag:**
  1. M8 um eine Tabelle mit allen Props und Monstern inkl. Koordinaten und `blocking`
     ergänzen.
  2. In `game-core` eine Funktion `validateDungeon(map)` mit Vitest-Test auf die
     v0.1-Karte vorsehen. Invarianten:
     - Bereiche sind disjunkt und nicht leer; jedes Feld liegt im Raster.
     - Jede Tür liegt auf einer orthogonalen Kante zwischen zwei verschiedenen Bereichen.
     - Kein Feld ist doppelt belegt (Prop, Monster, Start).
     - Startfelder liegen in initial entdeckten Bereichen und sind frei.
     - Jedes Prop liegt vollständig in *einem* Bereich.
     - **Beide Anliegerfelder jeder Tür** sind frei von blockierenden Props und Monstern.
     - Bei geöffneten Türen und ohne Helden ist jeder Bereich von jedem Startfeld aus
       erreichbar.
     - Die Siegbedingung ist erfüllbar.
  3. Diese Invarianten sind zugleich die Editor-Validierung für §10 und daher keine
     spekulative Abstraktion.

#### M-4 Reconnect: ein geschlossener Tab macht das Spiel unrettbar; Token-Regeln fehlen

- **Bezug:** M9 (sessionStorage pro Tab, dritte Verbindung abgelehnt, keine Zugaufgabe,
  Verwerfen nur „ohne Verbindung“).
- **Problem:**
  - sessionStorage überlebt kein Schließen des Tabs. Öffnet Spieler 2 das Spiel neu, fehlt
    das Token. Er gilt als dritte Verbindung und wird abgelehnt.
  - Ist gerade Spieler 2 am Zug, wartet das Spiel für immer. Da Spieler 1 verbunden
    bleibt, greift auch das Verwerfen bei Inaktivität nicht. Es gibt keinen Ausweg außer
    einem Server-Neustart (bzw. „Neues Spiel“, falls das vor Spielende überhaupt erlaubt
    ist; M7 lässt das offen).
  - „Tab duplizieren“ kopiert in Chromium sessionStorage. Dann nutzen zwei Sockets dasselbe
    Token, und das Verhalten ist undefiniert.
  - **Sicherheitsrelevant:** Unspezifiziert sind auch Herkunft und Geheimhaltung des
    Tokens. Leitet sich das Token aus Spieler- oder Spiel-ID ab oder steht es im
    gebroadcasteten Zustand, kann jeder Client den anderen Helden übernehmen.
- **Vorschlag:**
  - Token serverseitig kryptografisch zufällig erzeugen (z. B. `crypto.randomUUID()`) und
    **nur** an den Besitzer senden. Es erscheint nie im gebroadcasteten Zustand.
  - Neue Verbindung mit gültigem Token **ersetzt** die alte; der alte Socket wird mit Code
    geschlossen.
  - Beim Beitreten ist ein **freier oder getrennter** Slot übernehmbar, wenn der Client
    kein gültiges Token hat, der Slot seit N Sekunden getrennt ist und der Nutzer das in
    der UI bestätigt. Für v0.1 lokal ist das vertretbar; das Übernahmerisiko im Dokument
    benennen.
  - „Neues Spiel“ jederzeit erlauben (siehe m-5).
  - Konkretes Verwerfungs-Timeout festlegen und dem Client einen Ablehnungscode
    `GAME_NOT_FOUND` geben.

### Minor

#### m-1 M1: „begehbares Feld“ ist die falsche Bezugsgröße für die Wandableitung

- **Problem:** Werden Felder mit blockierendem Prop als „nicht begehbar“ gelesen und
  keinem Bereich zugeordnet, erzeugt die Wandregel Wände um jede Säule.
- **Vorschlag:** „Jedes **existierende** Feld gehört genau zu einem Bereich. Blockieren ist
  eine Eigenschaft von Props/Monstern, nicht von Feldern.“

#### m-2 §25-Entscheidungen als vorläufig markieren

- **Bezug:** Konzept §4 (Zugreihenfolge erst *nach* dem Prototyp), §25 (Bewegungsregeln,
  Zugreihenfolge, Sichtlinien und Türen bewusst offen).
- **Problem:** M3–M6 legen genau diese Punkte fest.
- **Vorschlag:** Einen Satz einfügen: „Festlegungen gelten nur für v0.1 und präjudizieren
  §25 nicht.“ Zusätzlich BP-Wert und Aktionsanzahl als Regelparameter führen. Die
  bereichsbasierte Sichtbarkeit ausdrücklich als Vereinfachung statt Sichtlinienregel
  benennen.

#### m-3 Sichtbarkeit: Leckpfade jenseits des gefilterten Zustands

- **Problem:** M6 verspricht „kein Spicken über Netzwerk-Inspektion“. Das gilt nur, wenn
  zusätzlich Folgendes eingehalten wird:
  1. Das Karten-JSON wird **nicht** vom Client importiert. Es darf nicht in `shared`
     liegen oder über `game-core`-Tests bzw. Fixtures ins Vite-Bundle gelangen.
  2. Türobjekte im gefilterten Zustand enthalten keine ID oder kein Theme des verborgenen
     Nachbarbereichs. Der `Stil` als bewusster Teaser ist in Ordnung.
  3. **Ablehnungscodes** verraten nichts. Ein `MOVE` auf ein verborgenes Feld mit Monster
     darf nicht `OCCUPIED_BY_MONSTER` liefern, sondern denselben Code wie ein nicht
     existierendes Feld. In M4 deshalb „entdeckt“ vor allen anderen Prüfungen prüfen.
- **Vorschlag:** Diese drei Regeln in M6 bzw. M9 aufnehmen, dazu ein Test: Der gefilterte
  Zustand im Startzustand enthält keine Koordinate außerhalb der Halle (außer der
  Türkante).

#### m-4 Eingabevalidierung der Nachrichten

- **Bezug:** M9.
- **Problem:** Eine fehlerhafte Nachricht (z. B. nicht ganzzahliges oder negatives `x`,
  fehlendes Feld, unbekannter `type`, riesiger Payload) darf keine Exception im
  Server-Prozess auslösen. Bei In-Memory-Haltung beendet ein Absturz alle Partien.
- **Vorschlag:** Schema-Prüfung am Socket-Eingang: ganzzahlig, im Raster, bekannte
  Aktion, Größenlimit. Ungültiges wird mit `ACTION_REJECTED/INVALID_MESSAGE` beantwortet.

#### m-5 „Neues Spiel“ unterspezifiziert

- **Bezug:** M7.
- **Problem:** Offen ist, wer „Neues Spiel“ auslösen darf, ob beide Slots und Tokens
  erhalten bleiben und ob die Aktion vor Spielende verfügbar ist.
- **Vorschlag:** Jeder der beiden Spieler darf jederzeit. Die Partie wird im selben Spiel
  mit denselben Slots und Tokens zurückgesetzt, `version` läuft weiter, und alle Clients
  erhalten einen vollständigen Snapshot.

#### m-6 Animation vs. „Clients rendern immer aus dem Zustand“

- **Bezug:** M6, M9.
- **Problem:** Der neue Zustand enthält Zielposition und aufgedeckten Bereich sofort.
  Naives Rendern lässt Figur und Raum „aufpoppen“, bevor die Inszenierung läuft. Sendet
  der Spieler den nächsten Zug während der Animation, überlappen sich die Animationen.
- **Vorschlag:**
  - Ereignisse in eine Client-Queue legen. Neu aufgedeckte Bereiche bis zu ihrem
    `AREA_REVEALED`-Schritt ausgeblendet halten.
  - Eingaben sperren, solange die eigene Queue nicht leer ist.
  - Beim Reconnect nur einen Snapshot ohne Event-Replay senden, also ohne Inszenierung.
  - Optional führen Aktionen eine `baseVersion` mit; der Server lehnt `STALE_STATE` ab.
    Das schützt davor, auf Basis veralteter Hervorhebungen zu handeln.

#### m-7 „Nichts Sinnvolles mehr möglich“ definieren

- **Bezug:** M3.
- **Vorschlag:** Eine `game-core`-Funktion, die genau dann `true` liefert, wenn keines der
  beiden Folgenden mehr möglich ist:
  - ein Feld mit Restbewegung erreichen,
  - eine geschlossene Tür erreichen *und* die Aktion ist noch verfügbar.

  Serverseitig ändert sich nichts, die Funktion dient nur als UI-Hinweis.

#### m-8 Große Tür optisch und spielerisch asymmetrisch

- **Bezug:** M8.
- **Problem:** Eine einzelne Kante bei x = 9 liegt außermittig zur Halle (Mitte x = 9,5)
  und auf nur einem von zwei Stammstreifen. Das kostet den Elf einen Extraschritt
  (6 statt 5 bis zur Tür, 7 bis in den Gang).
- **Vorschlag:** Die Doppeltür aus M-1/A löst das mit. Alternativ den Stamm 1 Feld breit
  machen (x = 9). Durch die Verbündeten-Durchquerung entsteht dabei kein Blockieren.

#### m-9 Statische Monster ohne jede Reaktion

- **Bezug:** M2, Spielgefühl.
- **Problem:** Helden können neben Gegnern stehen, ohne dass etwas passiert. Die
  „Gegner“-Spannung aus §19 verpufft.
- **Vorschlag:** **Keine** Mechanik ergänzen, weil Monster-KI und Kampf für v0.1
  ausgeschlossen sind. Rein präsentational genügt eine Idle- oder „Erwachen“-Animation
  beim Reveal. Monster so platzieren, dass sie von der Tür aus sofort im Bild sind, aber
  nicht an die Tür grenzen (siehe M-3).

---

## Scope-Check

| Konzept schließt für v0.1 aus | Im Mechanik-Dokument |
|---|---|
| Kampfsystem, Würfel | nicht vorhanden ✓ (feste BP statt Würfel) |
| Inventar, Charakterentwicklung, Klassen | nicht vorhanden ✓ (identische Werte) |
| komplexe Gegner-KI | nicht vorhanden ✓ (Monster statisch) |
| Zaubersystem | nicht vorhanden ✓ |
| Persistenz, Accounts | nicht vorhanden ✓ (In-Memory, Reconnect-Token ist keine Account-Logik) |

Die einzige Ergänzung über §18 hinaus ist **M7 (Siegbedingung)**. Sie ist nicht
ausgeschlossen, verursacht aber das Problem aus M-2. Die Vorschläge dieses Reviews fügen
keine ausgeschlossenen Features hinzu. M-1/A erweitert lediglich das Türmodell um
Mehrkanten-Türen.
