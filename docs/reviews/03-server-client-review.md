# Review 03 – Server und Client (M3/M7/M9)

Gegenstand:

- `apps/server/src/*.ts`: Sitzungen, Token, Reconnect, Slot-Übernahme, Replace,
  Broadcast, Timeouts, statische Auslieferung,
- `apps/client/src/game-controller.ts` und `apps/client/src/net/connection.ts`,
- `apps/client/src/ui/*.ts` (Namen per `textContent`).

Aus `scene/*` wurden nur die regelnahen Stellen betrachtet: `tween.ts` wegen des
Queue-Verhaltens, `characters.ts` wegen der Namenslabels und `dungeon-view.ts` wegen der
Imports. Grundlage ist `docs/game-mechanics.md` (Stand nach Review 02). Datum: 2026-09-29.

**Testlauf:** `pnpm test` ergibt 5 Dateien und 72 Tests, alle grün.

**Sonden:** Zusätzlich lief ein Sondenskript gegen die echten Klassen `ClientHandler` und
`GameRegistry`. Es liegt außerhalb des Repos; die Ergebnisse stehen unten als „Sonde n“.

## Gesamturteil

Die Architektur ist sauber umgesetzt:

- Der Server delegiert alle Regelentscheidungen an `game-core`.
- Das Token verlässt den Server nur zum Besitzer (Test vorhanden).
- Replace mit 4001, Revocation bei Übernahme, Heartbeat, Idle-Sweep und `maxPayload`
  entsprechen M9.
- Der Client sendet nur Absichten und nutzt `game-core` nur für Hinweise.
- Snapshot (`GAME_STATE`) und Update (`GAME_UPDATE`) werden korrekt unterschieden.
- Namen landen ausschließlich per `textContent` im DOM. `innerHTML` und ähnliche
  HTML-Senken kommen im Client nirgends vor.
- Das Karten-JSON ist im Client nicht importiert: Nur der Hauptexport von `game-core`
  wird genutzt.

**Keine Blocker.** Zwei **Major**-Findings betreffen dasselbe Muster: Der Client kann in
einem toten bzw. veralteten Zustand hängen bleiben, ohne sich selbst zu heilen (M-1,
M-2). Daneben gibt es Minor-Punkte zu folgenden Themen:

- Korrelation offener Anfragen,
- Hotkey-Fehlauslösung,
- Übernahme in der Wartephase,
- fehlende Drosselung und Origin-Prüfung (vor jedem Deployment nötig),
- ein Absturzpfad in der statischen Auslieferung.

---

## Abgleich Dokument ↔ Implementierung

| Regel | Status | Anmerkung |
|---|---|---|
| M3 Zugwechsel und Budget serverseitig, `canStillAct` nur als Hinweis | ✓ | Die HUD-Pips lesen `view.rules`; „Zug beenden“ pulsiert gemäß Hinweis |
| M3 „Zug endet nur explizit“ | ✓ / ⚠ | Der Hotkey feuert auch hinter Dialogen (m-2) |
| M7 `GAME_WON` nach der Inszenierung, Spiel läuft weiter („Weiter umsehen“) | ✓ | Die Queue sequenziert `AREA_REVEALED` vor `GAME_WON` |
| M7 Neustart jederzeit mit Bestätigung, Snapshot ohne Inszenierung | ✓ | `GAME_RESTARTED` führt zu `rebuild(view)`. In `waiting` ist das HUD samt Button verborgen. |
| M9 Autorität: nur gebundene Verbindung, Aktion über `applyAction` | ✓ | Aktionen einer ersetzten Verbindung werden verworfen (Sonde 3) |
| M9 Framelimit doppelt | ✓ | `maxPayload` plus Parser. Der Parser zählt UTF-16-Einheiten statt Bytes (m-9). |
| M9 Erfolg an alle, Fehler nur an den Anfragenden | ✓ | Test vorhanden |
| M9 Animations-Queue, verborgene Bereiche bis `AREA_REVEALED` unsichtbar | ✓ | Der View wird erst am Ende von `playUpdate` angewendet (Fehlerfall siehe M-1) |
| M9 Eingabesperre „Queue läuft **oder eigene Anfrage offen**“ | ⚠ | `pending` wird von *jedem* `GAME_UPDATE` gelöscht (m-1) |
| M9 Token: `randomUUID`, nur an den Besitzer, `sessionStorage` pro Tab | ✓ | Das Token steht nicht in der URL, sondern nur der Spielcode |
| M9 Replace mit 4001, kein Auto-Reconnect | ✓ | `Connection` setzt `stopped` und meldet „replaced“ |
| M9 Slot-Übernahme „ist ein Spiel **voll**“ | ⚠ | Funktioniert auch in `waiting` und kapert dort den Ersteller-Platz (m-3) |
| M9 Idle 30 min ohne Verbindung, max. 200 Spiele, `GAME_NOT_FOUND` | ✓ / ⚠ | Der Server ist korrekt. Der Client behandelt `GAME_NOT_FOUND` nach einem Reconnect nicht (M-2). |
| M9 Namen nur per `textContent` | ✓ | `ui/dom.ts#el`; Namenslabels in `characters.ts:187` nutzen ebenfalls `textContent` |

---

## Findings

### Blocker

Keine.

### Major

#### M-1 Ein Fehler in einer Animation lässt den Client-View veralten; im Zugwechsel hängen dann beide Spieler

- **Bezug:** `game-controller.ts:195–205` (`enqueue`) und `:235–249` (`playUpdate`), M9.
- **Problem:**
  - Wirft ein Schritt in `animate()`/`revealArea()`, wird `applyView(view)` am Ende von
    `playUpdate` nie erreicht. `enqueue` loggt den Fehler nur und gibt die Sperre frei.
  - `this.view` bleibt auf dem Stand *vor* dem Update.
  - Auslöser kann jede Ausnahme im Render- oder Asset-Code sein, z. B. ein fehlendes
    Modell oder eine ungültige Tür-ID in der Szene.
  - Trifft es das Update mit `TURN_STARTED` für diesen Spieler, hält sich der Client
    weiterhin für „nicht am Zug“: kein Button, keine Hervorhebung.
  - Der Mitspieler wartet auf ihn, und kein weiteres Update kommt.
  - Das Spiel hängt ohne sichtbaren Hinweis, bis jemand F5 drückt (Resume liefert dann
    einen korrekten Snapshot).
  - In schwächerer Form tritt das im eigenen Zug auf: Position und Budget sind veraltet,
    die Hervorhebung ist falsch, der Server lehnt Klicks ab.
- **Vorschlag:** In `playUpdate` die Anwendung des Zielzustands garantieren:

  ```ts
  try { for (const e of events) … await this.animate(e, view); }
  catch (err) { console.error(err); await this.rebuild(view); } // Snapshot-Fallback
  finally { this.syncCharacters(view); this.showPhase(view); this.applyView(view); }
  ```

  Optional hilft ein Timeout pro Queue-Job, z. B. 15 s, danach `rebuild`. Er deckt nie
  auflösende Promises ab, etwa beim Laden von Assets.

#### M-2 Reconnect auf ein nicht mehr existierendes Spiel führt zu einem toten Client ohne Ausweg

- **Bezug:** `game-controller.ts:123–125` (`onOpen`) und `:173–191` (`onSessionError`),
  M9 („Unbekannte Spiele → `GAME_NOT_FOUND`“).
- **Problem:**
  - `resuming` ist nur beim Seitenstart `true`. Nach einem Verbindungsabbruch sendet
    `onOpen` erneut `RESUME_SESSION`.
  - Existiert das Spiel nicht mehr (Server neu gestartet oder nach dem Idle-Timeout
    verworfen), kommt `ERROR/GAME_NOT_FOUND`. Da `resuming === false` und `view` gesetzt
    ist, erscheint nur ein Toast.
  - Der Client bleibt im alten Spielbild. Das HUD zeigt ggf. „Du bist am Zug“, jeder
    Klick erzeugt `NO_SESSION`.
  - Im Entwicklungsalltag ist das der **Normalfall**: `tsx watch` startet den Server bei
    jeder Codeänderung neu und verwirft alle In-Memory-Spiele.
- **Vorschlag:**
  - `resuming = true` in `onOpen` setzen, sobald `RESUME_SESSION` gesendet wird.
  - `GAME_NOT_FOUND` und `INVALID_SESSION` als Antwort darauf gleich behandeln: Session
    löschen, Szene leeren, Lobby mit Meldung „Das Spiel existiert nicht mehr“ zeigen.
  - Zusätzlich `NO_SESSION` während eines laufenden Spiels (`view !== null`) als
    Resync-Signal nehmen, also ebenfalls Lobby oder Resume.

### Minor

#### m-1 Die Eingabesperre „eigene Anfrage offen“ ist nicht an die Anfrage gebunden

- **Bezug:** `game-controller.ts:158–166`, M9. Server: Erfolgs-Updates tragen keine
  `requestId` (Sonde 5).
- **Problem:**
  - `pending` wird von *jedem* `GAME_UPDATE` und jedem `ACTION_REJECTED` gelöscht.
  - Trifft zwischen eigener Anfrage und Antwort ein fremdes Update ein, gibt der Client
    Eingaben nach dessen Animation frei, obwohl die eigene Antwort noch aussteht. Das
    fremde Update kann `PLAYER_CONNECTION`, eine Umbenennung durch Übernahme oder ein
    `RESTART_GAME` des Mitspielers sein.
  - Der nächste Klick basiert dann auf einem veralteten View.
  - Verwandter Fall: Ein `RESTART_GAME` des Mitspielers kann vor der eigenen `MOVE`
    verarbeitet werden. Der Zug wird dann in der **neuen** Partie ausgeführt, gemessen an
    einer Hervorhebung aus der alten.
  - Bei lokaler Latenz ist das selten, bei echtem Netz realistisch.
- **Vorschlag:**
  1. Der Server sendet dem Auslöser seine `requestId` im `GAME_UPDATE` mit; das Feld ist
     optional und nur in dessen Kopie gesetzt. Der Client löscht `pending` nur bei
     passender `requestId`, sowohl bei `GAME_UPDATE` als auch bei `ACTION_REJECTED`.
  2. Optional führen Aktionen `baseVersion` mit; der Server lehnt Abweichungen mit
     `STALE_STATE` ab. Das schließt auch das Restart-Rennen.

#### m-2 Die Hotkeys Leertaste/Enter beenden den Zug auch hinter Dialogen

- **Bezug:** `game-controller.ts:559–571`, M3 („nur explizit“).
- **Problem:**
  - Ausgenommen sind nur `HTMLInputElement`-Ziele.
  - Ist der Dialog „Neues Spiel?“ oder „Gewölbe erkundet!“ offen oder hat ein Button den
    Fokus, beendet Enter bzw. Leertaste den Zug. `preventDefault` unterdrückt dabei
    zusätzlich die eigentliche Button-Aktion.
  - Beispiel: Tab auf „Weiter umsehen“ und Enter beendet den Zug. Der Vorgang ist nicht
    umkehrbar.
- **Vorschlag:**
  - Hotkey ignorieren, wenn ein Overlay offen ist oder
    `e.target instanceof HTMLElement && e.target.closest('button, input, textarea, [role=dialog]')`.
  - Wiederholungen (`e.repeat`) ebenfalls ignorieren.
  - Optional nur die Leertaste belegen.

#### m-3 Slot-Übernahme auch in der Wartephase kapert den Ersteller-Platz

- **Bezug:** `game-session.ts:71–81`, M9 („Ist ein Spiel **voll**, aber ein Slot
  getrennt …“).
- **Problem:**
  - Der Ersteller schließt kurz den Tab, das Spiel ist noch in `waiting`.
  - Ein Client sendet direkt `JOIN_GAME` mit `takeOver: true`. Er übernimmt Slot 0 samt
    Zwerg, statt Slot 1 zu belegen (Sonde 1: `player-1` heißt jetzt „Eve“).
  - Das Token des Erstellers ist widerrufen; bei der Rückkehr sieht er
    `INVALID_SESSION`.
  - Die UI bietet das nie an, ein manipulierter Client aber schon.
- **Vorschlag:** In `takeOver` zuerst
  `if (this.state.players.length < PLAYERS_PER_GAME) return this.join(conn, name);`
  prüfen, oder mit `GAME_FULL`/`canTakeOver: false` ablehnen. Einen Test ergänzen.

#### m-4 Keine Drosselung und keine Origin-Prüfung: Spielcodes aufzählbar, Kapazität blockierbar

- **Bezug:** `client-handler.ts:52–60`, `game-registry.ts:34–44`, `main.ts:41`.
  Sicherheitsrelevant.
- **Problem:**
  - Ein fehlgeschlagenes `JOIN_GAME` bindet die Verbindung nicht. Ein Socket kann daher
    unbegrenzt raten (Sonde 6: 1000 Versuche, Socket bleibt offen).
  - Der Coderaum hat 31⁵ ≈ 28,6 Mio. Einträge. Bei wenigen laufenden Spielen ist ein
    Treffer in Minuten erreichbar.
  - Ein Treffer ermöglicht, den freien Platz einer wartenden Partie oder einen getrennten
    Platz zu belegen. M9 akzeptiert „wer den Code kennt“, das Aufzählen macht das
    Kennen aber trivial.
  - 200 Sockets mit je `CREATE_GAME` füllen die Registry. Solange sie offen bleiben,
    greift kein Sweep, und neue Spiele sind unmöglich.
  - Ohne Origin-Prüfung kann das auch eine beliebige fremde Webseite im Browser eines
    Besuchers auslösen. Sitzungen lassen sich so nicht kapern, weil keine Cookies im
    Spiel sind.
- **Vorschlag:** Für den lokalen Betrieb in v0.1 vertretbar, vor jedem Deployment
  (Konzept §22) aber Pflicht:
  - Nach z. B. 5 fehlgeschlagenen `JOIN_GAME`/`RESUME_SESSION` pro Socket die
    Verbindung schließen.
  - Spielerstellung pro IP begrenzen.
  - `verifyClient` bzw. das `Origin`-Header gegen eine Allowlist prüfen.
  - Bei öffentlichem Betrieb längere Codes verwenden (≥ 7 Zeichen).
  - Die Punkte als bekannte v0.1-Grenzen in M9 aufnehmen.

#### m-5 Standard-Bind auf `0.0.0.0`

- **Bezug:** `main.ts:13`, `vite.config.ts` (`host: true`).
- **Problem:** Game-Server und Vite-Dev-Server sind standardmäßig im gesamten Netz
  erreichbar. Zusammen mit m-4 ist das eine unnötige Angriffsfläche beim Entwickeln im
  fremden WLAN.
- **Vorschlag:** Standard `127.0.0.1` bzw. `host: false`. LAN-Spiel und Docker erhalten
  `HOST=0.0.0.0` explizit per Umgebungsvariable (Dockerfile/Compose).

#### m-6 `static-files.ts`: Stream-Fehler kann den Prozess beenden

- **Bezug:** `static-files.ts:73`.
- **Problem:**
  - `createReadStream(filePath).pipe(res)` hat keinen `error`-Handler.
  - Verschwindet die Datei zwischen `stat` und dem Öffnen, etwa bei einem Redeploy von
    `dist/`, oder fehlen Rechte, entsteht ein unbehandeltes `'error'`-Event.
  - Folge ist der Prozessabsturz. Damit sind alle In-Memory-Spiele verloren und alle
    Clients laufen in M-2.
- **Vorschlag:** `pipeline(createReadStream(filePath), res, (err) => err && res.destroy())`
  aus `node:stream` verwenden.

#### m-7 „Neues Spiel“ umgeht die Verbindungsprüfung und wird offline gepuffert

- **Bezug:** `game-controller.ts:105–107` (`force = true`), `connection.ts:99–102`.
- **Problem:**
  - Bei unterbrochener Verbindung landet `RESTART_GAME` in der Sende-Queue.
  - Nach dem Reconnect wird es direkt hinter `RESUME_SESSION` gesendet, eventuell
    Minuten später. Die Partie beider Spieler wird dann unerwartet zurückgesetzt.
  - Allgemein puffert `Connection.queue` beliebige Nachrichten über Verbindungsabbrüche
    hinweg.
- **Vorschlag:**
  - Spielaktionen nie puffern; die Queue nur für Lobby-Nachrichten während des
    Erstverbindens nutzen.
  - `restart()` nur bei `connected`, sonst ein Toast „Keine Verbindung“.
  - `force` darf nur `queued` und `pending` ignorieren, nicht `connected`.

#### m-8 Debug-Handle `window.__dungeon` im Produktions-Build

- **Bezug:** `main.ts:59`.
- **Problem:**
  - Der Handle legt `controller` offen, samt Session-Token und Methoden.
  - Das ist keine echte Rechteausweitung: Das Token liegt ohnehin in `sessionStorage`,
    und der Server ist autoritativ.
  - Trotzdem ist es unnötige Angriffsfläche, z. B. für Browser-Erweiterungen und Skripte.
- **Vorschlag:** Nur bei `import.meta.env.DEV` oder `?debug` setzen. Die Smoke-Tests
  laufen im Dev-Modus.

#### m-9 Das Framelimit im Parser zählt Zeichen, nicht Bytes

- **Bezug:** `protocol.ts:158`.
- **Problem:** `raw.length` zählt UTF-16-Einheiten. Die harte Byte-Grenze setzt korrekt
  `maxPayload`. Der Parser-Check ist also nur eine Näherung; das Dokument spricht von
  „Framegröße ≤ 4 KiB“.
- **Vorschlag:** `Buffer.byteLength` ist in `shared` nicht nutzbar, weil das Paket auch
  im Browser läuft. Deshalb nur den Kommentar oder die Konstante präzisieren
  („Zeichenlimit als Zweitschutz“).

#### m-10 Testlücken

1. **Server:**
   - `RESTART_GAME` über `ClientHandler`: Events an beide, Snapshot-Semantik (Sonde 2
     zeigt korrektes Verhalten).
   - Übernahme in `waiting` (m-3).
   - Eine Aktion über die ersetzte Verbindung erzeugt keine Wirkung und keine Antwort
     (Sonde 3).
   - Sweep erst 30 min nach der **letzten** Trennung.
   - `JOIN` ohne Übernahme, wenn `canTakeOver: true` gemeldet wurde und inzwischen
     wieder beide verbunden sind.
2. **Client:** Es gibt keine Tests. Mindestens die Entscheidungslogik sollte als reine
   Funktionen herausgelöst und getestet werden:
   - Behandlung von `ERROR` je nach Resume-Zustand (M-2),
   - Korrelation von `pending` (m-1),
   - Fallback bei Animationsfehlern (M-1).

   Ein Babylon-Setup ist dafür nicht nötig.

---

## Geprüft ohne Befund

- **Token-Geheimhaltung:** Das Token geht nur im `SESSION` an den Besitzer, weder im View
  noch in einer URL noch in Logs. `resume` rotiert das Token nicht, `takeOver` widerruft
  es korrekt.
- **Replace-Rennen:** Das spätere `close` des alten Sockets markiert den Spieler nicht als
  getrennt (`disconnect` vergleicht die Verbindung). Nachrichten des alten Sockets werden
  ignoriert.
- **Reihenfolge beim Beitritt:** `SESSION`, dann `GAME_UPDATE` an die anderen, dann
  `GAME_STATE` an den Neuen. Es gibt kein Update vor dem ersten Snapshot.
- **Heartbeat:** Ping alle 30 s, `terminate` nach einem ausbleibenden Pong. Halboffene
  Sockets gelten nach höchstens rund 60 s als getrennt.
- **Hintergrund-Tabs:** `tween` überspringt Animationen, wenn `document.hidden` gilt. Die
  Queue staut sich nicht dauerhaft; beim Zurückkehren laufen laufende Tweens sofort zu
  Ende.
- **Informationslecks:** Der Client erhält ausschließlich den gefilterten View.
  `dungeon-view.ts` nutzt nur `Board`/`propFootprint` aus dem Hauptexport. Fehlertexte
  sind generisch.
- **Path Traversal:** `static-files.ts` normalisiert nach dem Dekodieren und prüft das
  Präfix `root + sep`. Nullbytes führen zum Fallback auf `index.html`.
