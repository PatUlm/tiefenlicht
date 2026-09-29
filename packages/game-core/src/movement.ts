import { posKey, samePos, type CharacterId, type Position } from '@dungeon/shared';
import type { Board } from './board.ts';

export interface ReachableTile {
  readonly position: Position;
  /** Steps needed to get here. */
  readonly cost: number;
  /** Shortest path from the start (excluding it) to this tile. */
  readonly path: readonly Position[];
}

/**
 * Breadth-first search over the board from `from`, limited to `maxSteps`.
 * Rules (docs/game-mechanics.md M4):
 *  - orthogonal steps only, 1 point each
 *  - tile must exist (be revealed), not hold a blocking prop or a monster
 *  - edge must not be a wall or a closed door
 *  - allied heroes may be passed through, but not ended on
 * Neighbour order N, E, S, W makes the chosen path deterministic.
 *
 * Returns every tile the moving hero may end its move on (start excluded).
 */
export function computeReachable(
  board: Board,
  moverId: CharacterId,
  from: Position,
  maxSteps: number,
): Map<string, ReachableTile> {
  const result = new Map<string, ReachableTile>();
  if (maxSteps <= 0) return result;

  const visited = new Set<string>([posKey(from)]);
  let frontier: { pos: Position; path: Position[] }[] = [{ pos: from, path: [] }];

  for (let cost = 1; cost <= maxSteps && frontier.length > 0; cost++) {
    const next: { pos: Position; path: Position[] }[] = [];
    for (const node of frontier) {
      for (const { pos } of board.neighbours(node.pos)) {
        const key = posKey(pos);
        if (visited.has(key)) continue;
        if (!board.isEdgePassable(node.pos, pos)) continue;
        if (board.isBlockedByProp(pos) || board.monsterAt(pos) !== undefined) continue;
        visited.add(key);
        const path = [...node.path, pos];
        next.push({ pos, path });
        const occupant = board.heroAt(pos);
        if (occupant === undefined || occupant === moverId) {
          result.set(key, { position: pos, cost, path });
        }
      }
    }
    frontier = next;
  }
  return result;
}

export type PathResult =
  | { readonly ok: true; readonly path: readonly Position[] }
  | { readonly ok: false; readonly reason: 'INVALID_TARGET' | 'TARGET_OCCUPIED' | 'UNREACHABLE' | 'NOT_ENOUGH_MOVEMENT' };

/** Validates a move request and returns the shortest path if it is legal. */
export function findPath(
  board: Board,
  moverId: CharacterId,
  from: Position,
  target: Position,
  movementLeft: number,
): PathResult {
  if (samePos(from, target) || !board.hasTile(target)) return { ok: false, reason: 'INVALID_TARGET' };
  if (board.isBlockedByProp(target)) return { ok: false, reason: 'INVALID_TARGET' };
  if (board.monsterAt(target) !== undefined) return { ok: false, reason: 'TARGET_OCCUPIED' };
  const hero = board.heroAt(target);
  if (hero !== undefined && hero !== moverId) return { ok: false, reason: 'TARGET_OCCUPIED' };

  const withinBudget = computeReachable(board, moverId, from, movementLeft).get(posKey(target));
  if (withinBudget) return { ok: true, path: withinBudget.path };

  // Distinguish "too far" from "no path at all" for clearer feedback.
  const unlimited = computeReachable(board, moverId, from, Number.MAX_SAFE_INTEGER);
  return { ok: false, reason: unlimited.has(posKey(target)) ? 'NOT_ENOUGH_MOVEMENT' : 'UNREACHABLE' };
}
