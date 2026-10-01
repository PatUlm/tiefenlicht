// Domain types shared by server, client and game-core.
// Everything here is plain JSON-compatible data so a future editor can produce it.

export interface Position {
  readonly x: number;
  readonly y: number;
  /** Storey of the dungeon; 0 is the entrance level, higher is up. */
  readonly level: number;
}

// Enumerations are declared as `as const` arrays so the dungeon validator can check
// authored JSON against the very same values the types are derived from.

/** Grid directions. x grows towards east, y grows towards south. */
export const DIRECTION_VALUES = ['N', 'E', 'S', 'W'] as const;
export type Direction = (typeof DIRECTION_VALUES)[number];

export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

export type AreaId = string;
export type DoorId = string;
export type StairsId = string;
export type PlayerId = string;
export type CharacterId = string;

export const AREA_KIND_VALUES = ['room', 'corridor'] as const;
export type AreaKind = (typeof AREA_KIND_VALUES)[number];

export const THEME_VALUES = ['hall', 'corridor', 'crypt', 'mage'] as const;
export type ThemeId = (typeof THEME_VALUES)[number];

export const DOOR_STYLE_VALUES = ['grand', 'iron', 'arcane'] as const;
export type DoorStyle = (typeof DOOR_STYLE_VALUES)[number];

export type HeroKind = 'dwarf' | 'darkelf';

export const MONSTER_KIND_VALUES = ['skeletonWarrior', 'skeletonMinion', 'skeletonMage'] as const;
export type MonsterKind = (typeof MONSTER_KIND_VALUES)[number];

export const PROP_KIND_VALUES = [
  'pillar',
  'statue',
  'barrel',
  'crates',
  'keg',
  'table',
  'sarcophagus',
  'candles',
  'chest',
  'bookshelf',
  'cauldron',
  'crystal',
  'rubble',
  'telescope',
  'starChart',
  'bonePile',
] as const;
export type PropKind = (typeof PROP_KIND_VALUES)[number];

export const WALL_DECOR_KIND_VALUES = ['torch', 'banner', 'shield', 'skullNiche'] as const;
export type WallDecorKind = (typeof WALL_DECOR_KIND_VALUES)[number];

// ---------------------------------------------------------------------------
// Dungeon definition (static, authored data)
// ---------------------------------------------------------------------------

export interface AreaDefinition {
  readonly id: AreaId;
  readonly name: string;
  readonly kind: AreaKind;
  readonly theme: ThemeId;
  /** Storey all tiles of the area lie on. */
  readonly level: number;
  /** Union of rectangles; must not overlap other areas of the same level. */
  readonly rects: readonly Rect[];
  readonly initiallyRevealed: boolean;
}

/** The two orthogonally adjacent tiles whose shared edge holds (part of) a door. */
export type DoorEdge = readonly [Position, Position];

export interface DoorDefinition {
  readonly id: DoorId;
  readonly name: string;
  /** One edge for a single door, two adjacent parallel edges for a double door. */
  readonly edges: readonly DoorEdge[];
  readonly style: DoorStyle;
}

/**
 * A straight flight of stairs connecting two levels. The flight itself is no
 * playing field: it occupies the tile between `bottom` and the landing tile
 * (`stairsTop`), and one step leads from `bottom` straight to the landing.
 */
export interface StairsDefinition {
  readonly id: StairsId;
  readonly name: string;
  /** Tile in front of the foot of the stairs, on the lower level. */
  readonly bottom: Position;
  /** Direction from `bottom` up the flight. */
  readonly direction: Direction;
}

export interface PropDefinition {
  readonly id: string;
  readonly kind: PropKind;
  /** Top-left tile of the footprint. */
  readonly position: Position;
  /** Footprint in tiles, default 1×1. */
  readonly size?: { readonly w: number; readonly h: number };
  readonly facing: Direction;
  /** Default: true. */
  readonly blocking?: boolean;
}

export interface WallDecorDefinition {
  readonly id: string;
  readonly kind: WallDecorKind;
  readonly position: Position;
  /** Edge of the tile the decoration hangs on. */
  readonly wall: Direction;
}

export interface MonsterDefinition {
  readonly id: CharacterId;
  readonly kind: MonsterKind;
  readonly name: string;
  readonly position: Position;
  readonly facing: Direction;
}

export interface HeroStartDefinition {
  readonly slot: number;
  readonly position: Position;
  readonly facing: Direction;
}

export const VICTORY_TYPE_VALUES = ['revealAllAreas', 'visitAllAreas'] as const;
/** `revealAllAreas`: every area discovered. `visitAllAreas`: every area discovered and entered by a hero. */
export type VictoryCondition = { readonly type: (typeof VICTORY_TYPE_VALUES)[number] };

export interface RuleParameters {
  readonly movementPerTurn: number;
  readonly actionsPerTurn: number;
}

export interface DungeonDefinition {
  readonly id: string;
  readonly name: string;
  readonly width: number;
  readonly height: number;
  readonly areas: readonly AreaDefinition[];
  readonly doors: readonly DoorDefinition[];
  readonly stairs: readonly StairsDefinition[];
  readonly props: readonly PropDefinition[];
  readonly wallDecor: readonly WallDecorDefinition[];
  readonly monsters: readonly MonsterDefinition[];
  readonly heroStarts: readonly HeroStartDefinition[];
  readonly victory: VictoryCondition;
  readonly rules: RuleParameters;
}

// ---------------------------------------------------------------------------
// Client-visible game view (filtered by visibility on the server)
// ---------------------------------------------------------------------------

/** The game never "finishes": reaching the objective keeps it running (M7). */
export type GamePhase = 'waiting' | 'playing';

export interface AreaView {
  readonly id: AreaId;
  readonly name: string;
  readonly kind: AreaKind;
  readonly theme: ThemeId;
  readonly level: number;
  readonly tiles: readonly Position[];
}

export interface DoorView {
  readonly id: DoorId;
  readonly name: string;
  readonly edges: readonly DoorEdge[];
  readonly style: DoorStyle;
  readonly open: boolean;
}

export interface StairsView {
  readonly id: StairsId;
  readonly name: string;
  readonly bottom: Position;
  readonly direction: Direction;
  /** Landing tile on the upper level (derived, see `stairsTop`). */
  readonly top: Position;
  /** Explored stairs are passable; exploring reveals the area at the far end. */
  readonly explored: boolean;
}

export interface HeroView {
  readonly id: CharacterId;
  readonly kind: HeroKind;
  readonly name: string;
  readonly position: Position;
  readonly facing: Direction;
  readonly ownerId: PlayerId;
}

export interface MonsterView {
  readonly id: CharacterId;
  readonly kind: MonsterKind;
  readonly name: string;
  readonly position: Position;
  readonly facing: Direction;
  readonly areaId: AreaId;
}

export interface PlayerView {
  readonly id: PlayerId;
  readonly name: string;
  readonly slot: number;
  readonly heroId: CharacterId;
  readonly connected: boolean;
}

export interface TurnView {
  readonly round: number;
  readonly activePlayerId: PlayerId;
  readonly movementLeft: number;
  readonly actionsLeft: number;
}

export interface ObjectiveView {
  readonly type: VictoryCondition['type'];
  readonly revealedAreas: number;
  /** Areas a hero has stood in at least once (start area included). */
  readonly visitedAreas: number;
  readonly totalAreas: number;
  readonly completed: boolean;
}

export interface GameView {
  readonly gameId: string;
  readonly version: number;
  /** Number of restarts so far: tells a restarted game apart from a reconnect. */
  readonly restarts: number;
  readonly phase: GamePhase;
  readonly dungeonName: string;
  readonly width: number;
  readonly height: number;
  readonly areas: readonly AreaView[];
  readonly doors: readonly DoorView[];
  readonly stairs: readonly StairsView[];
  readonly props: readonly PropDefinition[];
  readonly wallDecor: readonly WallDecorDefinition[];
  readonly monsters: readonly MonsterView[];
  readonly heroes: readonly HeroView[];
  readonly players: readonly PlayerView[];
  readonly turn: TurnView | null;
  readonly objective: ObjectiveView;
  readonly rules: RuleParameters;
}
