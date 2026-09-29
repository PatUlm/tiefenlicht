import type {
  AreaId,
  CharacterId,
  Direction,
  DoorId,
  DungeonDefinition,
  GamePhase,
  HeroKind,
  MonsterDefinition,
  PlayerId,
  Position,
  TurnView,
} from '@dungeon/shared';

export interface PlayerState {
  readonly id: PlayerId;
  readonly name: string;
  readonly slot: number;
  readonly heroId: CharacterId;
  readonly connected: boolean;
}

export interface HeroState {
  readonly id: CharacterId;
  readonly kind: HeroKind;
  readonly name: string;
  readonly position: Position;
  readonly facing: Direction;
  readonly ownerId: PlayerId;
}

export type MonsterState = MonsterDefinition;

/** Authoritative game state. Lives only on the server; clients get a filtered `GameView`. */
export interface GameState {
  readonly gameId: string;
  readonly version: number;
  readonly phase: GamePhase;
  readonly dungeon: DungeonDefinition;
  readonly players: readonly PlayerState[];
  readonly heroes: readonly HeroState[];
  readonly monsters: readonly MonsterState[];
  readonly openDoors: readonly DoorId[];
  readonly revealedAreas: readonly AreaId[];
  readonly turn: TurnView | null;
  /** Set once the victory condition has been met; the game keeps running (M7). */
  readonly objectiveCompleted: boolean;
}

export interface HeroTemplate {
  readonly kind: HeroKind;
  readonly name: string;
}

/** Hero per player slot (M2): slot 0 → dwarf, slot 1 → dark elf. */
export const HERO_TEMPLATES: readonly HeroTemplate[] = [
  { kind: 'dwarf', name: 'Grimbald Funkenbart' },
  { kind: 'darkelf', name: 'Vaelis Nachtweide' },
];

export function heroIdForSlot(slot: number): CharacterId {
  return `hero-${slot + 1}`;
}
