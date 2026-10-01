import {
  AREA_KIND_VALUES,
  DIRECTION_VALUES,
  DOOR_STYLE_VALUES,
  MAX_COORDINATE,
  MAX_LEVEL,
  MONSTER_KIND_VALUES,
  PLAYERS_PER_GAME,
  PROP_KIND_VALUES,
  THEME_VALUES,
  VICTORY_TYPE_VALUES,
  WALL_DECOR_KIND_VALUES,
  isId,
  isOrthogonallyAdjacent,
  posKey,
  stairsShaft,
  step,
  type DoorEdge,
  type DungeonDefinition,
  type Position,
} from '@dungeon/shared';
import { Board, expandRects, isPropBlocking, propFootprint, stairsEnds, type BoardSource } from './board.ts';
import { computeReachable } from './movement.ts';


/**
 * Checks a dungeon definition (mechanics M8). Returns a list of human-readable
 * problems; empty means valid. Never throws, even for malformed JSON input, so it
 * doubles as the validation a future dungeon editor needs.
 *
 * Phase 1 checks the shape (types, integers, enum values). Only a well-formed
 * dungeon proceeds to the structural and playability invariants.
 */
export function validateDungeon(input: unknown): string[] {
  const shapeErrors = checkShape(input);
  if (shapeErrors.length > 0) return shapeErrors;
  return checkInvariants(input as DungeonDefinition);
}

// ---------------------------------------------------------------------------
// Phase 1: shape
// ---------------------------------------------------------------------------

type Rec = Record<string, unknown>;

function isRecord(value: unknown): value is Rec {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function checkShape(input: unknown): string[] {
  const errors: string[] = [];
  const err = (msg: string) => errors.push(msg);
  if (!isRecord(input)) return ['Karte ist kein Objekt'];
  const d = input;

  const str = (v: unknown, where: string) => {
    if (typeof v !== 'string' || v.length === 0) err(`${where}: Text erwartet`);
  };
  const int = (v: unknown, where: string, min = -Infinity) => {
    if (!Number.isInteger(v) || (v as number) < min) err(`${where}: Ganzzahl${min > -Infinity ? ` ≥ ${min}` : ''} erwartet`);
  };
  const oneOf = (v: unknown, values: readonly string[], where: string) => {
    if (typeof v !== 'string' || !values.includes(v)) err(`${where}: ungültiger Wert ${JSON.stringify(v)}`);
  };
  // Doors and stairs are addressed by ID in client actions, so their IDs must pass the protocol check.
  const actionId = (v: unknown, where: string) => {
    if (!isId(v)) err(`${where}: ID aus 1–64 Zeichen A–Z, a–z, 0–9, _ oder - erwartet`);
  };
  const level = (v: unknown, where: string) => {
    if (!Number.isInteger(v) || Math.abs(v as number) > MAX_LEVEL) err(`${where}: Ganzzahl von −${MAX_LEVEL} bis ${MAX_LEVEL} erwartet`);
  };
  const pos = (v: unknown, where: string) => {
    if (!isRecord(v)) return err(`${where}: Position erwartet`);
    int(v.x, `${where}.x`);
    int(v.y, `${where}.y`);
    level(v.level, `${where}.level`);
  };
  const list = (key: string, check: (item: Rec, where: string) => void) => {
    const value = d[key];
    if (!Array.isArray(value)) return err(`${key}: Liste erwartet`);
    value.forEach((item, i) => {
      const where = `${key}[${i}]`;
      if (!isRecord(item)) return err(`${where}: Objekt erwartet`);
      check(item, where);
    });
  };

  str(d.id, 'id');
  str(d.name, 'name');
  int(d.width, 'width', 1);
  int(d.height, 'height', 1);
  for (const key of ['width', 'height'] as const) {
    if (Number.isInteger(d[key]) && (d[key] as number) > MAX_COORDINATE) err(`${key}: höchstens ${MAX_COORDINATE} erwartet`);
  }
  if (!isRecord(d.rules)) err('rules: Objekt erwartet');
  else {
    int(d.rules.movementPerTurn, 'rules.movementPerTurn', 1);
    int(d.rules.actionsPerTurn, 'rules.actionsPerTurn', 1);
  }
  if (!isRecord(d.victory)) err('victory: Objekt erwartet');
  else oneOf(d.victory.type, VICTORY_TYPE_VALUES, 'victory.type');

  list('areas', (a, w) => {
    str(a.id, `${w}.id`);
    str(a.name, `${w}.name`);
    oneOf(a.kind, AREA_KIND_VALUES, `${w}.kind`);
    oneOf(a.theme, THEME_VALUES, `${w}.theme`);
    level(a.level, `${w}.level`);
    if (typeof a.initiallyRevealed !== 'boolean') err(`${w}.initiallyRevealed: Wahrheitswert erwartet`);
    if (!Array.isArray(a.rects)) return err(`${w}.rects: Liste erwartet`);
    a.rects.forEach((r: unknown, i: number) => {
      const rw = `${w}.rects[${i}]`;
      if (!isRecord(r)) return err(`${rw}: Rechteck erwartet`);
      int(r.x, `${rw}.x`);
      int(r.y, `${rw}.y`);
      int(r.w, `${rw}.w`, 1);
      int(r.h, `${rw}.h`, 1);
    });
  });
  list('doors', (door, w) => {
    actionId(door.id, `${w}.id`);
    str(door.name, `${w}.name`);
    oneOf(door.style, DOOR_STYLE_VALUES, `${w}.style`);
    if (!Array.isArray(door.edges)) return err(`${w}.edges: Liste erwartet`);
    door.edges.forEach((e: unknown, i: number) => {
      if (!Array.isArray(e) || e.length !== 2) return err(`${w}.edges[${i}]: Paar aus zwei Positionen erwartet`);
      pos(e[0], `${w}.edges[${i}][0]`);
      pos(e[1], `${w}.edges[${i}][1]`);
    });
  });
  list('stairs', (st, w) => {
    actionId(st.id, `${w}.id`);
    str(st.name, `${w}.name`);
    pos(st.bottom, `${w}.bottom`);
    oneOf(st.direction, DIRECTION_VALUES, `${w}.direction`);
  });
  list('props', (p, w) => {
    str(p.id, `${w}.id`);
    oneOf(p.kind, PROP_KIND_VALUES, `${w}.kind`);
    pos(p.position, `${w}.position`);
    oneOf(p.facing, DIRECTION_VALUES, `${w}.facing`);
    if (p.size !== undefined) {
      if (!isRecord(p.size)) err(`${w}.size: Objekt erwartet`);
      else {
        int(p.size.w, `${w}.size.w`, 1);
        int(p.size.h, `${w}.size.h`, 1);
      }
    }
    if (p.blocking !== undefined && typeof p.blocking !== 'boolean') err(`${w}.blocking: Wahrheitswert erwartet`);
  });
  list('wallDecor', (decor, w) => {
    str(decor.id, `${w}.id`);
    oneOf(decor.kind, WALL_DECOR_KIND_VALUES, `${w}.kind`);
    pos(decor.position, `${w}.position`);
    oneOf(decor.wall, DIRECTION_VALUES, `${w}.wall`);
  });
  list('monsters', (m, w) => {
    str(m.id, `${w}.id`);
    str(m.name, `${w}.name`);
    oneOf(m.kind, MONSTER_KIND_VALUES, `${w}.kind`);
    pos(m.position, `${w}.position`);
    oneOf(m.facing, DIRECTION_VALUES, `${w}.facing`);
  });
  list('heroStarts', (s, w) => {
    if (!Number.isInteger(s.slot) || (s.slot as number) < 0 || (s.slot as number) >= PLAYERS_PER_GAME) {
      err(`${w}.slot: Ganzzahl 0–${PLAYERS_PER_GAME - 1} erwartet`);
    }
    pos(s.position, `${w}.position`);
    oneOf(s.facing, DIRECTION_VALUES, `${w}.facing`);
  });
  return errors;
}

// ---------------------------------------------------------------------------
// Phase 2: structure and playability
// ---------------------------------------------------------------------------

/** Orders an edge so that comparisons do not depend on the authored tile order. */
function normalizeEdge([a, b]: DoorEdge): [Position, Position] {
  return a.y < b.y || (a.y === b.y && a.x < b.x) ? [a, b] : [b, a];
}

/** Two door edges form a valid double door: parallel and directly side by side. */
function isDoubleDoor(e1: DoorEdge, e2: DoorEdge): boolean {
  const [a1, b1] = normalizeEdge(e1);
  const [a2, b2] = normalizeEdge(e2);
  const horizontal1 = a1.y !== b1.y; // edge crossed by a north–south step
  const horizontal2 = a2.y !== b2.y;
  if (horizontal1 !== horizontal2 || a1.level !== a2.level) return false;
  return horizontal1 ? a1.y === a2.y && Math.abs(a1.x - a2.x) === 1 : a1.x === a2.x && Math.abs(a1.y - a2.y) === 1;
}

function checkInvariants(d: DungeonDefinition): string[] {
  const errors: string[] = [];
  const err = (msg: string) => errors.push(msg);

  const unique = (label: string, ids: string[]) => {
    const seen = new Set<string>();
    for (const id of ids) {
      if (seen.has(id)) err(`${label}-ID doppelt: ${id}`);
      seen.add(id);
    }
  };
  unique('Bereich', d.areas.map((a) => a.id));
  unique('Tür', d.doors.map((x) => x.id));
  unique('Treppe', d.stairs.map((x) => x.id));
  unique('Prop', d.props.map((x) => x.id));
  unique('Monster', d.monsters.map((x) => x.id));
  unique('Deko', d.wallDecor.map((x) => x.id));

  // Areas: disjoint per level, non-empty, inside the grid.
  const tileArea = new Map<string, string>();
  for (const area of d.areas) {
    const tiles = expandRects(area.rects, area.level);
    if (tiles.length === 0) err(`Bereich ${area.id} ist leer`);
    for (const t of tiles) {
      if (t.x < 0 || t.y < 0 || t.x >= d.width || t.y >= d.height) err(`Bereich ${area.id}: Feld ${posKey(t)} außerhalb`);
      const existing = tileArea.get(posKey(t));
      if (existing !== undefined) err(`Feld ${posKey(t)} gehört zu ${existing} und ${area.id}`);
      tileArea.set(posKey(t), area.id);
    }
  }
  if (!d.areas.some((a) => a.initiallyRevealed)) err('Kein Bereich ist initial entdeckt');

  // Doors: 1–2 orthogonal edges between exactly one pair of different areas, no shared edges.
  const usedEdges = new Set<string>();
  for (const door of d.doors) {
    if (door.edges.length === 0) err(`Tür ${door.id} hat keine Kante`);
    if (door.edges.length > 2) err(`Tür ${door.id} hat mehr als zwei Kanten`);
    if (door.edges.length === 2 && !isDoubleDoor(door.edges[0]!, door.edges[1]!)) {
      err(`Tür ${door.id}: Doppeltür-Kanten sind nicht parallel und direkt benachbart`);
    }
    const pairs = new Set<string>();
    for (const [a, b] of door.edges) {
      if (!isOrthogonallyAdjacent(a, b)) err(`Tür ${door.id}: Kante ${posKey(a)}–${posKey(b)} nicht orthogonal benachbart`);
      const areaA = tileArea.get(posKey(a));
      const areaB = tileArea.get(posKey(b));
      if (!areaA || !areaB) err(`Tür ${door.id}: Kante liegt nicht zwischen existierenden Feldern`);
      else if (areaA === areaB) err(`Tür ${door.id}: Kante liegt innerhalb von ${areaA}`);
      else pairs.add([areaA, areaB].sort().join('|'));
      const key = [posKey(a), posKey(b)].sort().join('|');
      if (usedEdges.has(key)) err(`Kante ${key} trägt mehrere Türen`);
      usedEdges.add(key);
    }
    if (pairs.size > 1) err(`Tür ${door.id} verbindet mehr als ein Bereichspaar`);
  }

  // Stairs: foot and landing exist in different areas; the flight and the stairwell
  // above it are no playing fields; every tile is the end of at most one flight.
  const stairsEndTiles = new Set<string>();
  const inGrid = (p: Position) => p.x >= 0 && p.y >= 0 && p.x < d.width && p.y < d.height;
  for (const stairs of d.stairs) {
    const [bottom, top] = stairsEnds(stairs);
    const areaBottom = tileArea.get(posKey(bottom));
    const areaTop = tileArea.get(posKey(top));
    if (!areaBottom) err(`Treppe ${stairs.id}: Fußfeld ${posKey(bottom)} existiert nicht`);
    if (!areaTop) err(`Treppe ${stairs.id}: Austrittsfeld ${posKey(top)} existiert nicht`);
    if (areaBottom && areaBottom === areaTop) err(`Treppe ${stairs.id}: Fuß und Austritt liegen beide in ${areaBottom}`);
    const shaft = stairsShaft(stairs);
    const well = { ...shaft, level: top.level };
    if (!inGrid(shaft)) err(`Treppe ${stairs.id}: Treppenlauf ${posKey(shaft)} außerhalb`);
    if (tileArea.has(posKey(shaft))) err(`Treppe ${stairs.id}: Treppenlauf ${posKey(shaft)} liegt auf einem Feld`);
    if (tileArea.has(posKey(well))) err(`Treppe ${stairs.id}: Treppenloch ${posKey(well)} liegt auf einem Feld`);
    for (const end of [bottom, top]) {
      if (stairsEndTiles.has(posKey(end))) err(`Feld ${posKey(end)} ist Ende mehrerer Treppen`);
      stairsEndTiles.add(posKey(end));
    }
  }

  // Occupancy: props, monsters and starts never share a tile; props lie in one area.
  const occupied = new Map<string, string>();
  const occupy = (p: Position, what: string) => {
    const key = posKey(p);
    if (!tileArea.has(key)) err(`${what} steht auf nicht existierendem Feld ${key}`);
    const other = occupied.get(key);
    if (other) err(`Feld ${key} doppelt belegt: ${other} und ${what}`);
    occupied.set(key, what);
  };
  for (const prop of d.props) {
    const areas = new Set(propFootprint(prop).map((t) => tileArea.get(posKey(t))));
    if (areas.size !== 1) err(`Prop ${prop.id} liegt nicht vollständig in einem Bereich`);
    for (const t of propFootprint(prop)) occupy(t, `Prop ${prop.id}`);
  }
  for (const m of d.monsters) occupy(m.position, `Monster ${m.id}`);
  for (const s of d.heroStarts) occupy(s.position, `Start ${s.slot}`);

  // Starts: one per slot, in an initially revealed area.
  for (let slot = 0; slot < PLAYERS_PER_GAME; slot++) {
    const starts = d.heroStarts.filter((s) => s.slot === slot);
    if (starts.length !== 1) err(`Slot ${slot} braucht genau ein Startfeld`);
    for (const s of starts) {
      const area = d.areas.find((a) => a.id === tileArea.get(posKey(s.position)));
      if (!area?.initiallyRevealed) err(`Start ${slot} liegt nicht in einem initial entdeckten Bereich`);
    }
  }

  // Tiles next to doors and at both ends of stairs must stay free, otherwise the
  // passage may become unusable. Monsters additionally keep one tile distance so
  // they never crowd a doorway or a staircase (M8).
  const blockers = new Set<string>(d.props.filter(isPropBlocking).flatMap((p) => propFootprint(p).map(posKey)));
  const passageTiles: { passage: string; tile: Position }[] = [
    ...d.doors.flatMap((door) => door.edges.flatMap((edge) => edge.map((tile) => ({ passage: `Tür ${door.id}`, tile })))),
    ...d.stairs.flatMap((stairs) => stairsEnds(stairs).map((tile) => ({ passage: `Treppe ${stairs.id}`, tile }))),
  ];
  for (const { passage, tile } of passageTiles) {
    if (blockers.has(posKey(tile))) err(`${passage}: Anliegerfeld ${posKey(tile)} blockiert`);
    for (const m of d.monsters) {
      if (posKey(m.position) === posKey(tile)) err(`${passage}: Anliegerfeld ${posKey(tile)} blockiert`);
      else if (isOrthogonallyAdjacent(m.position, tile)) err(`Monster ${m.id} steht neben Anliegerfeld ${posKey(tile)} (${passage})`);
    }
  }

  // Wall decor: at most one decoration per tile side.
  const decorSides = new Set<string>();
  for (const decor of d.wallDecor) {
    const key = `${posKey(decor.position)}:${decor.wall}`;
    if (decorSides.has(key)) err(`Wandseite ${key} trägt mehrere Dekorationen`);
    decorSides.add(key);
  }

  const fullSource = (revealed: ReadonlySet<string>, openDoors: ReadonlySet<string>, explored: ReadonlySet<string>): BoardSource => ({
    areas: d.areas.filter((a) => revealed.has(a.id)).map((a) => ({ id: a.id, tiles: expandRects(a.rects, a.level) })),
    doors: d.doors.map((door) => ({ id: door.id, edges: door.edges, open: openDoors.has(door.id) })),
    stairs: d.stairs.map((st) => ({ ...st, explored: explored.has(st.id) })),
    props: d.props,
    monsters: d.monsters,
    heroes: [],
  });

  // Wall decor must hang on an actual wall.
  const allAreas = new Set(d.areas.map((a) => a.id));
  const fullBoard = new Board(fullSource(allAreas, new Set(), new Set()));
  for (const decor of d.wallDecor) {
    if (!fullBoard.hasTile(decor.position)) err(`Deko ${decor.id} auf nicht existierendem Feld`);
    else if (!fullBoard.isWall(decor.position, step(decor.position, decor.wall))) err(`Deko ${decor.id} hängt an keiner Wand`);
  }

  if (errors.length > 0) return errors;

  // Reachability with all doors open and all stairs explored: every area from every start.
  const openBoard = new Board(fullSource(allAreas, new Set(d.doors.map((x) => x.id)), new Set(d.stairs.map((x) => x.id))));
  for (const s of d.heroStarts) {
    const reachable = computeReachable(openBoard, 'validator', s.position, Number.MAX_SAFE_INTEGER);
    const reachedAreas = new Set([tileArea.get(posKey(s.position))]);
    for (const r of reachable.values()) reachedAreas.add(tileArea.get(posKey(r.position)));
    for (const a of d.areas) if (!reachedAreas.has(a.id)) err(`Bereich ${a.id} von Start ${s.slot} unerreichbar`);
  }

  // Victory satisfiable: progressively open every door and explore all stairs that become reachable.
  // Both victory types need every area revealable; visiting then only needs reachability (checked above).
  const revealed = new Set(d.areas.filter((a) => a.initiallyRevealed).map((a) => a.id));
  const opened = new Set<string>();
  const explored = new Set<string>();
  const start = d.heroStarts[0]!.position;
  for (let changed = true; changed; ) {
    changed = false;
    const board = new Board(fullSource(revealed, opened, explored));
    const standable = [start, ...[...computeReachable(board, 'validator', start, Number.MAX_SAFE_INTEGER).values()].map((r) => r.position)];
    for (const door of d.doors) {
      if (opened.has(door.id)) continue;
      const usable = door.edges.some((edge) => edge.some((p) => standable.some((q) => posKey(p) === posKey(q))));
      if (!usable) continue;
      opened.add(door.id);
      for (const edge of door.edges) for (const p of edge) revealed.add(tileArea.get(posKey(p))!);
      changed = true;
    }
    for (const stairs of d.stairs) {
      if (explored.has(stairs.id)) continue;
      const ends = stairsEnds(stairs);
      if (!ends.some((p) => standable.some((q) => posKey(p) === posKey(q)))) continue;
      explored.add(stairs.id);
      for (const p of ends) revealed.add(tileArea.get(posKey(p))!);
      changed = true;
    }
  }
  for (const a of d.areas) if (!revealed.has(a.id)) err(`Siegbedingung unerfüllbar: ${a.id} nie entdeckbar`);

  // An objective met before the first move would never be announced (GAME_WON follows actions only).
  const metAtStart =
    d.victory.type === 'revealAllAreas'
      ? d.areas.every((a) => a.initiallyRevealed)
      : d.areas.every((a) => d.heroStarts.some((s) => tileArea.get(posKey(s.position)) === a.id));
  if (metAtStart) err('Siegbedingung ist schon zu Beginn erfüllt');

  return errors;
}
