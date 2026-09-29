import { describe, expect, it } from 'vitest';
import type { PropDefinition } from '@dungeon/shared';
import { Board, type BoardSource } from './board.ts';
import { computeReachable, findPath } from './movement.ts';

// Two 3×3 rooms side by side (x 0–2 and x 3–5), joined by a door on edge (2,1)–(3,1).
function source(overrides: Partial<BoardSource> = {}, doorOpen = false): BoardSource {
  const room = (id: string, x0: number) => ({
    id,
    tiles: [0, 1, 2].flatMap((y) => [0, 1, 2].map((dx) => ({ x: x0 + dx, y }))),
  });
  return {
    areas: [room('a', 0), room('b', 3)],
    doors: [{ id: 'd', edges: [[{ x: 2, y: 1 }, { x: 3, y: 1 }]], open: doorOpen }],
    props: [],
    monsters: [],
    heroes: [{ id: 'h1', position: { x: 0, y: 1 } }],
    ...overrides,
  };
}

describe('Board', () => {
  it('derives walls between different areas except on door edges', () => {
    const board = new Board(source());
    expect(board.isWall({ x: 2, y: 0 }, { x: 3, y: 0 })).toBe(true);
    expect(board.isWall({ x: 2, y: 1 }, { x: 3, y: 1 })).toBe(false);
    expect(board.isWall({ x: 0, y: 0 }, { x: 1, y: 0 })).toBe(false);
    expect(board.isWall({ x: 0, y: 0 }, { x: 0, y: -1 })).toBe(true);
  });

  it('treats a closed door as impassable and an open door as passable', () => {
    expect(new Board(source()).isEdgePassable({ x: 2, y: 1 }, { x: 3, y: 1 })).toBe(false);
    expect(new Board(source({}, true)).isEdgePassable({ x: 2, y: 1 }, { x: 3, y: 1 })).toBe(true);
  });
});

describe('computeReachable', () => {
  it('moves orthogonally only and respects the budget', () => {
    const reachable = computeReachable(new Board(source()), 'h1', { x: 0, y: 1 }, 1);
    expect([...reachable.keys()].sort()).toEqual(['0,0', '0,2', '1,1']);
  });

  it('does not cross walls or closed doors', () => {
    const reachable = computeReachable(new Board(source()), 'h1', { x: 0, y: 1 }, 20);
    expect([...reachable.values()].every((r) => r.position.x <= 2)).toBe(true);
  });

  it('crosses open doors', () => {
    const reachable = computeReachable(new Board(source({}, true)), 'h1', { x: 0, y: 1 }, 3);
    expect(reachable.get('3,1')?.cost).toBe(3);
  });

  it('lets heroes pass through allies but not end on them', () => {
    const board = new Board(
      source({
        heroes: [
          { id: 'h1', position: { x: 0, y: 1 } },
          { id: 'h2', position: { x: 1, y: 1 } },
        ],
        // Force the corridor through the ally: block (1,0) and (1,2).
        props: [
          { id: 'p1', kind: 'barrel', position: { x: 1, y: 0 }, facing: 'S' },
          { id: 'p2', kind: 'barrel', position: { x: 1, y: 2 }, facing: 'S' },
        ] satisfies PropDefinition[],
      }),
    );
    const reachable = computeReachable(board, 'h1', { x: 0, y: 1 }, 2);
    expect(reachable.has('1,1')).toBe(false);
    expect(reachable.get('2,1')?.path).toEqual([
      { x: 1, y: 1 },
      { x: 2, y: 1 },
    ]);
  });

  it('is blocked by monsters and blocking props, but not by non-blocking props', () => {
    const board = new Board(
      source({
        monsters: [{ id: 'm', position: { x: 1, y: 1 } }],
        props: [
          { id: 'p', kind: 'barrel', position: { x: 0, y: 0 }, facing: 'S' },
          { id: 'q', kind: 'rubble', position: { x: 0, y: 2 }, facing: 'S', blocking: false },
        ],
      }),
    );
    const reachable = computeReachable(board, 'h1', { x: 0, y: 1 }, 1);
    expect([...reachable.keys()]).toEqual(['0,2']);
  });

  it('blocks every tile of a multi-tile prop', () => {
    const board = new Board(
      source({ props: [{ id: 't', kind: 'table', position: { x: 1, y: 0 }, size: { w: 1, h: 3 }, facing: 'S' }] }),
    );
    const reachable = computeReachable(board, 'h1', { x: 0, y: 1 }, 10);
    expect([...reachable.values()].every((r) => r.position.x === 0)).toBe(true);
  });
});

describe('findPath', () => {
  const board = () =>
    new Board(
      source({
        heroes: [
          { id: 'h1', position: { x: 0, y: 1 } },
          { id: 'h2', position: { x: 2, y: 2 } },
        ],
        monsters: [{ id: 'm', position: { x: 2, y: 0 } }],
      }),
    );

  it('returns a deterministic shortest path (N, E, S, W order)', () => {
    const result = findPath(board(), 'h1', { x: 0, y: 1 }, { x: 1, y: 0 }, 5);
    expect(result).toEqual({
      ok: true,
      path: [
        { x: 0, y: 0 },
        { x: 1, y: 0 },
      ],
    });
  });

  it('classifies invalid requests', () => {
    const b = board();
    const from = { x: 0, y: 1 };
    expect(findPath(b, 'h1', from, from, 5)).toMatchObject({ ok: false, reason: 'INVALID_TARGET' });
    expect(findPath(b, 'h1', from, { x: 9, y: 9 }, 5)).toMatchObject({ ok: false, reason: 'INVALID_TARGET' });
    expect(findPath(b, 'h1', from, { x: 2, y: 0 }, 5)).toMatchObject({ ok: false, reason: 'TARGET_OCCUPIED' });
    expect(findPath(b, 'h1', from, { x: 2, y: 2 }, 5)).toMatchObject({ ok: false, reason: 'TARGET_OCCUPIED' });
    expect(findPath(b, 'h1', from, { x: 4, y: 1 }, 5)).toMatchObject({ ok: false, reason: 'UNREACHABLE' });
    expect(findPath(b, 'h1', from, { x: 2, y: 1 }, 1)).toMatchObject({ ok: false, reason: 'NOT_ENOUGH_MOVEMENT' });
  });
});
