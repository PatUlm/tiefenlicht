import {
  DIRECTIONS,
  edgeKey,
  isOrthogonallyAdjacent,
  posKey,
  step,
  type AreaId,
  type CharacterId,
  type Direction,
  type DoorEdge,
  type DoorId,
  type Position,
  type PropDefinition,
  type Rect,
} from '@dungeon/shared';

/**
 * Minimal board description the rules operate on. `GameView` satisfies it,
 * so the server (on its own authoritative view) and the client (for previews)
 * run the very same movement code.
 */
export interface BoardSource {
  readonly areas: readonly { readonly id: AreaId; readonly tiles: readonly Position[] }[];
  readonly doors: readonly BoardDoor[];
  readonly props: readonly PropDefinition[];
  readonly monsters: readonly { readonly id: CharacterId; readonly position: Position }[];
  readonly heroes: readonly { readonly id: CharacterId; readonly position: Position }[];
}

export interface BoardDoor {
  readonly id: DoorId;
  readonly edges: readonly DoorEdge[];
  readonly open: boolean;
}

export function expandRects(rects: readonly Rect[]): Position[] {
  const tiles: Position[] = [];
  for (const r of rects) {
    for (let y = r.y; y < r.y + r.h; y++) {
      for (let x = r.x; x < r.x + r.w; x++) tiles.push({ x, y });
    }
  }
  return tiles;
}

export function propFootprint(prop: PropDefinition): Position[] {
  const w = prop.size?.w ?? 1;
  const h = prop.size?.h ?? 1;
  return expandRects([{ x: prop.position.x, y: prop.position.y, w, h }]);
}

export function isPropBlocking(prop: PropDefinition): boolean {
  return prop.blocking !== false;
}

export class Board {
  private readonly tileArea = new Map<string, AreaId>();
  private readonly doorsByEdge = new Map<string, BoardDoor>();
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

  /**
   * True if the edge between two adjacent tiles is a wall: the tiles belong to
   * different areas (or one does not exist / is unknown) and no door sits on it.
   */
  isWall(a: Position, b: Position): boolean {
    if (this.doorBetween(a, b)) return false;
    const areaA = this.areaAt(a);
    return areaA === undefined || areaA !== this.areaAt(b);
  }

  /** True if a figure may cross the edge a→b (ignoring what stands on b). */
  isEdgePassable(a: Position, b: Position): boolean {
    if (!isOrthogonallyAdjacent(a, b) || !this.hasTile(a) || !this.hasTile(b)) return false;
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

  /** Neighbours in deterministic order N, E, S, W. */
  neighbours(p: Position): { dir: Direction; pos: Position }[] {
    return DIRECTIONS.map((dir) => ({ dir, pos: step(p, dir) }));
  }
}
