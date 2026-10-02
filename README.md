# Tiefenlicht – Tech-Prototyp v0.3

Rundenbasiertes 3D-Dungeon-Brettspiel im Browser (Arbeitstitel „Tiefenlicht“), umgesetzt
nach `dungeon-game-concept.md`. Zwei Spieler (Zwerg und Dunkelelf) erkunden gemeinsam
„Das Gewölbe der Laternen“ auf drei Ebenen: Eingangshalle, Gang, Krypta und Magierstube,
darunter die Gebeinkammer, darüber die Sternwarte. Türen und Treppen öffnen verborgene
Räume, dabei erwachen Gegner. Die Spielregeln stehen in
`docs/game-mechanics.md`.

## Schnellstart

### Docker (spielbare Demo)

```bash
docker compose up -d --build        # http://localhost:8080
PORT=8090 docker compose up -d      # anderer Host-Port
```

Ein Container liefert Client und WebSocket-Server auf demselben Port aus.

### Lokale Entwicklung

Voraussetzungen: Node.js ≥ 24, pnpm über corepack (`corepack enable pnpm`).

```bash
pnpm install
pnpm dev          # Vite-Client http://localhost:5173 + Game-Server :8080 (Hot Reload)
pnpm test         # Vitest: Regeln, Validator, Protokoll, Server-Sitzungen
pnpm typecheck    # TypeScript in allen Paketen
pnpm build        # Client-Build (Vite) + Server-Bundle (esbuild)
pnpm start        # gebauten Server inkl. Client auf http://localhost:8080 starten
```

Im Dev-Modus verwirft `tsx watch` bei jeder Serveränderung alle In-Memory-Spiele. Offene
Clients kehren dann automatisch in die Lobby zurück.

## Spielen

1. Browserfenster 1: Namen eingeben und **Neues Spiel erstellen**. Du erhältst einen
   5-stelligen Code und einen Einladungslink.
2. Browserfenster 2 (anderes Fenster oder anderer Rechner): Link öffnen oder Code eingeben,
   dann **Beitreten**. Zwei Tabs desselben Browsers funktionieren ebenfalls, da die
   Sitzung pro Tab gespeichert wird.
3. Abwechselnd ziehen: **8 Bewegungspunkte und 1 Aktion** pro Zug.
   - Leuchtendes Feld anklicken: Die Figur läuft; der Pfad wird beim Überfahren angezeigt.
   - Steht der Held direkt an einer Tür, pulsiert sie golden. Ein Klick öffnet sie (Aktion).
   - Treppen funktionieren wie Türen: Steht der Held vor einer Treppe oder an ihrem oberen
     Ende (beide Felder tragen eine goldene Bodenmarkierung), pulsiert sie golden, und ein
     Klick erkundet sie (Aktion) und nimmt den Held mit **einem** Schritt (1 BP) gleich auf
     die andere Ebene; ohne Bewegungspunkt bleibt er stehen. Erkundete Treppen kosten pro
     Durchgang 1 BP. Unerkundete Treppen kündigen
     sich an: aus der Tiefe steigt kalter Hauch, von oben fallen Sternenfunken.
   - **Zug beenden** per Button oder Leertaste.
4. Ziel: alle sechs Bereiche entdecken **und betreten**. Danach läuft das Spiel weiter,
   damit ihr euch in Ruhe umsehen könnt. **Neues Spiel** setzt die Partie jederzeit für beide
   zurück.

| Steuerung | |
|---|---|
| Linksklick | Laufen / Tür öffnen / Treppe erkunden oder nehmen |
| Ziehen (links/rechts) oder WASD/Pfeiltasten | Kamera schwenken |
| Mausrad | Zoomen |
| Q / E | Ansicht um 90° drehen (Wände zur Kamera werden automatisch abgesenkt) |
| Bild↑ / Bild↓ | Ebene wechseln (auch über die Ebenen-Buttons der Minimap) |
| F | eigenen Helden fokussieren (inkl. seiner Ebene) |
| G | Raster ein/aus |
| M | Musik ein/aus (auch über den ♪-Button) |
| Leertaste | Zug beenden |

Auf dem **Handy** (Hoch- und Querformat) gilt: Tippen = Klick, ein Finger schwenkt, zwei
Finger zoomen. Drehen und Held fokussieren liegen als Buttons unten links; Spielcode,
Raster, Neues Spiel und FPS stecken im Menü ☰, die Minimap ist einklappbar. Touch-Geräte
rendern mit reduzierter Grafikqualität.

Die **Hintergrundmusik** ist ein eigenes Chiptune im Amiga/NES-Stil, das zur Laufzeit per
WebAudio synthetisiert wird (`apps/client/src/audio/`). Sie startet mit der ersten
Eingabe (Autoplay-Regel der Browser); ein/aus wird im Browser gespeichert.

Die Kamera zeigt immer eine **Fokus-Ebene**: Sie folgt dem Helden am Zug und jeder
laufenden Figur, auch über Treppen; beim Wechsel blendet sie kurz den Namen ein
(Obergeschoss, Eingangsebene, Untergeschoss). Ebenen darüber sind ausgeblendet, Ebenen
darunter abgedunkelt und mit abgesenkten Wänden sichtbar. Rechts oben zeigt die **Minimap** alle
entdeckten Ebenen als gestapeltes Drahtgittermodell mit Türen, Treppen und Figuren. Sie
dreht mit der Kamera mit. Darunter steht die **FPS-Anzeige** (grün ab 50, gelb ab 30).

Ein Neuladen der Seite setzt das Spiel fort. Schließt ein Spieler den Tab, kann ein neuer
Tab über den Einladungslink den verwaisten Platz übernehmen.

## Architektur

```text
apps/
  client/       Babylon.js 9 + Vite: Szene, Kamera, Rendering, Animation, HTML-HUD
  server/       Node.js + ws: Lobby, Sitzungen/Token, autoritativer Spielablauf
packages/
  shared/       Typen, WebSocket-Protokoll, Eingabevalidierung, Konstanten
  game-core/    Regeln ohne Rendering-Abhängigkeit: Board, Bewegung (BFS),
                Türen, Sichtbarkeit/Fog-of-War-Filter, Zugfolge, Kartenvalidator
                content/  Karte als JSON (nur Server, per Export-Condition "node")
assets/         Modelle (KayKit, CC0) und Lizenzen; wird vom Client als public/ ausgeliefert
docs/           Mechanik-Entscheidungen und Reviews
```

- **Autoritativer Server:** Der Client sendet nur Absichten (`MOVE_CHARACTER` mit Zielfeld,
  `OPEN_DOOR`, `END_TURN`, `RESTART_GAME`). Der Server prüft sie mit `game-core`, berechnet
  z. B. den Pfad selbst und sendet Ereignisse plus neuen Zustand an beide Clients. Die
  Clients animieren nur.
- **Fog of War serverseitig:** Clients erhalten nur entdeckte Bereiche. Verborgene Räume,
  Props und Monster stehen weder im Netzwerkverkehr noch im Client-Bundle.
- **Datengetriebener Dungeon:** Die Karte beschreibt Bereiche, Türen auf Kanten, Props,
  Wanddeko, Monster, Starts, Siegbedingung und Regelparameter. Wände werden abgeleitet.
  `validateDungeon` prüft Form und Spielbarkeit und ist damit als Editor-Validierung
  wiederverwendbar.
- **Themes:** Die Geometrie ist unabhängig von der Optik. Halle, Gang, Krypta und
  Magierstube unterscheiden sich nur über Theme-Stile (Boden, Wände, Flammenfarbe, Nebel,
  Funken).

## Assets und Lizenzen

Alle 3D-Modelle stammen von **Kay Lousberg (KayKit)** und stehen unter **CC0**:
Dungeon Remastered, Character Pack Adventurers, Character Pack Skeletons. Die
Lizenzdateien liegen in `assets/licenses/`. KayKit ersetzt die im Konzept bevorzugten
Quaternius-Pakete. Gründe: KayKit liefert Dungeon, Helden und Skelette in einem
einheitlichen Stil, die Figuren sind animiert (Laufen, Interagieren, Erwachen, Jubeln),
und die Pakete sind direkt per Git beziehbar. Sarkophag, Bücherregale, Kessel, Kristall
und Statue-Sockel sind prozedural erzeugt. Font: Fredoka (SIL OFL).

## Bekannte Grenzen v0.3

- Kein Kampf, keine Würfel, kein Inventar, keine Monster-KI (laut Konzept bewusst später).
- Spiele liegen nur im Speicher. Ein Server-Neustart beendet alle Partien.
- Vor einem öffentlichen Deployment fehlen ein Limit für die Spielerstellung pro IP,
  längere Spielcodes und ein Reverse Proxy mit TLS (`ALLOWED_ORIGINS` setzen).
- Grafik: WebGL2 mit Schatten, Glow, Bloom und Partikeln. Auf Rechnern ohne GPU-Beschleunigung
  läuft die Szene nur mit wenigen FPS.
