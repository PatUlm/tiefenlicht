import { describe, expect, it } from 'vitest';
import { posKey, type DungeonDefinition } from '@dungeon/shared';
import { Board, expandRects, isPropBlocking, propFootprint } from './board.ts';
import { PROTOTYPE_DUNGEON } from './content/index.ts';
import { computeReachable } from './movement.ts';
import { validateDungeon } from './validate.ts';

const withChanges = (changes: Partial<DungeonDefinition>): DungeonDefinition => ({ ...PROTOTYPE_DUNGEON, ...changes });

/** Deliberately malformed variant (bypasses the type system, like hand-edited JSON). */
const malformed = (changes: Record<string, unknown>): unknown => ({ ...PROTOTYPE_DUNGEON, ...changes });

const hall = PROTOTYPE_DUNGEON.areas.find((a) => a.id === 'hall')!;
const mage = PROTOTYPE_DUNGEON.areas.find((a) => a.id === 'mage')!;

describe('validateDungeon', () => {
  it('accepts the v0.1 prototype dungeon', () => {
    expect(validateDungeon(PROTOTYPE_DUNGEON)).toEqual([]);
  });

  it('detects a blocking prop next to a door (softlock)', () => {
    const errors = validateDungeon(
      withChanges({
        props: [...PROTOTYPE_DUNGEON.props, { id: 'x', kind: 'pillar', position: { x: 9, y: 6, level: 0 }, facing: 'S' }],
      }),
    );
    expect(errors.some((e) => e.includes('Anliegerfeld 9,6'))).toBe(true);
  });

  it('keeps monsters off the tiles next to door tiles', () => {
    const errors = validateDungeon(
      withChanges({
        monsters: [...PROTOTYPE_DUNGEON.monsters, { id: 'monster-9', kind: 'skeletonMinion', name: 'x', position: { x: 4, y: 14, level: 0 }, facing: 'N' }],
      }),
    );
    expect(errors).toContain('Monster monster-9 steht neben Anliegerfeld 4,13,0 (Tür door-2)');
  });

  it('detects doors inside a single area and doubly occupied tiles', () => {
    const errors = validateDungeon(
      withChanges({
        doors: [
          ...PROTOTYPE_DUNGEON.doors,
          { id: 'door-9', name: 'x', style: 'iron', edges: [[{ x: 6, y: 1, level: 0 }, { x: 7, y: 1, level: 0 }]] },
        ],
        monsters: [...PROTOTYPE_DUNGEON.monsters, { id: 'monster-9', kind: 'skeletonMinion', name: 'x', position: { x: 7, y: 2, level: 0 }, facing: 'S' }],
      }),
    );
    expect(errors.some((e) => e.includes('innerhalb von hall'))).toBe(true);
    expect(errors.some((e) => e.includes('doppelt belegt'))).toBe(true);
  });

  it('detects stairs whose flight lies on a tile or that lead into the void', () => {
    const errors = validateDungeon(
      withChanges({
        stairs: [
          { id: 'stairs-1', name: 'x', bottom: { x: 17, y: 16, level: 0 }, direction: 'N', style: 'stone' },
          { id: 'stairs-2', name: 'y', bottom: { x: 7, y: 2, level: 0 }, direction: 'N', style: 'ladder' },
        ],
      }),
    );
    expect(errors).toContain('Treppe stairs-1: Treppenlauf 17,15,0 liegt auf einem Feld');
    expect(errors).toContain('Treppe stairs-1: Treppenloch 17,15,1 liegt auf einem Feld');
    expect(errors).toContain('Treppe stairs-2: Austrittsfeld 7,0,1 existiert nicht');
  });

  it('keeps the ends of stairs free and monsters away from them', () => {
    const errors = validateDungeon(
      withChanges({
        monsters: [...PROTOTYPE_DUNGEON.monsters, { id: 'monster-9', kind: 'skeletonMinion', name: 'x', position: { x: 17, y: 14, level: 1 }, facing: 'N' }],
        props: [...PROTOTYPE_DUNGEON.props, { id: 'x', kind: 'barrel', position: { x: 18, y: 16, level: 0 }, facing: 'S' }],
      }),
    );
    expect(errors).toContain('Treppe stairs-1: Anliegerfeld 18,16,0 blockiert');
    expect(errors).toContain('Monster monster-9 steht neben Anliegerfeld 18,14,1 (Treppe stairs-1)');
  });

  it('requires a level on every area and position', () => {
    const areas = PROTOTYPE_DUNGEON.areas.map((a, i) => (i === 0 ? { ...a, level: undefined } : a));
    expect(validateDungeon(malformed({ areas }))).toContain('areas[0].level: Ganzzahl von −99 bis 99 erwartet');
    const stairs = [{ id: 's', name: 'x', bottom: { x: 1, y: 1 }, direction: 'N' }];
    expect(validateDungeon(malformed({ stairs }))).toContain('stairs[0].bottom.level: Ganzzahl von −99 bis 99 erwartet');
  });

  it('only accepts levels and IDs that client actions can address', () => {
    const areas = PROTOTYPE_DUNGEON.areas.map((a) => ({ ...a, level: a.level + 100 }));
    expect(validateDungeon(malformed({ areas }))).toContain('areas[0].level: Ganzzahl von −99 bis 99 erwartet');
    const stairs = PROTOTYPE_DUNGEON.stairs.map((st, i) => (i === 0 ? { ...st, id: 'stairs 1' } : st));
    expect(validateDungeon(malformed({ stairs }))).toContain('stairs[0].id: ID aus 1–64 Zeichen A–Z, a–z, 0–9, _ oder - erwartet');
    const doors = PROTOTYPE_DUNGEON.doors.map((d, i) => (i === 0 ? { ...d, id: 'tür-1' } : d));
    expect(validateDungeon(malformed({ doors }))).toContain('doors[0].id: ID aus 1–64 Zeichen A–Z, a–z, 0–9, _ oder - erwartet');
  });

  it('rejects objectives that are already met at the start', () => {
    const hallOnly = withChanges({ areas: [hall], doors: [], stairs: [], props: [], wallDecor: [], monsters: [] });
    expect(validateDungeon({ ...hallOnly, victory: { type: 'revealAllAreas' } })).toContain('Siegbedingung ist schon zu Beginn erfüllt');
    expect(validateDungeon({ ...hallOnly, victory: { type: 'visitAllAreas' } })).toContain('Siegbedingung ist schon zu Beginn erfüllt');
    expect(validateDungeon({ ...hallOnly, victory: { type: 'clearDungeon' } })).toContain('Siegbedingung ist schon zu Beginn erfüllt');
  });

  it('requires the monster movement rule and every monster to be within a strike for clearDungeon', () => {
    const { monsterMovementPerTurn: _omitted, ...rules } = PROTOTYPE_DUNGEON.rules;
    expect(validateDungeon(malformed({ rules }))).toContain('rules.monsterMovementPerTurn: Ganzzahl ≥ 0 erwartet');
    // A monster walled in by crates (and the crypt's west wall) can never be struck.
    const crates = [
      { x: 1, y: 13 },
      { x: 2, y: 14 },
      { x: 1, y: 15 },
    ].map((p, i) => ({ id: `crate-${i}`, kind: 'crates' as const, position: { ...p, level: 0 }, facing: 'S' as const }));
    const cornered = withChanges({
      props: [...PROTOTYPE_DUNGEON.props, ...crates],
      monsters: [...PROTOTYPE_DUNGEON.monsters, { id: 'monster-9', kind: 'skeletonMinion', name: 'X', position: { x: 1, y: 14, level: 0 }, facing: 'S' }],
    });
    expect(validateDungeon(cornered)).toContain('Monster monster-9 ist für keinen Helden angreifbar');
  });

  it('detects non-orthogonal door edges', () => {
    const errors = validateDungeon(
      withChanges({
        doors: [...PROTOTYPE_DUNGEON.doors.slice(0, 2), { id: 'door-3', name: 'x', style: 'arcane', edges: [[{ x: 15, y: 12, level: 0 }, { x: 16, y: 13, level: 0 }]] }],
      }),
    );
    expect(errors).toContain('Tür door-3: Kante 15,12,0–16,13,0 nicht orthogonal benachbart');
  });

  it('restricts double doors to two parallel, directly adjacent edges', () => {
    const [door1, ...rest] = PROTOTYPE_DUNGEON.doors;
    const gapped = { ...door1!, edges: [door1!.edges[0]!, [{ x: 11, y: 6, level: 0 }, { x: 11, y: 7, level: 0 }]] as const };
    expect(validateDungeon(withChanges({ doors: [gapped, ...rest] }))).toContain(
      'Tür door-1: Doppeltür-Kanten sind nicht parallel und direkt benachbart',
    );
    const triple = { ...door1!, edges: [...door1!.edges, [{ x: 11, y: 6, level: 0 }, { x: 11, y: 7, level: 0 }]] as const };
    expect(validateDungeon(withChanges({ doors: [triple, ...rest] }))).toContain('Tür door-1 hat mehr als zwei Kanten');
  });

  it('detects overlapping areas and tiles outside the grid', () => {
    const errors = validateDungeon(
      withChanges({
        areas: [...PROTOTYPE_DUNGEON.areas, { ...hall, id: 'annex', rects: [{ x: 14, y: 6, w: 7, h: 1 }] }],
      }),
    );
    expect(errors).toContain('Feld 14,6,0 gehört zu hall und annex');
    expect(errors).toContain('Bereich annex: Feld 20,6,0 außerhalb');
  });

  it('detects props spanning two areas', () => {
    const errors = validateDungeon(
      withChanges({
        props: [...PROTOTYPE_DUNGEON.props, { id: 'long', kind: 'table', position: { x: 6, y: 6, level: 0 }, size: { w: 1, h: 2 }, facing: 'S' }],
      }),
    );
    expect(errors).toContain('Prop long liegt nicht vollständig in einem Bereich');
  });

  it('detects missing starts and starts in hidden areas', () => {
    const [first] = PROTOTYPE_DUNGEON.heroStarts;
    expect(validateDungeon(withChanges({ heroStarts: [first!] }))).toContain('Slot 1 braucht genau ein Startfeld');
    const hidden = validateDungeon(withChanges({ heroStarts: [first!, { slot: 1, position: { x: 10, y: 8, level: 0 }, facing: 'S' }] }));
    expect(hidden).toContain('Start 1 liegt nicht in einem initial entdeckten Bereich');
  });

  it('detects duplicate ids and doubly decorated wall sides', () => {
    const [torch] = PROTOTYPE_DUNGEON.wallDecor;
    const errors = validateDungeon(
      withChanges({
        props: [...PROTOTYPE_DUNGEON.props, { ...PROTOTYPE_DUNGEON.props[0]!, position: { x: 8, y: 3, level: 0 } }],
        wallDecor: [...PROTOTYPE_DUNGEON.wallDecor, { ...torch!, id: 'hall-torch-copy', kind: 'banner' }],
      }),
    );
    expect(errors).toContain('Prop-ID doppelt: hall-pillar-1');
    expect(errors).toContain('Wandseite 6,0,0:N trägt mehrere Dekorationen');
    expect(
      validateDungeon(withChanges({ wallDecor: [...PROTOTYPE_DUNGEON.wallDecor, { ...torch!, position: { x: 7, y: 0, level: 0 } }] })),
    ).toContain('Deko-ID doppelt: hall-torch-1');
  });

  it('detects unreachable areas and an unsatisfiable objective', () => {
    const errors = validateDungeon(withChanges({ doors: PROTOTYPE_DUNGEON.doors.filter((d) => d.id !== 'door-3') }));
    expect(errors).toContain('Bereich mage von Start 0 unerreichbar');
    expect(errors).toContain('Siegbedingung unerfüllbar: mage nie entdeckbar');
  });

  it('detects wall decor that does not hang on a wall', () => {
    const errors = validateDungeon(
      withChanges({ wallDecor: [{ id: 'bad', kind: 'torch', position: { x: 7, y: 3, level: 0 }, wall: 'N' }] }),
    );
    expect(errors).toContain('Deko bad hängt an keiner Wand');
  });

  describe('shape checks (malformed JSON never throws)', () => {
    it('rejects non-objects and missing lists', () => {
      expect(validateDungeon(null)).toEqual(['Karte ist kein Objekt']);
      expect(validateDungeon(malformed({ wallDecor: undefined }))).toContain('wallDecor: Liste erwartet');
    });

    it('rejects unknown enum values', () => {
      const errors = validateDungeon(
        malformed({
          props: [{ ...PROTOTYPE_DUNGEON.props[0]!, kind: 'pilar', facing: 'South' }],
          doors: [{ ...PROTOTYPE_DUNGEON.doors[0]!, style: 'arcan' }],
          wallDecor: [{ ...PROTOTYPE_DUNGEON.wallDecor[0]!, wall: 'X' }],
          areas: [{ ...hall, theme: 'lava' }, ...PROTOTYPE_DUNGEON.areas.slice(1)],
        }),
      );
      expect(errors).toEqual(
        expect.arrayContaining([
          'props[0].kind: ungültiger Wert "pilar"',
          'props[0].facing: ungültiger Wert "South"',
          'doors[0].style: ungültiger Wert "arcan"',
          'wallDecor[0].wall: ungültiger Wert "X"',
          'areas[0].theme: ungültiger Wert "lava"',
        ]),
      );
    });

    it('rejects non-integer coordinates, sizes and rules', () => {
      const errors = validateDungeon(
        malformed({
          areas: [{ ...mage, rects: [{ x: 11, y: 13, w: 0, h: 7.5 }] }],
          monsters: [{ ...PROTOTYPE_DUNGEON.monsters[0]!, position: { x: '4', y: 18, level: 0 } }],
          rules: { movementPerTurn: 0, actionsPerTurn: 1 },
        }),
      );
      expect(errors).toEqual(
        expect.arrayContaining([
          'areas[0].rects[0].w: Ganzzahl ≥ 1 erwartet',
          'areas[0].rects[0].h: Ganzzahl ≥ 1 erwartet',
          'monsters[0].position.x: Ganzzahl erwartet',
          'rules.movementPerTurn: Ganzzahl ≥ 1 erwartet',
        ]),
      );
    });

    it('rejects start slots outside the player range', () => {
      const errors = validateDungeon(
        malformed({ heroStarts: [...PROTOTYPE_DUNGEON.heroStarts, { slot: 2, position: { x: 11, y: 1, level: 0 }, facing: 'S' }] }),
      );
      expect(errors).toContain('heroStarts[2].slot: Ganzzahl 0–1 erwartet');
    });
  });
});

describe('prototype map regression', () => {
  it('every free tile is reachable from the start once all doors are open and all stairs explored', () => {
    const d = PROTOTYPE_DUNGEON;
    const board = new Board({
      areas: d.areas.map((a) => ({ id: a.id, tiles: expandRects(a.rects, a.level) })),
      doors: d.doors.map((door) => ({ id: door.id, edges: door.edges, open: true })),
      stairs: d.stairs.map((s) => ({ ...s, explored: true })),
      props: d.props,
      monsters: d.monsters,
      heroes: [],
    });
    const start = d.heroStarts[0]!.position;
    const reachable = computeReachable(board, 'probe', start, Number.MAX_SAFE_INTEGER);
    const blocked = new Set([
      ...d.props.filter(isPropBlocking).flatMap((p) => propFootprint(p).map(posKey)),
      ...d.monsters.map((m) => posKey(m.position)),
    ]);
    const free = d.areas.flatMap((a) => expandRects(a.rects, a.level)).filter((t) => !blocked.has(posKey(t)) && posKey(t) !== posKey(start));
    const unreachable = free.filter((t) => !reachable.has(posKey(t))).map(posKey);
    expect(unreachable).toEqual([]);
  });
});
