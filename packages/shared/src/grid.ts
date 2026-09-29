import type { Direction, Position } from './types.ts';

export const DIRECTIONS: readonly Direction[] = ['N', 'E', 'S', 'W'];

export const DIRECTION_OFFSETS: Readonly<Record<Direction, Position>> = {
  N: { x: 0, y: -1 },
  E: { x: 1, y: 0 },
  S: { x: 0, y: 1 },
  W: { x: -1, y: 0 },
};

export function posKey(p: Position): string {
  return `${p.x},${p.y}`;
}

export function samePos(a: Position, b: Position): boolean {
  return a.x === b.x && a.y === b.y;
}

export function step(p: Position, dir: Direction): Position {
  const o = DIRECTION_OFFSETS[dir];
  return { x: p.x + o.x, y: p.y + o.y };
}

export function isOrthogonallyAdjacent(a: Position, b: Position): boolean {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y) === 1;
}

/** Direction from a to an orthogonally adjacent b. */
export function directionTo(a: Position, b: Position): Direction {
  if (b.x > a.x) return 'E';
  if (b.x < a.x) return 'W';
  return b.y > a.y ? 'S' : 'N';
}

/** Canonical key of the edge between two orthogonally adjacent tiles (order-independent). */
export function edgeKey(a: Position, b: Position): string {
  const first = a.y < b.y || (a.y === b.y && a.x < b.x) ? a : b;
  const second = first === a ? b : a;
  return `${first.x},${first.y}|${second.x},${second.y}`;
}
