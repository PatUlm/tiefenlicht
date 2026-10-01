import {
  DIRECTIONS,
  edgeKey,
  isOrthogonallyAdjacent,
  posKey,
  stairsShaft,
  stairsTop,
  step,
  type AreaId,
  type CharacterId,
  type Direction,
  type DoorEdge,
  type DoorId,
  type Position,
  type PropDefinition,
  type Rect,
  type StairsId,
} from '@dungeon/shared';

/**
 * Minimal board description the rules operate on. `GameView` satisfies it,
 * so the server (on its own authoritative view) and the client (for previews)
 * run the very same movement code.
 */
export interface BoardSource {
  readonly areas: readonly { readonly id: AreaId; readonly tiles: readonly Position[] }[];
  readonly doors: readonly BoardDoor[];
  readonly stairs: readonly BoardStairs[];
  readonly props: readonly PropDefinition[];
  readonly monsters: readonly { readonly id: CharacterId; readonly position: Position }[];
  readonly heroes: readonly { readonly id: CharacterId; readonly position: Position }[];
}

export interface BoardDoor {
  readonly id: DoorId;
  readonly edges: readonly DoorEdge[];
  readonly open: boolean;
}

export interface BoardStairs {
  readonly id: StairsId;
  readonly bottom: Position;
  readonly direction: Direction;
  readonly explored: boolean;
}

export function expandRects(rects: readonly Rect[], level: number): Position[] {
  const tiles: Position[] = [];
  for (const r of rects) {
    for (let y = r.y; y < r.y + r.h; y++) {
      for (let x = r.x; x < r.x + r.w; x++) tiles.push({ x, y, level });
    }
  }
  return tiles;
}

export function propFootprint(prop: PropDefinition): Position[] {
  const w = prop.size?.w ?? 1;
  const h = prop.size?.h ?? 1;
  return expandRects([{ x: prop.position.x, y: prop.position.y, w, h }], prop.position.level);
}

/** Both tiles a figure can stand on to use the stairs: foot and landing. */
export function stairsEnds(stairs: Pick<BoardStairs, 'bottom' | 'direction'>): [Position, Position] {
  return [stairs.bottom, stairsTop(stairs)];
}

/** The cell next to a stairs end that the flight (or the stairwell above it) occupies. */
function stairsOpening(stairs: Pick<BoardStairs, 'bottom' | 'direction'>, end: Position): Position {
  const shaft = stairsShaft(stairs);
  return { ...shaft, level: end.level };
}

export function isPropBlocking(prop: PropDefinition): boolean {
  return prop.blocking !== false;
}

export class Board {
  private readonly tileArea = new Map<string, AreaId>();
  private readonly doorsByEdge = new Map<string, BoardDoor>();
  private readonly stairsByEnd = new Map<string, BoardStairs>();
  private readonly blockedByProp = new Set<string>();
  private readonly monstersByTile = new Map<string, CharacterId>();
  private readonly heroesByTile = new Map<string, CharacterId>();

  constructor(source: BoardSource) {
    for (const area of source.areas) {
      for (const t of area.tiles) this.tileArea.set(posKey(t), area.id);
    }
    for (const door of source.doors) {
      for (const [a, b] of door.edges) this.doorsByEdge.set(edgeKey(a, b), door);
    }
    for (const stairs of source.stairs) {
      for (const end of stairsEnds(stairs)) this.stairsByEnd.set(posKey(end), stairs);
    }
    for (const prop of source.props) {
      if (!isPropBlocking(prop)) continue;
      for (const t of propFootprint(prop)) this.blockedByProp.add(posKey(t));
    }
    for (const m of source.monsters) this.monstersByTile.set(posKey(m.position), m.id);
    for (const h of source.heroes) this.heroesByTile.set(posKey(h.position), h.id);
  }

  areaAt(p: Position): AreaId | undefined {
    return this.tileArea.get(posKey(p));
  }

  hasTile(p: Position): boolean {
    return this.tileArea.has(posKey(p));
  }

  doorBetween(a: Position, b: Position): BoardDoor | undefined {
    if (!isOrthogonallyAdjacent(a, b)) return undefined;
    return this.doorsByEdge.get(edgeKey(a, b));
  }

  /** Stairs whose foot or landing is `p` (at most one per tile). */
  stairsAt(p: Position): BoardStairs | undefined {
    return this.stairsByEnd.get(posKey(p));
  }

  /** Stairs connecting the tiles a and b (foot and landing, either order). */
  stairsBetween(a: Position, b: Position): BoardStairs | undefined {
    const stairs = this.stairsAt(a);
    return stairs && stairsEnds(stairs).some((end) => posKey(end) === posKey(b)) ? stairs : undefined;
  }

  /** Stairs whose flight or stairwell is the cell `opening`, entered from the stairs end `end`. */
  stairsOpeningAt(end: Position, opening: Position): BoardStairs | undefined {
    const stairs = this.stairsAt(end);
    return stairs && posKey(stairsOpening(stairs, end)) === posKey(opening) ? stairs : undefined;
  }

  /**
   * True if the edge between two adjacent tiles is a wall: the tiles belong to
   * different areas (or one does not exist / is unknown) and neither a door nor
   * the way onto stairs sits on it.
   */
  isWall(a: Position, b: Position): boolean {
    if (this.doorBetween(a, b)) return false;
    if (this.stairsOpeningAt(a, b) || this.stairsOpeningAt(b, a)) return false;
    const areaA = this.areaAt(a);
    return areaA === undefined || areaA !== this.areaAt(b);
  }

  /** True if a figure may cross from a to b in one step (ignoring what stands on b). */
  isEdgePassable(a: Position, b: Position): boolean {
    if (!this.hasTile(a) || !this.hasTile(b)) return false;
    const stairs = this.stairsBetween(a, b);
    if (stairs) return stairs.explored;
    if (!isOrthogonallyAdjacent(a, b)) return false;
    const door = this.doorBetween(a, b);
    if (door) return door.open;
    return this.areaAt(a) === this.areaAt(b);
  }

  isBlockedByProp(p: Position): boolean {
    return this.blockedByProp.has(posKey(p));
  }

  monsterAt(p: Position): CharacterId | undefined {
    return this.monstersByTile.get(posKey(p));
  }

  heroAt(p: Position): CharacterId | undefined {
    return this.heroesByTile.get(posKey(p));
  }

  /** Candidate next tiles in deterministic order N, E, S, W, then the far end of stairs. */
  neighbours(p: Position): Position[] {
    const result = DIRECTIONS.map((dir) => step(p, dir));
    const stairs = this.stairsAt(p);
    if (stairs) result.push(...stairsEnds(stairs).filter((end) => posKey(end) !== posKey(p)));
    return result;
  }
}
