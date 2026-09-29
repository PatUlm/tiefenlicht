# Review 02 – Implementierung game-core und Protokoll

Gegenstand:

- `packages/game-core/src/*`: board, movement, game, visibility, validate,
  `content/prototype-dungeon.json` und die Tests,
- `packages/shared/src/protocol.ts` (Eingabevalidierung) samt Typen und Konstanten,

geprüft gegen `docs/game-mechanics.md` (Stand nach Review 01). Datum: 2026-09-29.

**Testlauf:** `pnpm test` ergibt 5 Dateien und 48 Tests, alle grün.

**Sonden:** Zusätzlich lief ein Sondenskript mit 18 Edge-Case-Prüfungen gegen die echten
Module. Es liegt außerhalb des Repos; die Ergebnisse stehen unten als „Sonde n“.

## Gesamturteil

Die Implementierung setzt das Mechanik-Dokument **treu und sauber** um:

- Die Regeln liegen als reine Funktionen vor und mutieren nichts.
- Die Bewegung wird serverseitig auf dem gefilterten View berechnet. Ablehnungscodes
  können dadurch strukturell nichts über Verborgenes verraten.
- Türen tragen neutrale IDs.
- Das Karten-JSON stimmt 1:1 mit M8 überein.
- Der erwartete Ablauf mit 8 BP ist per Test abgesichert.

**Keine Blocker, keine Major-Findings.** Die Minor-Punkte betreffen vier Bereiche:

1. Der Schutz „Karten-JSON nie im Client“ beruht nur auf Konvention. Das sollte vor dem
   Client-Bau erzwungen werden (m-1).
2. `validateDungeon` stürzt bei fehlerhafter Form ab und lässt Enum-Tippfehler durch (m-2).
3. Es gibt Altlasten, die dem Dokument widersprechen (m-3, m-4).
4. Es gibt Testlücken bei Randfällen (T).

---

## Abgleich Dokument ↔ Implementierung

| Regel | Status | Anmerkung |
|---|---|---|
| M1 Kanten-Wände (abgeleitet), Mehrkanten-Türen, Props blockierend per Default, Regelparameter in der Karte | ✓ | `Board.isWall`/`isEdgePassable`, `isPropBlocking`, `rules` im JSON. Veraltete Konstanten in `shared` siehe m-3. |
| M2 Slot → Held, Monster statisch und blockierend | ✓ | Slot-Zählung 0/1 im Code, 1/2 im Dokument (m-11) |
| M3 Start bei 2 Spielern, Budget 8/1, Teilbewegungen, nur explizites Zugende, `canStillAct` | ✓ | `canStillAct` entspricht der Definition wörtlich (Sonde 9) |
| M4 Prüfreihenfolge INVALID_TARGET → TARGET_OCCUPIED → UNREACHABLE/NOT_ENOUGH_MOVEMENT, BFS N-E-S-W, Durchqueren von Verbündeten | ✓ | Die Prüfung auf dem gefilterten View macht „verborgen“ gleich „existiert nicht“ (Sonde 13, auch nach Teilaufdeckung) |
| M5 Tür von jedem Anliegerfeld jeder Kante, Aktion verbraucht, Restbewegung | ✓ | Die unbekannte Tür und die verborgene Tür liefern beide `UNKNOWN_DOOR` |
| M6 Filterung von Feldern, Props, Deko, Monstern und Türen; neutrale Tür-IDs | ✓ | Kein Leck bei Teilaufdeckung (Sonde 12). Metadaten siehe m-8. Import-Schutz siehe m-1. |
| M6 „Karten-JSON nie im Client“ | ⚠ | Nur per Kommentar und Subpfad abgesichert (m-1) |
| M7 `GAME_WON` einmalig, Spiel läuft weiter, `RESTART_GAME` jederzeit mit denselben Slots | ✓ | `GamePhase` enthält noch das tote `'finished'` (m-4) |
| M8 Karte und Validator-Invarianten | ✓ / ⚠ | Die Karte ist korrekt. „Monster nicht *neben* Anliegerfeldern“ prüft der Validator nicht (m-5). |
| M9 Schema-Validierung, keine Exception | ✓ / ⚠ | Der Parser ist robust. Das Framelimit von 4 KiB greift im Parser nicht (m-6); der Server ist noch nicht vorhanden. |

## Karte (`prototype-dungeon.json`)

- **Bereiche, Türen, Starts:** identisch mit M8. Die Doppeltür hat die Kanten
  (9,6)–(9,7) und (10,6)–(10,7).
- **Props (22) und Monster (3):** Koordinaten, Größen und Typen identisch mit der
  M8-Tabelle.
- **Tür-Anliegerfelder:** keine Blocker auf den Anliegerfeldern. Die Monster stehen auch
  nicht *neben* Anliegerfeldern:
  - Grabwächter (4,18) und Knochenknecht (7,15) liegen nicht an (4,13).
  - Aschemagier (16,17) liegt nicht an (15,13).
  - Das ist manuell geprüft und nicht per Validator (m-5).
- **Erreichbarkeit:** Bei offenen Türen ist **jedes freie Feld** vom Start erreichbar.
  Es gibt keine eingeschlossenen Taschen (Sonde 14).
- **Distanzen vom Zwerg-Start:** große Tür 5, Eisentür 16, Arkane Tür 17 (Sonde 15).
  Der Elf braucht 16 bis zur Arkanen Tür. Der erwartete Ablauf mit 4 Zügen ist im Test
  `playOpening` abgesichert.
- **Wanddeko (15 Einträge):**
  - Alle hängen an echten Außenwänden, d. h. der Nachbar existiert nicht (manuell und per
    Validator geprüft).
  - Keine hängt auf einer Türkante.
  - Initial ist nur die Hallen-Deko sichtbar (Test und Sonde 12).
  - Im Dokument fehlen die Koordinaten der Deko (m-12).
- **Inszenierung (positiv):** Der Grabwächter steht in der Türachse x = 4 hinter dem
  Sarkophag und blickt nach Norden. Beim Öffnen der Eisentür ist er sofort frontal im
  Bild.

---

## Findings

### Blocker

Keine.

### Major

Keine.

### Minor

#### m-1 Import-Verbot für das Karten-JSON nur per Konvention (vor dem Client-Bau erledigen)

- **Bezug:** M6. `game-core/package.json` exportiert `./content` bedingungslos.
- **Problem:**
  - Ein einziger Import von `@dungeon/game-core/content` im Client, etwa für eine
    Offline-Vorschau, bündelt alle verborgenen Räume in das Vite-Bundle.
  - Kein Test würde das bemerken.
  - Die Garantie in M6 („nie“) ist damit nicht erzwungen.
- **Vorschlag:** Export auf die Node-Condition beschränken:

  ```json
  "./content": { "node": "./src/content/index.ts" }
  ```

  Ein Browser-Build mit Vite (Conditions `browser`/`import`/`default`) kann den Pfad dann
  nicht auflösen und bricht ab. Vitest (Node) und Server funktionieren weiter. Optional
  kommt später ein Bundle-Check im Client-Build dazu (`grep` auf „Magierstube“ im
  `dist`).

#### m-2 `validateDungeon` prüft keine Form und keine Enums und wirft statt zu melden

- **Bezug:** M8 („Kartenvalidierung“), Konzept §10 (Editor).
- **Problem:** Der Kommentar in `content/index.ts:5–6` behauptet „shape is checked by
  validateDungeon“, was nicht stimmt:
  - `wall: "X"` bei einer Deko führt zu `TypeError` in `step()` (Sonde 1).
  - Ein fehlendes `wallDecor` führt zu `d.wallDecor is not iterable` (Sonde 7).
  - Tippfehler wie `kind: "pilar"`, `facing: "South"` oder `style: "arcan"` ergeben
    **keinen Fehler** (Sonde 2). Sie fielen erst zur Laufzeit im Client auf, z. B. durch
    ein fehlendes Asset oder `undefined`-Rotation.
  - Ebenfalls ungeprüft bleiben:
    - ganzzahlige Koordinaten, Rects und Größen,
    - überzählige Start-Slots (Sonde 6),
    - doppelte Deko-IDs,
    - mehrfach belegte Deko-Kanten.
  - Wegen des Casts `as unknown as DungeonDefinition` prüft auch TypeScript nichts.
- **Vorschlag:** `validateDungeon` eine Formprüfung voranstellen, die bei Fehlern früh
  mit einer Fehlerliste zurückkehrt. Sie umfasst:
  - Arrays vorhanden,
  - Ganzzahlen für alle Koordinaten, `w` und `h`,
  - Enum-Zugehörigkeit für `Direction`, `PropKind`, `MonsterKind`, `DoorStyle`,
    `ThemeId`, `AreaKind` und `WallDecorKind`, gegen `as const`-Arrays in `shared`, aus
    denen auch die Typen abgeleitet werden,
  - `slot` in `0..PLAYERS_PER_GAME-1`,
  - eindeutige Deko-IDs.

  Damit ist der Validator zugleich Editor-tauglich. Die Alternative, die Karte als `.ts`
  mit `satisfies DungeonDefinition` zu schreiben, prüft nur zur Compile-Zeit und hilft
  dem späteren JSON-Editor nicht. Deshalb ist die Laufzeitprüfung vorzuziehen.

#### m-3 Veraltete Konstanten widersprechen M1/M3

- **Bezug:** `shared/src/constants.ts:1–2`.
- **Problem:** `MOVEMENT_PER_TURN = 6` und `ACTIONS_PER_TURN = 1` werden nirgends
  benutzt. Der Wert 6 widerspricht M3 (8, Kartenparameter). Das ist eine Falle für den
  Client, der „max. BP“ anzeigen will.
- **Vorschlag:** Beide Konstanten löschen. Maßgeblich ist `view.rules`.

#### m-4 `GamePhase` enthält das tote `'finished'`

- **Bezug:** `shared/src/types.ts:132`, M7.
- **Problem:** Laut M7 läuft das Spiel weiter; `'finished'` wird nie gesetzt. Ein
  Client-`switch` darauf würde totes UI erzeugen.
- **Vorschlag:** Aus dem Union-Typ entfernen. Das Siegsignal bleibt
  `objective.completed`.

#### m-5 Die Dokument-Invariante „Monster nicht neben Tür-Anliegerfeldern“ wird nicht validiert

- **Bezug:** M8 (Überschrift der Monster-Tabelle), `validate.ts:416–425`.
- **Problem:** Der Validator prüft nur „auf“ Anliegerfeldern. Ein Monster auf (4,14)
  wird akzeptiert (Sonde 4). Die aktuelle Karte erfüllt die Regel trotzdem.
- **Vorschlag:** Die Prüfung auf die 4er-Nachbarn der Anliegerfelder ausdehnen, nur für
  Monster. Alternativ die Formulierung im Dokument auf „nicht auf“ reduzieren, falls
  „neben“ nur eine Autorenrichtlinie ist.

#### m-6 Das Framelimit aus M9 greift nicht im Parser

- **Bezug:** M9 („Framegröße ≤ 4 KiB“), `MAX_CLIENT_MESSAGE_BYTES`.
- **Problem:** `parseClientMessage` parst auch 1 MB (Sonde 17). Die Konstante existiert,
  wird aber nirgends genutzt. Der Server fehlt noch, daher ist das Limit nicht
  verifizierbar.
- **Vorschlag:**
  - Im Server `new WebSocketServer({ maxPayload: MAX_CLIENT_MESSAGE_BYTES })` setzen.
  - Zusätzlich `parseClientMessage` defensiv prüfen lassen
    (`if (raw.length > MAX_CLIENT_MESSAGE_BYTES) return null;`).
  - Einen Test dafür ergänzen.

#### m-7 `sanitizePlayerName`: Randfälle und Hinweis zur Ausgabe

- **Bezug:** `protocol.ts:141–150`.
- **Problem** (Sonde 16):
  - `slice(0, 20)` zerschneidet Surrogatpaare. Aus 19 Zeichen plus Emoji wird eine
    einsame Surrogat-Hälfte `\ud83d`.
  - Tab und Newline sind `\p{Cc}` und werden entfernt, *bevor* Whitespace kollabiert.
    „Ana\tBen“ wird so zu „AnaBen“.
  - `trim()` läuft vor `slice`, deshalb bleibt ein Leerzeichen am Ende stehen.
- **Vorschlag:**
  1. `[\t\n\r]` zuerst durch ein Leerzeichen ersetzen.
  2. Nach Codepoints kürzen: `Array.from(s).slice(0, 20).join('')`.
  3. Danach trimmen.
- **Sicherheitshinweis:** Der Sanitizer maskiert bewusst kein HTML. Namen wie
  `<img src=x onerror=…>` passieren ihn. Der Client muss Namen ausschließlich als Text
  rendern (`textContent` bzw. Babylon-GUI-`TextBlock`), nie per `innerHTML`. Das gehört
  als Regel in M9 oder in die Client-Richtlinien.

#### m-8 Metadaten im View verraten Umfang des Verborgenen

- **Bezug:** M6, `visibility.ts:66–71`.
- **Problem:**
  - `objective.totalAreas = 4` verrät, dass es drei verborgene Bereiche gibt.
  - Fortlaufende Monster-IDs verraten nach dem Krypta-Reveal über das fehlende
    `monster-3` ein weiteres Monster (Sonde 12b).
  - `width`/`height` verraten die Kartenausdehnung.
  - Das ist harmlos und für eine Fortschrittsanzeige („2/4 entdeckt“) sogar nützlich,
    steht aber im Widerspruch zum Wortlaut von M6.
- **Vorschlag:** Bewusst akzeptieren und in M6 als zulässige Metadaten aufführen
  (empfohlen). Alternativ nur `completed` senden und Monster-IDs nicht fortlaufend
  vergeben.

#### m-9 `applyAction` ohne Default-Zweig

- **Bezug:** `game.ts:188–203`.
- **Problem:** Ein unbekannter `type` liefert `undefined` (Sonde 10). Der Parser
  verhindert das heute. Leitet der Server aber versehentlich eine Session-Nachricht
  (`JOIN_GAME` o. ä.) an `applyAction` weiter, stürzt er bei `result.ok` ab.
- **Vorschlag:** `default:` mit `assertNever(action)` für den Compiler plus
  Laufzeit-Reject `GAME_NOT_RUNNING` oder einen neuen Code `UNKNOWN_ACTION`.

#### m-10 Die Doppeltür-Geometrie ist nur teilweise validiert

- **Bezug:** `types.ts:67` („two adjacent parallel edges“), M1.
- **Problem:** Der Validator erzwingt nur ein einziges Bereichspaar (Sonde 3). Zwei weit
  auseinanderliegende Kanten zwischen denselben Bereichen würden als eine Tür akzeptiert.
- **Vorschlag:** Für `edges.length > 1` verlangen, dass die Kanten parallel und direkt
  benachbart sind, oder `edges.length ≤ 2` festschreiben.

#### m-11 Slot-Zählung: Dokument 1/2, Code 0/1

- **Bezug:** M2/M3 und `heroStarts[].slot`; Testname „starts with slot 1“.
- **Vorschlag:** Im Dokument „Slot 0 (Ersteller)/Slot 1“ verwenden oder den Hinweis
  „slot ist 0-basiert“ ergänzen.

#### m-12 Die Wanddeko fehlt in M8

- **Bezug:** M8 ist die Referenz für Kartenkoordinaten, die JSON enthält 15 Deko-Einträge.
- **Vorschlag:** Eine Tabelle „Wanddeko (Feld, Wandseite)“ ergänzen. Die Einträge sind
  geprüft, siehe Abschnitt „Karte“.

#### m-13 `RESTART_GAME` in der Phase `waiting`

- **Problem:** Die Aktion wird akzeptiert, erhöht die `version` und erzeugt das Event
  `GAME_RESTARTED` (Sonde 8). Das ist harmlos und deckt sich mit „jederzeit“, ist aber
  wirkungslos.
- **Vorschlag:** Optional mit `GAME_NOT_RUNNING` ablehnen oder so belassen und testen.

### T – Testlücken (Verhalten korrekt laut Sonde, aber ungetestet)

1. **`canStillAct`, Tür-Zweig:** 0 BP auf (10,6) nach (9,6)→(9,5)→(10,5)→(10,6), Aktion
   frei, ergibt `true` (Sonde 9). Der Zweig in `game.ts:315–317` ist bisher nicht
   abgedeckt.
2. **Teilaufdeckung:** Nach dem Öffnen der Krypta enthält der View nichts aus der
   Magierstube (keine Area, Props, Deko, `monster-3`); `door-3` bleibt geschlossen
   sichtbar (Sonde 12). Ein `MOVE` auf (16,17) liefert `INVALID_TARGET` (Sonde 13). Der
   bestehende Lecktest prüft nur den Startzustand.
3. **Autorität bei `OPEN_DOOR`:** `NOT_YOUR_CHARACTER`, `UNKNOWN_CHARACTER`, dazu
   `GAME_NOT_RUNNING` für `MOVE`/`OPEN_DOOR` in `waiting` und `RESTART_GAME` durch einen
   Fremden.
4. **Neustart nach dem Siegziel:** `objectiveCompleted` wird zurückgesetzt, `GAME_WON`
   feuert in der neuen Partie erneut. Außerdem der Neustart in `waiting` (m-13).
5. **Validator-Negativfälle:**
   - Überlappung von Bereichen,
   - Feld außerhalb des Rasters,
   - nicht orthogonale Türkante,
   - Prop über zwei Bereiche,
   - Start im verborgenen Bereich,
   - fehlender Start,
   - doppelte ID,
   - ungültige `rules`.

   Der Test „detects … an unsatisfiable objective“ prüft nur die Erreichbarkeitsmeldung,
   nicht `Siegbedingung unerfüllbar`.
6. **Karten-Regression:** „Jedes freie Feld ist bei offenen Türen erreichbar“ (Sonde 14)
   als Test auf die v0.1-Karte. Er schützt vor versehentlich eingeschlossenen Feldern bei
   künftigen Deko-Änderungen.
7. **Protokoll:**
   - Positivfälle für `OPEN_DOOR`, `RESUME_SESSION`, `RESTART_GAME` und `JOIN_GAME`
     mit `takeOver: true` bzw. `"true"`,
   - Negativfälle für `requestId` mit mehr als 64 Zeichen, `|x| ≥ 10 000` und die
     Namens-Randfälle aus m-7,
   - Entfernen fremder Felder in `target` (Sonde 18 zeigt korrektes Verhalten).
