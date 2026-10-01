import {
  posKey,
  stairsTop,
  type AreaId,
  type DoorDefinition,
  type GameView,
  type Position,
  type StairsDefinition,
} from '@dungeon/shared';
import { expandRects, propFootprint, stairsEnds } from './board.ts';
import type { GameState } from './state.ts';

/** Area id per tile key for the full (unfiltered) dungeon. */
export function buildTileAreaIndex(state: Pick<GameState, 'dungeon'>): Map<string, AreaId> {
  const index = new Map<string, AreaId>();
  for (const area of state.dungeon.areas) {
    for (const t of expandRects(area.rects, area.level)) index.set(posKey(t), area.id);
  }
  return index;
}

/** All distinct areas touching a door (normally exactly two). */
export function areasOfDoor(door: DoorDefinition, tileAreas: Map<string, AreaId>): AreaId[] {
  const ids = new Set<AreaId>();
  for (const edge of door.edges) {
    for (const p of edge) {
      const id = tileAreas.get(posKey(p));
      if (id !== undefined) ids.add(id);
    }
  }
  return [...ids];
}

/** Areas at the foot and at the landing of stairs. */
export function areasOfStairs(stairs: StairsDefinition, tileAreas: Map<string, AreaId>): AreaId[] {
  const ids = new Set<AreaId>();
  for (const end of stairsEnds(stairs)) {
    const id = tileAreas.get(posKey(end));
    if (id !== undefined) ids.add(id);
  }
  return [...ids];
}

function areaOfPosition(p: Position, tileAreas: Map<string, AreaId>): AreaId | undefined {
  return tileAreas.get(posKey(p));
}

/**
 * Filters the authoritative state down to what players may know (M6):
 * only revealed areas with their props, decor and monsters, plus doors and
 * stairs touching at least one revealed area. The view is identical for all players.
 */
export function createView(state: GameState): GameView {
  const { dungeon } = state;
  const tileAreas = buildTileAreaIndex(state);
  const revealed = new Set(state.revealedAreas);
  const open = new Set(state.openDoors);
  const explored = new Set(state.exploredStairs);
  const inRevealed = (p: Position) => {
    const id = areaOfPosition(p, tileAreas);
    return id !== undefined && revealed.has(id);
  };

  return {
    gameId: state.gameId,
    version: state.version,
    restarts: state.restarts,
    phase: state.phase,
    dungeonName: dungeon.name,
    width: dungeon.width,
    height: dungeon.height,
    areas: dungeon.areas
      .filter((a) => revealed.has(a.id))
      .map((a) => ({ id: a.id, name: a.name, kind: a.kind, theme: a.theme, level: a.level, tiles: expandRects(a.rects, a.level) })),
    doors: dungeon.doors
      .filter((d) => areasOfDoor(d, tileAreas).some((id) => revealed.has(id)))
      .map((d) => ({ id: d.id, name: d.name, edges: d.edges, style: d.style, open: open.has(d.id) })),
    stairs: dungeon.stairs
      .filter((s) => areasOfStairs(s, tileAreas).some((id) => revealed.has(id)))
      .map((s) => ({
        id: s.id,
        name: s.name,
        bottom: s.bottom,
        direction: s.direction,
        style: s.style,
        top: stairsTop(s),
        explored: explored.has(s.id),
      })),
    props: dungeon.props.filter((p) => propFootprint(p).every(inRevealed)),
    wallDecor: dungeon.wallDecor.filter((d) => inRevealed(d.position)),
    monsters: state.monsters
      .filter((m) => inRevealed(m.position))
      .map((m) => ({ ...m, areaId: areaOfPosition(m.position, tileAreas)! })),
    heroes: state.heroes.map((h) => ({ ...h })),
    players: state.players.map((p) => ({ ...p })),
    turn: state.turn,
    objective: {
      type: dungeon.victory.type,
      revealedAreas: state.revealedAreas.length,
      visitedAreas: state.visitedAreas.length,
      totalAreas: dungeon.areas.length,
      completed: state.objectiveCompleted,
    },
    rules: dungeon.rules,
  };
}
