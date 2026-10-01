import type { Direction, Position, StairsDefinition } from './types.ts';

export const DIRECTIONS: readonly Direction[] = ['N', 'E', 'S', 'W'];

export const DIRECTION_OFFSETS: Readonly<Record<Direction, { readonly x: number; readonly y: number }>> = {
  N: { x: 0, y: -1 },
  E: { x: 1, y: 0 },
  S: { x: 0, y: 1 },
  W: { x: -1, y: 0 },
};

export const OPPOSITE: Readonly<Record<Direction, Direction>> = { N: 'S', S: 'N', E: 'W', W: 'E' };

export function posKey(p: Position): string {
  return `${p.x},${p.y},${p.level}`;
}

export function samePos(a: Position, b: Position): boolean {
  return a.x === b.x && a.y === b.y && a.level === b.level;
}

/** Neighbour on the same level. */
export function step(p: Position, dir: Direction): Position {
  const o = DIRECTION_OFFSETS[dir];
  return { x: p.x + o.x, y: p.y + o.y, level: p.level };
}

/** Orthogonal neighbours on the same level (stairs are not adjacency). */
export function isOrthogonallyAdjacent(a: Position, b: Position): boolean {
  return a.level === b.level && Math.abs(a.x - b.x) + Math.abs(a.y - b.y) === 1;
}

/** Horizontal direction from a to b (b orthogonally ahead of a, e.g. a neighbour or the far end of stairs). */
export function directionTo(a: Position, b: Position): Direction {
  if (b.x > a.x) return 'E';
  if (b.x < a.x) return 'W';
  return b.y > a.y ? 'S' : 'N';
}

/** Canonical key of the connection between two tiles (order-independent). */
export function edgeKey(a: Position, b: Position): string {
  const aFirst = a.level !== b.level ? a.level < b.level : a.y !== b.y ? a.y < b.y : a.x < b.x;
  const [first, second] = aFirst ? [a, b] : [b, a];
  return `${posKey(first)}|${posKey(second)}`;
}

/** Tile the flight occupies, on the level of `bottom`. The same cell one level up is the stairwell. */
export function stairsShaft(stairs: Pick<StairsDefinition, 'bottom' | 'direction'>): Position {
  return step(stairs.bottom, stairs.direction);
}

/** Landing tile at the head of the stairs, one level above `bottom`. */
export function stairsTop(stairs: Pick<StairsDefinition, 'bottom' | 'direction'>): Position {
  const beyond = step(stairsShaft(stairs), stairs.direction);
  return { ...beyond, level: stairs.bottom.level + 1 };
}
