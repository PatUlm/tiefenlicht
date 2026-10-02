import { describe, expect, it } from 'vitest';
import type { Position } from '@dungeon/shared';
import { Board, type BoardSource } from './board.ts';
import { approachPath } from './monsters.ts';
import { computeReachable } from './movement.ts';

const at = (x: number, y: number): Position => ({ x, y, level: 0 });

// Two 3×3 rooms side by side (x 0–2 and x 3–5), joined by a door on edge (2,1)–(3,1).
function board(monster: Position, heroes: Position[], doorOpen = true): Board {
  const room = (id: string, x0: number) => ({ id, tiles: [0, 1, 2].flatMap((y) => [0, 1, 2].map((dx) => at(x0 + dx, y))) });
  const source: BoardSource = {
    areas: [room('a', 0), room('b', 3)],
    doors: [{ id: 'd', edges: [[at(2, 1), at(3, 1)]], open: doorOpen }],
    stairs: [],
    props: [],
    monsters: [{ id: 'm', position: monster }],
    heroes: heroes.map((position, i) => ({ id: `h${i}`, position })),
  };
  return new Board(source);
}

describe('approachPath', () => {
  it('walks its budget towards the nearest hero, through an open door', () => {
    expect(approachPath(board(at(5, 1), [at(0, 1)]), 'm', at(5, 1), [{ position: at(0, 1) }], 3)).toEqual([at(4, 1), at(3, 1), at(2, 1)]);
  });

  it('stops next to the hero instead of walking past it', () => {
    expect(approachPath(board(at(5, 1), [at(2, 1)]), 'm', at(5, 1), [{ position: at(2, 1) }], 3)).toEqual([at(4, 1), at(3, 1)]);
  });

  it('stays when already next to a hero, or when no way leads to one', () => {
    expect(approachPath(board(at(1, 1), [at(0, 1)]), 'm', at(1, 1), [{ position: at(0, 1) }], 3)).toEqual([]);
    expect(approachPath(board(at(5, 1), [at(0, 1)], false), 'm', at(5, 1), [{ position: at(0, 1) }], 3)).toEqual([]);
  });

  it('a wall is no adjacency: a monster across it still walks round to the door', () => {
    // (3,0) and (2,0) touch, but a wall separates the rooms there.
    expect(approachPath(board(at(3, 0), [at(2, 0)]), 'm', at(3, 0), [{ position: at(2, 0) }], 3)).toEqual([at(3, 1), at(2, 1)]);
  });
});

describe('computeReachable for monsters', () => {
  it('heroes block a moving monster, while heroes may pass each other', () => {
    // A hero in the doorway (2,1) closes room b off from room a.
    const b = board(at(5, 1), [at(2, 1)]);
    expect(computeReachable(b, 'm', at(5, 1), 9, true).has('1,1,0')).toBe(false);
    expect(computeReachable(b, 'h9', at(3, 1), 9).has('1,1,0')).toBe(true);
  });
});
