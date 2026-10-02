import { directionTo, posKey, type GameEvent, type Position } from '@dungeon/shared';
import { Board } from './board.ts';
import { computeReachable } from './movement.ts';
import type { GameState } from './state.ts';
import { createView } from './visibility.ts';

/**
 * Steps from every tile to the nearest hero over passable edges (M10). Figures do
 * not count as obstacles here, they move; blocking props do. Hero tiles are 0.
 */
function distanceToHeroes(board: Board, heroes: readonly { readonly position: Position }[]): Map<string, number> {
  const distance = new Map<string, number>();
  let frontier = heroes.map((h) => h.position);
  for (const p of frontier) distance.set(posKey(p), 0);
  for (let d = 1; frontier.length > 0; d++) {
    const next: Position[] = [];
    for (const p of frontier) {
      for (const n of board.neighbours(p)) {
        const key = posKey(n);
        if (distance.has(key) || board.isBlockedByProp(n) || !board.isEdgePassable(p, n)) continue;
        distance.set(key, d);
        next.push(n);
      }
    }
    frontier = next;
  }
  return distance;
}

/**
 * Where a monster walks (M10): to the tile within its budget that is closest to a
 * hero; on a tie the one with fewer steps, then the first in search order (N, E, S, W,
 * stairs). It only moves if that gets it closer, so a monster next to a hero stays.
 */
export function approachPath(board: Board, monsterId: string, from: Position, heroes: readonly { readonly position: Position }[], budget: number): readonly Position[] {
  const distance = distanceToHeroes(board, heroes);
  let best = { distance: distance.get(posKey(from)) ?? Infinity, steps: 0, path: [] as readonly Position[] };
  if (best.distance <= 1) return [];
  for (const tile of computeReachable(board, monsterId, from, budget, true).values()) {
    const d = distance.get(posKey(tile.position)) ?? Infinity;
    if (d < best.distance || (d === best.distance && tile.cost < best.steps)) best = { distance: d, steps: tile.cost, path: tile.path };
  }
  return best.path;
}

/**
 * Monster phase at the end of a round (M10): every awake monster – one in a revealed
 * area – walks up to `monsterMovementPerTurn` steps towards the nearest hero, one after
 * another in map order, each seeing where the others ended up. Monsters never attack.
 */
export function moveMonsters(state: GameState, round: number): { state: GameState; events: GameEvent[] } {
  const budget = state.dungeon.rules.monsterMovementPerTurn;
  let current = state;
  const events: GameEvent[] = [];
  for (const { id } of state.monsters) {
    const view = createView(current);
    const monster = view.monsters.find((m) => m.id === id);
    if (!monster) continue; // dormant in a hidden area
    const path = approachPath(new Board(view), id, monster.position, view.heroes, budget);
    if (path.length === 0) continue;
    const last = path[path.length - 1]!;
    const beforeLast = path.length > 1 ? path[path.length - 2]! : monster.position;
    current = {
      ...current,
      monsters: current.monsters.map((m) => (m.id === id ? { ...m, position: last, facing: directionTo(beforeLast, last) } : m)),
    };
    events.push({ type: 'CHARACTER_MOVED', characterId: id, path });
  }
  if (events.length === 0) return { state, events };
  return { state: { ...current, version: current.version + 1 }, events: [{ type: 'MONSTER_PHASE', round }, ...events] };
}
