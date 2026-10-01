# Konzept und Tech-Prototyp: rundenbasiertes 3D-Dungeon-Brettspiel

## 1. Projektidee

Ziel ist ein eigenes, rundenbasiertes Fantasy-Dungeon-Spiel mit starkem Brettspiel-Charakter.

Die Inspiration kommt unter anderem von klassischen Dungeon-Brettspielen wie *HeroQuest*, das Spiel soll aber **keine Kopie** werden. Eigene Namen, eigene Welt, eigene Charaktere, eigene Klassen, eigene Gegner, eigene Quests und eine eigene visuelle Identität stehen im Vordergrund.

Wichtige Leitidee:

> Ein klassisches rundenbasiertes Dungeon-Brettspiel, aber als farbenfrohes, hochwertiges 3D-Spiel mit Netzwerk-Multiplayer.

Langfristig soll das Spiel nicht nur fertige Abenteuer enthalten, sondern auch einen eigenen Dungeon-/Quest-Editor ermöglichen.

---

## 2. Rechtliche Leitplanken

### Was bewusst nicht übernommen werden soll

- Name **HeroQuest**
- originale HeroQuest-Grafiken
- originale Karten
- originale Questtexte
- originale Regeln in konkreter Formulierung
- originale Figuren-/Monsterdesigns
- originale Logos oder Marken

### Was grundsätzlich als allgemeine Fantasy-Idee verwendet werden kann

- rundenbasierte Dungeon-Erkundung
- Rasterbewegung
- Würfel-/Zufallssysteme
- Türen, Fallen, Truhen, Möbel
- Zauber
- Monster
- Helden
- Elfen
- Dunkelelfen
- Zwerge
- Goblins
- Trolle
- andere allgemeine Fantasy-Archetypen

### Dunkelelfen

**Dunkelelfen als allgemeines Fantasy-Volk sind möglich.**

Nicht übernommen werden sollen konkrete D&D-spezifische Ausgestaltungen wie:

- Drow als konkrete D&D-Rasse
- deren spezifische Kultur
- Gottheiten
- Symbole
- Namen
- Lore

Eigene Dunkelelfen mit eigener Kultur, Optik und Hintergrundgeschichte sind vorgesehen.

### Grundsatz

Auch wenn das Projekt zunächst privat gedacht ist, soll die Architektur und Asset-Auswahl möglichst so erfolgen, dass eine spätere Veröffentlichung nicht unnötig erschwert wird.

---

## 3. Visuelle Richtung

Die gewünschte Optik orientiert sich an der Stimmung des isometrischen Magier-Levels aus *It Takes Two*:

- echtes **3D**
- isometrische bzw. schräg von oben gerichtete Kamera
- kräftige, satte Farben
- stilisierte Formen
- freundliche, hochwertige "Kindergrafik"
- keine fotorealistische Darstellung
- klare Lesbarkeit der Spielfiguren
- stimmungsvolle Lichtquellen
- farbige Zauber- und Treffer-Effekte
- überzeichnete Props und Architektur
- Animationen beim Laufen, Kämpfen, Öffnen von Türen und Zaubern

Der Stil soll eher charmant und hochwertig wirken als düster-realistisch.

---

## 4. Gameplay-Grundsätze

Das Spiel soll trotz 3D-Präsentation im Kern ein **Brettspiel** bleiben.

### Rasterbasiert

Unter der 3D-Szene liegt ein logisches Raster.

Beispiel:

```text
┌───┬───┬───┬───┬───┐
│   │   │ M │   │   │
├───┼───┼───┼───┼───┤
│   │ H │   │   │   │
├───┼───┼───┼───┼───┤
│   │   │   │ D │   │
└───┴───┴───┴───┴───┘
```

Das Raster muss später nicht dauerhaft sichtbar sein.

Der Spieler klickt ein Zielfeld an. Die Spiellogik entscheidet:

- ist das Ziel erreichbar?
- reicht die Bewegung?
- ist der Weg frei?
- ist das Zielfeld belegt?
- darf das Feld betreten werden?

Erst danach wird die 3D-Animation ausgeführt.

### Rundenbasiert

Das Spiel soll strikt rundenbasiert sein.

Ein möglicher späterer Zug:

```text
Bewegung
   ↓
Aktion
 ├─ Angriff
 ├─ Zauber
 ├─ Suchen
 ├─ Tür öffnen
 ├─ Gegenstand benutzen
 └─ Interagieren
   ↓
Restbewegung
   ↓
Zug beenden
```

Die genaue Zugreihenfolge ist noch offen und wird erst nach dem Tech-Prototyp festgelegt.

---

## 5. Charaktere und Völker

Für das spätere Spiel soll **Volk und Klasse getrennt** werden.

Beispielhafte Völker:

- Mensch
- Elf
- Dunkelelf
- Zwerg

Mögliche spätere Klassen:

- Krieger
- Waldläufer
- Schurke
- Magier
- Kleriker
- Hexenmeister
- Berserker

Dadurch wären Kombinationen möglich wie:

- Dunkelelf + Schurke
- Dunkelelf + Magier
- Zwerg + Krieger
- Zwerg + Kleriker
- Mensch + Waldläufer

Für den Tech-Prototypen ist diese Klassenlogik **noch nicht nötig**.

---

## 6. Technische Entscheidung

Der Tech-Prototyp soll vollständig auf einem Browser-first-Stack basieren.

### Festgelegter Stack

| Bereich | Technik |
|---|---|
| 3D-Client | **Babylon.js + TypeScript** |
| Build | **Vite** |
| Server | **Node.js + TypeScript** |
| Netzwerk | **WebSocket** |
| Tests | **Vitest** |
| gemeinsame Typen | eigenes Shared-Package |
| Deployment später | Docker + Reverse Proxy |
| Persistenz im Prototyp | zunächst In-Memory |
| Persistenz später | Datenbank |

### Warum Babylon.js

- läuft nativ im Browser
- WebGL/WebGPU-freundlich
- TypeScript-first
- Client und Server bleiben im selben Sprach-Ökosystem
- sehr gut für 3D-Szenen, Picking, Animationen und Assets
- ideal für einen Browser-Client ohne zusätzlichen nativen Installer

---

## 7. Architektur

### Grundprinzip

Der Server ist **autoritativer Spielserver**.

Der Client darf Aktionen anfordern, aber keine Spielregeln selbst entscheiden.

```text
Browser / Babylon.js
        │
        │ WebSocket
        ▼
Node.js Game Server
        │
        ├── Game State
        ├── Turn Manager
        ├── Movement
        ├── Rules
        ├── Dice
        ├── Visibility
        ├── Monster AI
        └── Persistence
```

### Beispiel

Client:

```json
{
  "type": "MOVE_CHARACTER",
  "characterId": "dwarf-1",
  "target": { "x": 7, "y": 4 }
}
```

Server prüft:

- ist dieser Spieler am Zug?
- darf diese Figur bewegt werden?
- reicht die Bewegung?
- ist der Pfad frei?
- ist das Zielfeld gültig?

Antwort:

```json
{
  "type": "CHARACTER_MOVED",
  "characterId": "dwarf-1",
  "path": [
    { "x": 5, "y": 4 },
    { "x": 6, "y": 4 },
    { "x": 7, "y": 4 }
  ]
}
```

Der Client animiert anschließend nur das Ergebnis.

---

## 8. Empfohlene Projektstruktur

```text
dungeon-game/
├── apps/
│   ├── client/
│   │   ├── Babylon.js
│   │   ├── UI
│   │   ├── Camera
│   │   ├── Rendering
│   │   └── Animation
│   │
│   └── server/
│       ├── Lobby
│       ├── GameSession
│       ├── TurnManager
│       ├── Rules
│       └── WebSocket
│
├── packages/
│   ├── shared/
│   │   ├── protocol
│   │   ├── types
│   │   └── constants
│   │
│   └── game-core/
│       ├── board
│       ├── movement
│       ├── visibility
│       └── actions
│
└── assets/
```

### Wichtiger Grundsatz

`game-core` sollte **keine Babylon.js-Abhängigkeit** haben.

Die Spiellogik muss unabhängig vom Rendering testbar sein.

Beispiel:

```ts
const result = moveCharacter(game, characterId, {
  x: 7,
  y: 4,
});

expect(result.success).toBe(true);
```

---

## 9. Datengetriebener Dungeon

Die Karte soll nicht direkt als fest modelliertes 3D-Level gespeichert werden.

Stattdessen beschreibt eine Datenstruktur:

- Räume
- Felder
- Wände
- Türen
- Objekte
- Gegner
- Startpositionen
- Sichtbarkeit
- Trigger
- Siegbedingungen

Beispiel:

```ts
interface DungeonTile {
  x: number;
  y: number;

  floor?: FloorType;
  walls?: WallDefinition[];
  object?: DungeonObject;
  hidden: boolean;
}
```

Räume:

```ts
interface Room {
  id: string;
  tiles: Position[];
  theme: "crypt" | "mage" | "dungeon";
  initiallyHidden: boolean;
}
```

Später kann ein Editor daraus JSON erzeugen.

---

## 10. Dungeon-Editor als langfristiges Ziel

Inspirationen:

- **Dungeon Scrawl**
- **Inkarnate**
- **DungeonFog**
- **Owlbear Rodeo**

Besonders interessant sind:

- Räume zeichnen
- Wände setzen
- Türen platzieren
- Props setzen
- Trigger definieren
- Sichtbarkeit / Fog of War
- Gegner setzen
- Startpunkte setzen
- Siegbedingungen definieren

Langfristig soll der Editor eher ein logischer Dungeon-Editor sein und kein komplexer 3D-Level-Editor.

Beispiel:

```text
[ Boden ] [ Wand ] [ Tür ] [ Truhe ] [ Falle ]

        ↓

Dungeon-Daten

        ↓

Babylon.js erzeugt automatisch die 3D-Szene
```

---

## 11. Themes

Gameplay-Geometrie und Optik sollen getrennt bleiben.

Ein Raum kann dieselbe Geometrie haben, aber unterschiedlich aussehen:

```text
Geometry
   │
   ├── Krypta
   ├── Zwergenmine
   ├── Dunkelelfen-Tempel
   ├── Magierturm
   ├── Schloss
   ├── Eishöhle
   └── Waldruine
```

Beispiel:

```text
Raum 7 × 5

Theme:
[ Krypta ]

→ Steinboden
→ alte Mauern
→ Säulen
→ Kerzen
→ Spinnweben
→ grünliches Umgebungslicht
```

Das erlaubt später große optische Vielfalt bei stabilen Spielregeln.

---

## 12. Inspiration durch 3D-Druck-Dungeon-Systeme

Interessante Referenzen:

- Printable Scenery / OpenLOCK
- Fat Dragon Games / Dragonlock
- Dragon's Rest
- OpenForge
- Cast n Play
- Aether Studios
- Dungeon Blocks

Diese Systeme sind vor allem als **Design- und Modularitäts-Inspiration** interessant.

Mögliche digitale Module:

```text
Floor 1×1
Floor 2×2
Floor 2×4

Wall 1
Wall 2

Corner 90°
T-Junction
Cross-Junction

Door 1
Double Door 2

Column 1×1
Stairs 2×3
Pit 2×2
```

### Wichtig

Ein offenes modulares System bedeutet nicht automatisch, dass alle darin angebotenen Assets frei nutzbar sind.

Vor einer Veröffentlichung müssen die jeweiligen Asset-Lizenzen separat geprüft werden.

---

## 13. Asset-Strategie für den Tech-Prototyp

Für den Prototyp sollen bewusst vorhandene, frei nutzbare Assets eingesetzt werden, damit die technische Entwicklung nicht durch Modellierung blockiert wird.

### Bevorzugte Quelle

**Quaternius**

Interessante Pakete:

- Modular Dungeons Pack
- Fantasy Props MegaKit
- RPG Character Pack
- Dungeon Monsters / Bestiary

Vorteile:

- stilisiert
- farbenfroh
- gut lesbar
- passend zur gewünschten Optik
- viele CC0-Assets
- geeignet für schnelle Prototypen

### Alternative

**Kenney**

Interessante Pakete:

- Modular Dungeon Kit
- Mini Dungeon
- weitere CC0-Pakete

### Grundsatz

Für v0.1 möglichst wenige Asset-Stile mischen.

Lieber ein konsistenter Look als eine große Menge uneinheitlicher Assets.

---

## 14. Eigene KI-gestützte Assets

Später sollen nicht ausschließlich fertige Asset-Packs verwendet werden.

Eine zusätzliche Strategie ist:

> eigene Props, Charakterideen und Raumobjekte KI-gestützt entwerfen.

Mögliche Pipeline:

```text
KI-Bild / Concept Art
        ↓
3D-Generierung oder manuelle Modellierung
        ↓
Blender
        ↓
Cleanup / UV / Materialien / Rigging
        ↓
GLB / glTF
        ↓
Babylon.js
```

### Besonders geeignet für

- markante Türen
- Truhen
- Altäre
- Säulen
- magische Objekte
- Raumdekoration
- Charakterdesigns
- thematische Props

### Weniger geeignet für einen automatischen "One Click"-Workflow

- perfekt geriggte Spielfiguren
- hochwertige Animationen
- vollständig optimierte Game-Ready-Meshes
- komplexe Charaktere ohne Nachbearbeitung

### Inspiration

Als interessante neue Möglichkeit wurde **Vast Eden / Mira Scene** notiert.

Die Idee ist, KI-generierte Bilder bzw. Szenen später als Ausgangspunkt für 3D-Objekte und Blender-Workflows zu nutzen.

Noch keine feste Technologieentscheidung.

---

# 15. Tech-Prototyp v0.1

## Ziel

Nicht nur ein technischer Bewegungs-Test, sondern ein kleiner **Vertical Slice**, der bereits Lust auf das spätere Spiel macht.

### Definition

> Zwei Spieler betreten über den Browser einen kleinen, visuell ansprechenden 3D-Dungeon, bewegen ihre Figuren abwechselnd über ein Raster, öffnen Türen, erkunden Treppen und entdecken neue Räume und Gegner auf drei Ebenen.

Ebenen und Treppen erweitern den **Vertical Slice**. Das gemeinsame Spielziel lautet:
**alle Bereiche betreten** – jeder Bereich muss aufgedeckt und von mindestens einem
Helden betreten worden sein.

---

## 16. Karte des Prototyps

Sechs Bereiche (fünf Räume und ein T-förmiger Gang) auf drei Ebenen, entsprechend
`docs/game-mechanics.md`, Abschnitt M8:

| Ebene | Bereiche |
|---|---|
| Obergeschoss (1) | Sternwarte über der Magierstube |
| Eingangsebene (0) | Eingangshalle, Gang, Krypta, Magierstube |
| Untergeschoss (−1) | Gebeinkammer unter der Krypta |

Nur die Eingangshalle ist anfangs aufgedeckt. Türen verbinden die Bereiche der
Eingangsebene; die Gruftstiege verbindet Krypta und Gebeinkammer, die Turmtreppe
Magierstube und Sternwarte. Die Ebenen liegen räumlich übereinander.

Verbindungen (schematisch):

```text
┌────────────────┐
│ Eingangshalle  │
│                │
└───────┬────────┘
        │
        │ Gang
        │
    ┌───┴──────┐
    │          │
┌───┴────┐ ┌───┴──────┐
│ Krypta │ │Magierstube│
└────────┘ └───────────┘
    │             │
 Gruftstiege   Turmtreppe
    ↓             ↑
Gebeinkammer   Sternwarte
 Ebene −1      Ebene 1
```

### Eingangshalle

Mögliche Elemente:

- große Holztür
- Fackeln
- Säulen
- Kisten
- Fässer
- Statue
- unterschiedliche Bodenplatten

### Magierstube

Mögliche Elemente:

- Bücherregal
- Tisch
- Bücher
- Tränke
- Kessel
- leuchtender Kristall
- farbiges Licht
- kleiner Partikeleffekt

### Krypta

Mögliche Elemente:

- Steinboden
- Sarkophag
- Kerzen
- Truhe
- Gegner
- leichter Nebel
- düsteres Licht

### Gebeinkammer

- Knochenhaufen und Schädelnischen als markante Elemente
- Sarkophag, Kerzen und Knochenfürst
- grünliches Grablicht und Bodennebel wie in der Krypta

### Sternwarte

- Teleskop und leuchtende Sternenkarte am Boden als markante Elemente
- Bücherregal, Truhe und Sternenleser
- farbiges Sternenlicht

---

## 17. Spieler im Prototyp

Zunächst zwei Figuren:

- Zwerg
- Dunkelelf

Noch keine Klassenlogik.

Unterschiede zunächst nur:

- Modell
- Farbe
- Name

---

## 18. Gameplay im Prototyp

Der minimale Spielfluss:

1. Spiel erstellen
2. zweiter Spieler verbindet sich
3. beide sehen denselben Dungeon
4. Spieler 1 ist am Zug
5. Figur auswählen
6. gültige Felder anzeigen
7. Zielfeld anklicken
8. Server validiert
9. Figur läuft animiert zum Ziel
10. Tür anklicken
11. Server validiert Türaktion
12. Tür öffnet sich
13. bislang verborgener Raum wird sichtbar
14. Raumbeleuchtung wird eingeblendet
15. Gegner wird sichtbar
16. Spieler beendet Zug
17. Spieler 2 ist an der Reihe

Pro Zug stehen **8 Bewegungspunkte (BP) und 1 Aktion** zur Verfügung; Bewegung und
Aktion sind frei kombinierbar. Eine Treppe wird von einem ihrer Anliegerfelder aus
erkundet: **1 Aktion** deckt den Bereich am anderen Ende auf; mit einem verbleibenden
BP steigt der Held im selben Klick hinüber, sonst bleibt er stehen. Jeder Wechsel
zwischen Fuß- und Austrittsfeld kostet in beide Richtungen **1 BP**. Die Treppe selbst ist kein Spielfeld. Restbewegung darf sofort genutzt werden.

Fuß- und Austrittsfeld werden dauerhaft markiert, sobald sie aufgedeckt sind;
die Pfadvorschau kennzeichnet den Ebenenwechsel. Beim Wechsel erscheint kurz der
Ebenenname: **Obergeschoss**, **Eingangsebene** oder **Untergeschoss**.

Der Laufzug zur Gruftstiege bleibt erhalten. Betritt erstmals ein Held einen Bereich
mit dem bekannten Ende einer noch unerkundeten Treppe, folgt einmalig ein Vorzeichen:
Die Kamera schaut kurz zur Treppe, ein Effekt und eine kurze Textzeile erscheinen.
Bei einer abwärts führenden Treppe steigt ein kalter, graublauer Hauch aus dem
Treppenloch; bei einer aufwärts führenden Treppe fallen Sternenfunken herab.

Aufdecken allein erfüllt das Spielziel nicht: Jeder der sechs Bereiche muss auch
von mindestens einem Helden betreten werden. Die Eingangshalle zählt durch die
Startpositionen bereits als betreten.

Noch nicht erforderlich:

- vollständiges Kampfsystem
- Inventar
- Charakterentwicklung
- Klassen
- komplexe Gegner-KI
- Zaubersystem
- Persistenz
- Accounts

---

## 19. Sichtbarkeit / Fog of War

Ein zentraler Effekt des Spiels:

```text
Tür geschlossen
    ↓
Raum unbekannt / verborgen

Tür öffnen
    ↓
Raum entdeckt
    ↓
Boden / Props / Licht erscheinen
    ↓
Gegner werden sichtbar
```

Dieses "Entdecken" soll bereits im Prototyp emotional funktionieren.

Das Erkunden einer Treppe deckt ebenso den verbundenen Bereich samt Gegnern auf.
Aufdecken und Betreten sind getrennte Schritte; aufgedeckte Bereiche bleiben für
beide Spieler sichtbar. Vorzeichen geben einen Hinweis, ohne den Zielbereich aufzudecken.

---

## 20. Meilensteine

### P0 – Rendering

```text
Browser starten
→ Babylon.js-Szene
→ isometrische Kamera
→ sechs Bereiche auf drei Ebenen
→ Treppen und lesbare Ebenenansicht
→ Assets
→ Licht
```

### P1 – Board

```text
Raster
→ Spielfigur
→ Feld auswählen
→ gültige Felder anzeigen
→ Bewegung animieren
→ Treppenwechsel für 1 BP
→ Anliegerfelder und Ebenenwechsel markieren
```

### P2 – Netzwerk

```text
Node.js-Server
→ WebSocket
→ zwei Browser
→ synchronisierter Game State
→ Zugwechsel
```

### P3 – Dungeon Discovery

```text
Tür
→ Raum verborgen
→ Tür öffnen
→ Raum aufdecken
→ Gegner sichtbar
→ Treppe erkunden für 1 Aktion
→ Vorzeichen und Ebenenwechsel inszenieren
→ alle Bereiche aufdecken und betreten
```

---

## 21. Erfolgskriterien für v0.1

Der Prototyp gilt als erfolgreich, wenn:

- er vollständig im Browser läuft
- zwei Clients gleichzeitig verbunden sein können
- beide denselben Spielzustand sehen
- der Server die Zugreihenfolge kontrolliert
- Spieler nur gültige Bewegungen durchführen können
- Figuren über das Raster animiert laufen
- mindestens eine Tür geöffnet werden kann
- ein Raum zunächst unsichtbar ist
- dieser Raum nach dem Öffnen sichtbar wird
- mindestens ein Gegner dabei aufgedeckt wird
- Treppen Bereiche aufdecken und Helden zwischen Ebenen wechseln können
- der Sieg erst nach dem Aufdecken und Betreten aller sechs Bereiche erscheint
- Spieler Aufdecken, Kosten und Ebenenwechsel ohne Erklärung von außen verstehen
- die Darstellung bereits attraktiv genug ist, um das spätere Spielgefühl zu vermitteln

---

## 22. Server und Deployment

Langfristig:

```text
Internet
   │
Reverse Proxy
   │
   ├── game.example.de
   │       │
   │       └── Web Client
   │
   └── api/game socket
           │
           └── Node.js Game Server
```

Für den Tech-Prototyp reicht zunächst lokale Entwicklung:

```text
pnpm dev
```

mit:

- Babylon.js-Client
- Node.js-Server
- zwei Browserfenstern

---

## 23. Spätere mögliche Features

Nicht Teil von v0.1, aber bereits denkbar:

- 1–4 oder mehr Spieler
- kooperatives Spiel
- KI-Dungeonmaster
- Monster-KI
- Kampfsystem
- Würfel
- Zauber
- Inventar
- Gegenstände
- Charakterentwicklung
- Volk + Klasse
- eigene Kampagnen
- Quest-Editor
- Dungeon-Editor
- thematische Tilesets
- Netzwerk-Lobbys
- gespeicherte Spielstände
- Accounts
- Match-Wiederaufnahme
- eigene Karten teilen
- möglicherweise Community-Inhalte

---

## 24. Agenten-/KI-Workflow für die Umsetzung

Für die Umsetzung wurde diskutiert, mehrere Coding-Agenten einzusetzen.

Mögliche Werkzeuge:

- Codex
- Claude Code
- Herdr
- Gas Town
- andere Multi-Agent-Orchestratoren

### Empfehlung für den Anfang

Nicht sofort einen großen Swarm starten.

Besser:

```text
1 Implementierungsagent
+
1 Review-Agent
```

Erst nach stabiler Projektstruktur parallelisieren.

Später mögliche Rollen:

```text
Lead / Architect
├── Babylon.js Client
├── Server
├── Game Core
└── QA / Reviewer
```

Geeignete getrennte Bereiche:

- `apps/client`
- `apps/server`
- `packages/game-core`
- `packages/shared`

Wichtig ist, dass Architektur und gemeinsame Typen vor paralleler Arbeit feststehen.

---

# 25. Noch offene Entscheidungen

Diese Punkte sind bewusst noch nicht festgelegt:

- endgültiger Spielname
- Welt / Lore
- endgültige Völker
- Klassen
- Kampfsystem
- Würfelsystem
- Bewegungsregeln
- exakte Zugreihenfolge
- maximale Spielerzahl
- Regeln für Sichtlinien
- Türen und Interaktionen
- Gegner-KI
- Charakterwerte
- Magiesystem
- Inventar
- Persistenz
- Accountsystem
- endgültiger Grafikstil
- endgültige Asset-Pipeline
- eigener Editor
- KI-Asset-Generierung
- eventuelle Veröffentlichung

---

# 26. Empfohlener Start der nächsten Session

Die nächste Session sollte **nicht noch einmal das Gesamtkonzept diskutieren**, sondern direkt den Tech-Prototypen konkretisieren.

Empfohlene Reihenfolge:

1. Monorepo-Struktur final definieren
2. `Position`, `Tile`, `Room`, `Character`, `GameState`, `GameAction` modellieren
3. WebSocket-Protokoll definieren
4. erste Karte als statisches JSON erstellen
5. Babylon.js-Szene mit Kamera aufsetzen
6. sechs Bereiche auf drei Ebenen mit Treppen rendern
7. eine Figur platzieren
8. Picking + Rasterbewegung
9. Server anbinden
10. zweiten Browser synchronisieren
11. Türen, Treppen, Aufdecken und das Spielziel „alle Bereiche betreten“ implementieren
12. erste Quaternius-Assets integrieren

---

# 27. Kurzfassung für einen Coding-Agenten

```text
Build a browser-first, turn-based 3D fantasy dungeon board game prototype.

Tech:
- TypeScript everywhere
- Babylon.js client
- Vite
- Node.js server
- WebSocket
- Vitest
- monorepo
- authoritative server
- shared protocol/types
- game-core independent of Babylon.js

Prototype:
- 6 connected areas: 5 rooms and 1 T-shaped corridor on 3 stacked levels
- entrance level (0): entrance hall, corridor, crypt, mage room
- basement (-1): bone chamber below the crypt; upper floor (1): observatory above the mage room
- isometric 3D camera
- colorful stylized fantasy graphics
- 2 players
- dwarf + dark elf
- grid-based movement
- alternating turns
- click-to-move
- server validates moves
- animated character movement
- doors
- hidden room
- opening a door reveals room + monster
- 8 movement points and 1 action per turn; movement may continue after the action
- exploring stairs costs 1 action and reveals the connected area; with a movement point left the hero takes the stairs in the same click (1 MP), otherwise stays
- explored stairs connect their endpoint tiles for 1 movement point in either direction; stairs are not tiles
- mark revealed stair endpoint tiles and level changes in the path preview
- briefly show the level name when changing levels
- first entry into an area with the known end of unexplored stairs triggers a brief camera cue, effect and text
- downward stairs: cold gray-blue mist rises; upward stairs: star sparks fall
- bone chamber signature props: bone pile and skull niches
- observatory signature props: telescope and glowing floor star chart
- cooperative goal: reveal every area and have at least one hero enter each area
- success: players understand revealing areas, costs and level changes without external explanation
- initially use CC0 assets, preferably Quaternius
- dungeon layout is data-driven, not hardcoded into 3D meshes

Architecture must support a future dungeon/quest editor and multiplayer expansion.
```

---

## Projektprinzip in einem Satz

> **Ein farbenfrohes, browserbasiertes, rundenbasiertes 3D-Dungeon-Brettspiel mit autoritativem Multiplayer-Server, datengetriebenen Karten und späterem Quest-/Dungeon-Editor.**
