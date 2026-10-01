import { describe, expect, it } from 'vitest';
import type { PropDefinition } from '@dungeon/shared';
import { Board, expandRects, type BoardSource } from './board.ts';
import { computeReachable, findPath } from './movement.ts';

// Two 3×3 rooms side by side (x 0–2 and x 3–5), joined by a door on edge (2,1)–(3,1).
function source(overrides: Partial<BoardSource> = {}, doorOpen = false): BoardSource {
  const room = (id: string, x0: number) => ({
    id,
    tiles: [0, 1, 2].flatMap((y) => [0, 1, 2].map((dx) => ({ x: x0 + dx, y, level: 0 }))),
  });
  return {
    areas: [room('a', 0), room('b', 3)],
    doors: [{ id: 'd', edges: [[{ x: 2, y: 1, level: 0 }, { x: 3, y: 1, level: 0 }]], open: doorOpen }],
    stairs: [],
    props: [],
    monsters: [],
    heroes: [{ id: 'h1', position: { x: 0, y: 1, level: 0 } }],
    ...overrides,
  };
}

describe('Board', () => {
  it('derives walls between different areas except on door edges', () => {
    const board = new Board(source());
    expect(board.isWall({ x: 2, y: 0, level: 0 }, { x: 3, y: 0, level: 0 })).toBe(true);
    expect(board.isWall({ x: 2, y: 1, level: 0 }, { x: 3, y: 1, level: 0 })).toBe(false);
    expect(board.isWall({ x: 0, y: 0, level: 0 }, { x: 1, y: 0, level: 0 })).toBe(false);
    expect(board.isWall({ x: 0, y: 0, level: 0 }, { x: 0, y: -1, level: 0 })).toBe(true);
  });

  it('treats a closed door as impassable and an open door as passable', () => {
    expect(new Board(source()).isEdgePassable({ x: 2, y: 1, level: 0 }, { x: 3, y: 1, level: 0 })).toBe(false);
    expect(new Board(source({}, true)).isEdgePassable({ x: 2, y: 1, level: 0 }, { x: 3, y: 1, level: 0 })).toBe(true);
  });
});

describe('computeReachable', () => {
  it('moves orthogonally only and respects the budget', () => {
    const reachable = computeReachable(new Board(source()), 'h1', { x: 0, y: 1, level: 0 }, 1);
    expect([...reachable.keys()].sort()).toEqual(['0,0,0', '0,2,0', '1,1,0']);
  });

  it('does not cross walls or closed doors', () => {
    const reachable = computeReachable(new Board(source()), 'h1', { x: 0, y: 1, level: 0 }, 20);
    expect([...reachable.values()].every((r) => r.position.x <= 2)).toBe(true);
  });

  it('crosses open doors', () => {
    const reachable = computeReachable(new Board(source({}, true)), 'h1', { x: 0, y: 1, level: 0 }, 3);
    expect(reachable.get('3,1,0')?.cost).toBe(3);
  });

  it('lets heroes pass through allies but not end on them', () => {
    const board = new Board(
      source({
        heroes: [
          { id: 'h1', position: { x: 0, y: 1, level: 0 } },
          { id: 'h2', position: { x: 1, y: 1, level: 0 } },
        ],
        // Force the corridor through the ally: block (1,0) and (1,2).
        props: [
          { id: 'p1', kind: 'barrel', position: { x: 1, y: 0, level: 0 }, facing: 'S' },
          { id: 'p2', kind: 'barrel', position: { x: 1, y: 2, level: 0 }, facing: 'S' },
        ] satisfies PropDefinition[],
      }),
    );
    const reachable = computeReachable(board, 'h1', { x: 0, y: 1, level: 0 }, 2);
    expect(reachable.has('1,1,0')).toBe(false);
    expect(reachable.get('2,1,0')?.path).toEqual([
      { x: 1, y: 1, level: 0 },
      { x: 2, y: 1, level: 0 },
    ]);
  });

  it('is blocked by monsters and blocking props, but not by non-blocking props', () => {
    const board = new Board(
      source({
        monsters: [{ id: 'm', position: { x: 1, y: 1, level: 0 } }],
        props: [
          { id: 'p', kind: 'barrel', position: { x: 0, y: 0, level: 0 }, facing: 'S' },
          { id: 'q', kind: 'rubble', position: { x: 0, y: 2, level: 0 }, facing: 'S', blocking: false },
        ],
      }),
    );
    const reachable = computeReachable(board, 'h1', { x: 0, y: 1, level: 0 }, 1);
    expect([...reachable.keys()]).toEqual(['0,2,0']);
  });

  it('blocks every tile of a multi-tile prop', () => {
    const board = new Board(
      source({ props: [{ id: 't', kind: 'table', position: { x: 1, y: 0, level: 0 }, size: { w: 1, h: 3 }, facing: 'S' }] }),
    );
    const reachable = computeReachable(board, 'h1', { x: 0, y: 1, level: 0 }, 10);
    expect([...reachable.values()].every((r) => r.position.x === 0)).toBe(true);
  });
});

describe('findPath', () => {
  const board = () =>
    new Board(
      source({
        heroes: [
          { id: 'h1', position: { x: 0, y: 1, level: 0 } },
          { id: 'h2', position: { x: 2, y: 2, level: 0 } },
        ],
        monsters: [{ id: 'm', position: { x: 2, y: 0, level: 0 } }],
      }),
    );

  it('returns a deterministic shortest path (N, E, S, W order)', () => {
    const result = findPath(board(), 'h1', { x: 0, y: 1, level: 0 }, { x: 1, y: 0, level: 0 }, 5);
    expect(result).toEqual({
      ok: true,
      path: [
        { x: 0, y: 0, level: 0 },
        { x: 1, y: 0, level: 0 },
      ],
    });
  });

  it('classifies invalid requests', () => {
    const b = board();
    const from = { x: 0, y: 1, level: 0 };
    expect(findPath(b, 'h1', from, from, 5)).toMatchObject({ ok: false, reason: 'INVALID_TARGET' });
    expect(findPath(b, 'h1', from, { x: 9, y: 9, level: 0 }, 5)).toMatchObject({ ok: false, reason: 'INVALID_TARGET' });
    expect(findPath(b, 'h1', from, { x: 2, y: 0, level: 0 }, 5)).toMatchObject({ ok: false, reason: 'TARGET_OCCUPIED' });
    expect(findPath(b, 'h1', from, { x: 2, y: 2, level: 0 }, 5)).toMatchObject({ ok: false, reason: 'TARGET_OCCUPIED' });
    expect(findPath(b, 'h1', from, { x: 4, y: 1, level: 0 }, 5)).toMatchObject({ ok: false, reason: 'UNREACHABLE' });
    expect(findPath(b, 'h1', from, { x: 2, y: 1, level: 0 }, 1)).toMatchObject({ ok: false, reason: 'NOT_ENOUGH_MOVEMENT' });
  });
});

describe('stairs', () => {
  // Room a on level 0 (x 0–2) and room u on level 1 (x 4–6). The flight on (3,1)
  // rises eastwards from the foot (2,1,0) to the landing (4,1,1).
  const source = (explored: boolean): BoardSource => ({
    areas: [
      { id: 'a', tiles: expandRects([{ x: 0, y: 0, w: 3, h: 3 }], 0) },
      { id: 'u', tiles: expandRects([{ x: 4, y: 0, w: 3, h: 3 }], 1) },
    ],
    doors: [],
    stairs: [{ id: 's', bottom: { x: 2, y: 1, level: 0 }, direction: 'E', explored }],
    props: [],
    monsters: [],
    heroes: [],
  });

  it('opens only the walls towards the flight and the stairwell', () => {
    const board = new Board(source(false));
    expect(board.isWall({ x: 2, y: 1, level: 0 }, { x: 3, y: 1, level: 0 })).toBe(false);
    expect(board.isWall({ x: 2, y: 0, level: 0 }, { x: 3, y: 0, level: 0 })).toBe(true);
    expect(board.isWall({ x: 4, y: 1, level: 1 }, { x: 3, y: 1, level: 1 })).toBe(false);
    expect(board.isWall({ x: 4, y: 2, level: 1 }, { x: 3, y: 2, level: 1 })).toBe(true);
  });

  it('leads from the foot straight to the landing for one point once explored', () => {
    const from = { x: 2, y: 1, level: 0 };
    expect(computeReachable(new Board(source(false)), 'h', from, 3).has('4,1,1')).toBe(false);
    const reachable = computeReachable(new Board(source(true)), 'h', from, 2);
    expect(reachable.get('4,1,1')).toMatchObject({ cost: 1, path: [{ x: 4, y: 1, level: 1 }] });
    expect(reachable.get('5,1,1')?.cost).toBe(2);
    // The cell of the flight itself is no playing field.
    expect([...reachable.keys()].some((k) => k.startsWith('3,1,'))).toBe(false);
  });

  it('never treats tiles on different levels as neighbours', () => {
    const board = new Board({
      ...source(false),
      areas: [
        { id: 'a', tiles: expandRects([{ x: 0, y: 0, w: 3, h: 3 }], 0) },
        { id: 'b', tiles: expandRects([{ x: 0, y: 0, w: 3, h: 3 }], 1) },
      ],
    });
    expect(board.isEdgePassable({ x: 0, y: 0, level: 0 }, { x: 0, y: 0, level: 1 })).toBe(false);
    expect(board.isWall({ x: 0, y: 0, level: 0 }, { x: 1, y: 0, level: 0 })).toBe(false);
  });
});
