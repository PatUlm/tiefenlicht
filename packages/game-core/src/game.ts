import {
  OPPOSITE,
  PLAYERS_PER_GAME,
  directionTo,
  posKey,
  samePos,
  type AreaId,
  type Direction,
  type DoorDefinition,
  type DungeonDefinition,
  type GameAction,
  type GameEvent,
  type GameView,
  type Passage,
  type PlayerId,
  type Position,
  type RejectionCode,
  type StairsDefinition,
  type TurnView,
} from '@dungeon/shared';
import { Board, stairsEnds, type BoardDoor, type BoardStairs } from './board.ts';
import { moveMonsters } from './monsters.ts';
import { computeReachable, findPath } from './movement.ts';
import { HERO_TEMPLATES, heroIdForSlot, type GameState, type HeroState, type PlayerState } from './state.ts';
import { areasOfDoor, areasOfStairs, buildTileAreaIndex, createView } from './visibility.ts';

export type ActionResult =
  | { readonly ok: true; readonly state: GameState; readonly events: readonly GameEvent[] }
  | { readonly ok: false; readonly code: RejectionCode; readonly message: string };

const REJECTION_MESSAGES: Record<RejectionCode, string> = {
  GAME_NOT_RUNNING: 'Das Spiel läuft gerade nicht.',
  NOT_YOUR_TURN: 'Du bist nicht am Zug.',
  NOT_YOUR_CHARACTER: 'Diese Figur gehört dir nicht.',
  UNKNOWN_CHARACTER: 'Unbekannte Figur.',
  UNKNOWN_DOOR: 'Unbekannte Tür.',
  INVALID_TARGET: 'Dieses Feld kann nicht betreten werden.',
  TARGET_OCCUPIED: 'Das Feld ist belegt.',
  UNREACHABLE: 'Dorthin führt kein Weg.',
  NOT_ENOUGH_MOVEMENT: 'Nicht genug Bewegungspunkte.',
  DOOR_ALREADY_OPEN: 'Die Tür ist bereits offen.',
  DOOR_NOT_ADJACENT: 'Stelle dich direkt an die Tür.',
  UNKNOWN_STAIRS: 'Unbekannte Treppe.',
  STAIRS_ALREADY_EXPLORED: 'Die Treppe ist bereits erkundet.',
  STAIRS_NOT_ADJACENT: 'Stelle dich direkt vor die Treppe.',
  TARGET_NOT_ADJACENT: 'Stelle dich direkt neben den Gegner.',
  NO_ACTION_LEFT: 'Deine Aktion für diesen Zug ist verbraucht.',
};

function reject(code: RejectionCode): ActionResult {
  return { ok: false, code, message: REJECTION_MESSAGES[code] };
}

function freshTurn(dungeon: DungeonDefinition, activePlayerId: PlayerId, round: number): TurnView {
  return {
    round,
    activePlayerId,
    movementLeft: dungeon.rules.movementPerTurn,
    actionsLeft: dungeon.rules.actionsPerTurn,
  };
}

function createHero(dungeon: DungeonDefinition, slot: number, ownerId: PlayerId): HeroState {
  const template = HERO_TEMPLATES[slot];
  const start = dungeon.heroStarts.find((s) => s.slot === slot);
  if (!template || !start) throw new Error(`Dungeon has no hero start for slot ${slot}`);
  return {
    id: heroIdForSlot(slot),
    kind: template.kind,
    name: template.name,
    position: start.position,
    facing: start.facing,
    ownerId,
  };
}

function sortedPlayers(state: GameState): PlayerState[] {
  return [...state.players].sort((a, b) => a.slot - b.slot);
}

// ---------------------------------------------------------------------------
// Setup and session-level transitions
// ---------------------------------------------------------------------------

export function createGame(gameId: string, dungeon: DungeonDefinition): GameState {
  const tileAreas = buildTileAreaIndex({ dungeon });
  return {
    gameId,
    version: 0,
    restarts: 0,
    phase: 'waiting',
    dungeon,
    players: [],
    heroes: [],
    monsters: dungeon.monsters.map((m) => ({ ...m })),
    openDoors: [],
    exploredStairs: [],
    revealedAreas: dungeon.areas.filter((a) => a.initiallyRevealed).map((a) => a.id),
    visitedAreas: [...new Set(dungeon.heroStarts.map((s) => tileAreas.get(posKey(s.position))!))],
    turn: null,
    objectiveCompleted: false,
  };
}

export type JoinResult =
  | { readonly ok: true; readonly state: GameState; readonly events: readonly GameEvent[] }
  | { readonly ok: false; readonly code: 'GAME_FULL' };

/** Adds a player to the next free slot. The game starts as soon as all slots are taken. */
export function addPlayer(state: GameState, playerId: PlayerId, name: string): JoinResult {
  if (state.players.length >= PLAYERS_PER_GAME) return { ok: false, code: 'GAME_FULL' };
  const slot = state.players.length;
  const hero = createHero(state.dungeon, slot, playerId);
  const player: PlayerState = { id: playerId, name, slot, heroId: hero.id, connected: true };
  let next: GameState = {
    ...state,
    version: state.version + 1,
    players: [...state.players, player],
    heroes: [...state.heroes, hero],
  };
  const events: GameEvent[] = [{ type: 'PLAYER_JOINED', playerId }];

  if (next.players.length === PLAYERS_PER_GAME) {
    const first = sortedPlayers(next)[0]!;
    next = { ...next, phase: 'playing', turn: freshTurn(next.dungeon, first.id, 1) };
    events.push({ type: 'GAME_STARTED' }, { type: 'TURN_STARTED', playerId: first.id, round: 1 });
  }
  return { ok: true, state: next, events };
}

export function setPlayerConnected(
  state: GameState,
  playerId: PlayerId,
  connected: boolean,
): { state: GameState; events: GameEvent[] } {
  const player = state.players.find((p) => p.id === playerId);
  if (!player || player.connected === connected) return { state, events: [] };
  return {
    state: {
      ...state,
      version: state.version + 1,
      players: state.players.map((p) => (p.id === playerId ? { ...p, connected } : p)),
    },
    events: [{ type: 'PLAYER_CONNECTION', playerId, connected }],
  };
}

/** Slot takeover (M9): a new person continues a disconnected player's hero. */
export function renamePlayer(state: GameState, playerId: PlayerId, name: string): GameState {
  return {
    ...state,
    version: state.version + 1,
    players: state.players.map((p) => (p.id === playerId ? { ...p, name } : p)),
  };
}

function restartGame(state: GameState, byPlayerId: PlayerId): ActionResult {
  let next: GameState = {
    ...createGame(state.gameId, state.dungeon),
    version: state.version + 1,
    restarts: state.restarts + 1,
    players: state.players,
    heroes: state.players.map((p) => createHero(state.dungeon, p.slot, p.id)),
  };
  const events: GameEvent[] = [{ type: 'GAME_RESTARTED', byPlayerId }];
  if (next.players.length === PLAYERS_PER_GAME) {
    const first = sortedPlayers(next)[0]!;
    next = { ...next, phase: 'playing', turn: freshTurn(next.dungeon, first.id, 1) };
    events.push({ type: 'TURN_STARTED', playerId: first.id, round: 1 });
  }
  return { ok: true, state: next, events };
}

// ---------------------------------------------------------------------------
// Game actions
// ---------------------------------------------------------------------------

export function isAdjacentToDoor(door: { readonly edges: DoorDefinition['edges'] }, p: Position): boolean {
  return door.edges.some(([a, b]) => samePos(a, p) || samePos(b, p));
}

/** Direction a hero standing on a door edge tile faces to look through the door. */
function facingTowardsDoor(door: DoorDefinition, p: Position) {
  for (const [a, b] of door.edges) {
    if (samePos(a, p)) return directionTo(a, b);
    if (samePos(b, p)) return directionTo(b, a);
  }
  return undefined;
}

/**
 * Applies a player's action to the authoritative state. Pure: never mutates `state`.
 * Rules: docs/game-mechanics.md M3–M7.
 */
export function applyAction(state: GameState, playerId: PlayerId, action: GameAction): ActionResult {
  if (!state.players.some((p) => p.id === playerId)) return reject('NOT_YOUR_TURN');

  const turn = state.turn;
  if (state.phase !== 'playing' || !turn) return reject('GAME_NOT_RUNNING');
  // Any seated player may restart at any time while the game runs (M7).
  if (action.type === 'RESTART_GAME') return restartGame(state, playerId);
  if (turn.activePlayerId !== playerId) return reject('NOT_YOUR_TURN');

  switch (action.type) {
    case 'END_TURN':
      return endTurn(state, turn);
    case 'MOVE_CHARACTER': {
      const hero = state.heroes.find((h) => h.id === action.characterId);
      if (!hero) return reject('UNKNOWN_CHARACTER');
      if (hero.ownerId !== playerId) return reject('NOT_YOUR_CHARACTER');
      return moveHero(state, turn, hero, action.target);
    }
    case 'OPEN_DOOR': {
      const hero = state.heroes.find((h) => h.id === action.characterId);
      if (!hero) return reject('UNKNOWN_CHARACTER');
      if (hero.ownerId !== playerId) return reject('NOT_YOUR_CHARACTER');
      return openDoor(state, turn, hero, action.doorId);
    }
    case 'EXPLORE_STAIRS': {
      const hero = state.heroes.find((h) => h.id === action.characterId);
      if (!hero) return reject('UNKNOWN_CHARACTER');
      if (hero.ownerId !== playerId) return reject('NOT_YOUR_CHARACTER');
      return exploreStairs(state, turn, hero, action.stairsId);
    }
    case 'ATTACK': {
      const hero = state.heroes.find((h) => h.id === action.characterId);
      if (!hero) return reject('UNKNOWN_CHARACTER');
      if (hero.ownerId !== playerId) return reject('NOT_YOUR_CHARACTER');
      return attack(state, turn, hero, action.targetId);
    }
    default: {
      // Compile-time exhaustiveness; at runtime a stray message type is rejected, never thrown.
      const unknownAction: never = action;
      void unknownAction;
      return reject('GAME_NOT_RUNNING');
    }
  }
}

function moveHero(state: GameState, turn: TurnView, hero: HeroState, target: Position): ActionResult {
  // Movement is evaluated on the filtered view: hidden tiles simply do not exist,
  // so rejections cannot leak anything about unrevealed areas (M4, M6).
  const board = new Board(createView(state));
  const result = findPath(board, hero.id, hero.position, target, turn.movementLeft);
  if (!result.ok) return reject(result.reason);

  const path = result.path;
  const last = path[path.length - 1]!;
  const beforeLast = path.length > 1 ? path[path.length - 2]! : hero.position;
  const moved: HeroState = { ...hero, position: last, facing: directionTo(beforeLast, last) };
  const next: GameState = {
    ...state,
    version: state.version + 1,
    heroes: state.heroes.map((h) => (h.id === hero.id ? moved : h)),
    turn: { ...turn, movementLeft: turn.movementLeft - path.length },
    visitedAreas: visitedAfter(state, path),
  };
  return finish(next, [{ type: 'CHARACTER_MOVED', characterId: hero.id, path }]);
}

/** Visited areas after a hero entered the given tiles (M7). */
function visitedAfter(state: GameState, path: readonly Position[]): AreaId[] {
  const tileAreas = buildTileAreaIndex(state);
  const visited = new Set(state.visitedAreas);
  for (const p of path) visited.add(tileAreas.get(posKey(p))!);
  return [...visited];
}

function openDoor(state: GameState, turn: TurnView, hero: HeroState, doorId: string): ActionResult {
  const tileAreas = buildTileAreaIndex(state);
  const revealed = new Set(state.revealedAreas);
  const door = state.dungeon.doors.find((d) => d.id === doorId);
  // Doors not touching a revealed area are unknown to players.
  if (!door || !areasOfDoor(door, tileAreas).some((id) => revealed.has(id))) return reject('UNKNOWN_DOOR');
  if (state.openDoors.includes(door.id)) return reject('DOOR_ALREADY_OPEN');
  if (!isAdjacentToDoor(door, hero.position)) return reject('DOOR_NOT_ADJACENT');
  if (turn.actionsLeft <= 0) return reject('NO_ACTION_LEFT');

  const facing = facingTowardsDoor(door, hero.position) ?? hero.facing;
  const opened: GameState = { ...state, openDoors: [...state.openDoors, door.id] };
  const first: GameEvent = { type: 'DOOR_OPENED', doorId: door.id, characterId: hero.id };
  const revealedState = revealBeyond(opened, turn, hero, facing, first, { kind: 'door', id: door.id }, areasOfDoor(door, tileAreas));
  return finish(revealedState.state, revealedState.events);
}

export function isAtStairs(stairs: Pick<StairsDefinition, 'bottom' | 'direction'>, p: Position): boolean {
  return stairsEnds(stairs).some((end) => samePos(end, p));
}

/** Direction a hero standing at the foot or on the landing faces to look along the stairs. */
function facingTowardsStairs(stairs: StairsDefinition, p: Position): Direction {
  return samePos(stairs.bottom, p) ? stairs.direction : OPPOSITE[stairs.direction];
}

function exploreStairs(state: GameState, turn: TurnView, hero: HeroState, stairsId: string): ActionResult {
  const tileAreas = buildTileAreaIndex(state);
  const revealed = new Set(state.revealedAreas);
  const stairs = state.dungeon.stairs.find((s) => s.id === stairsId);
  // Stairs not touching a revealed area are unknown to players.
  if (!stairs || !areasOfStairs(stairs, tileAreas).some((id) => revealed.has(id))) return reject('UNKNOWN_STAIRS');
  if (state.exploredStairs.includes(stairs.id)) return reject('STAIRS_ALREADY_EXPLORED');
  if (!isAtStairs(stairs, hero.position)) return reject('STAIRS_NOT_ADJACENT');
  if (turn.actionsLeft <= 0) return reject('NO_ACTION_LEFT');

  const explored: GameState = { ...state, exploredStairs: [...state.exploredStairs, stairs.id] };
  const first: GameEvent = { type: 'STAIRS_EXPLORED', stairsId: stairs.id, characterId: hero.id };
  const facing = facingTowardsStairs(stairs, hero.position);
  const { state: next, events } = revealBeyond(explored, turn, hero, facing, first, { kind: 'stairs', id: stairs.id }, areasOfStairs(stairs, tileAreas));

  // With a movement point left the hero takes the stairs right away (M5); otherwise it stays.
  const far = stairsEnds(stairs).find((end) => !samePos(end, hero.position))!;
  const blocked = next.heroes.some((h) => samePos(h.position, far)) || next.monsters.some((m) => samePos(m.position, far));
  if (next.turn!.movementLeft < 1 || blocked) return finish(next, events);
  const climbed: GameState = {
    ...next,
    heroes: next.heroes.map((h) => (h.id === hero.id ? { ...h, position: far } : h)),
    turn: { ...next.turn!, movementLeft: next.turn!.movementLeft - 1 },
    visitedAreas: visitedAfter(next, [far]),
  };
  return finish(climbed, [...events, { type: 'CHARACTER_MOVED', characterId: hero.id, path: [far] }]);
}

/**
 * True if a figure on `from` could strike one on `to`: one step apart over a passable
 * edge, so not through a wall or closed door, but along explored stairs (M10).
 */
export function canStrike(board: Board, from: Position, to: Position): boolean {
  return board.isEdgePassable(from, to);
}

/** Direction a hero faces to strike from `from` at `to` (along the flight for stairs). */
function facingTowards(board: Board, from: Position, to: Position): Direction {
  const stairs = board.stairsBetween(from, to);
  if (stairs) return samePos(stairs.bottom, from) ? stairs.direction : OPPOSITE[stairs.direction];
  return directionTo(from, to);
}

function attack(state: GameState, turn: TurnView, hero: HeroState, targetId: string): ActionResult {
  // Judged on the filtered view: a hidden monster is as unknown as a non-existing one (M6).
  const view = createView(state);
  const monster = view.monsters.find((m) => m.id === targetId);
  if (!monster) return reject('UNKNOWN_CHARACTER');
  const board = new Board(view);
  if (!canStrike(board, hero.position, monster.position)) return reject('TARGET_NOT_ADJACENT');
  if (turn.actionsLeft <= 0) return reject('NO_ACTION_LEFT');

  const facing = facingTowards(board, hero.position, monster.position);
  const next: GameState = {
    ...state,
    version: state.version + 1,
    monsters: state.monsters.filter((m) => m.id !== monster.id),
    heroes: state.heroes.map((h) => (h.id === hero.id ? { ...h, facing } : h)),
    turn: { ...turn, actionsLeft: turn.actionsLeft - 1 },
  };
  return finish(next, [{ type: 'MONSTER_DEFEATED', monsterId: monster.id, characterId: hero.id }]);
}

/**
 * Shared part of opening a door and exploring stairs (M5): uses the action and
 * reveals the areas behind the passage. The caller checks the objective (`finish`).
 */
function revealBeyond(
  state: GameState,
  turn: TurnView,
  hero: HeroState,
  facing: Direction,
  first: GameEvent,
  via: Passage,
  areaIds: readonly AreaId[],
): { state: GameState; events: GameEvent[] } {
  const tileAreas = buildTileAreaIndex(state);
  const revealed = new Set(state.revealedAreas);
  const events: GameEvent[] = [first];
  for (const areaId of areaIds.filter((id) => !revealed.has(id))) {
    revealed.add(areaId);
    const monsterIds = state.monsters
      .filter((m) => tileAreas.get(posKey(m.position)) === areaId)
      .map((m) => m.id);
    events.push({ type: 'AREA_REVEALED', areaId, via, monsterIds });
  }

  return {
    state: {
      ...state,
      version: state.version + 1,
      revealedAreas: [...revealed],
      heroes: state.heroes.map((h) => (h.id === hero.id ? { ...h, facing } : h)),
      turn: { ...turn, actionsLeft: turn.actionsLeft - 1 },
    },
    events,
  };
}

/** M7: completes the objective once (appending GAME_WON last) and wraps up an action. */
function finish(state: GameState, events: GameEvent[]): ActionResult {
  if (state.objectiveCompleted) return { ok: true, state, events };
  const revealed = new Set(state.revealedAreas);
  const visited = new Set(state.visitedAreas);
  const type = state.dungeon.victory.type;
  const areasDone = state.dungeon.areas.every((a) => (type === 'visitAllAreas' ? visited : revealed).has(a.id));
  const done = areasDone && (type !== 'clearDungeon' || state.monsters.length === 0);
  return { ok: true, state: { ...state, objectiveCompleted: done }, events: done ? [...events, { type: 'GAME_WON' }] : events };
}

function endTurn(state: GameState, turn: TurnView): ActionResult {
  const players = sortedPlayers(state);
  const index = players.findIndex((p) => p.id === turn.activePlayerId);
  const nextIndex = (index + 1) % players.length;
  const next = players[nextIndex]!;
  // After both players the round ends with the monster phase (M10), all in one update.
  const monsterPhase = nextIndex === 0 ? moveMonsters(state, turn.round) : { state, events: [] };
  const round = nextIndex === 0 ? turn.round + 1 : turn.round;
  return {
    ok: true,
    state: { ...monsterPhase.state, version: monsterPhase.state.version + 1, turn: freshTurn(state.dungeon, next.id, round) },
    events: [...monsterPhase.events, { type: 'TURN_STARTED', playerId: next.id, round }],
  };
}

// ---------------------------------------------------------------------------
// Client-side helpers (UI hints only; the server stays authoritative)
// ---------------------------------------------------------------------------

/** The player's hero if it may use its action right now. */
function heroWithAction(view: GameView, playerId: PlayerId) {
  const turn = view.turn;
  if (view.phase !== 'playing' || !turn || turn.activePlayerId !== playerId || turn.actionsLeft <= 0) return undefined;
  return view.heroes.find((h) => h.ownerId === playerId);
}

/** Closed doors the player's hero could open right now. */
export function openableDoors(view: GameView, playerId: PlayerId): BoardDoor[] {
  const hero = heroWithAction(view, playerId);
  return hero ? view.doors.filter((d) => !d.open && isAdjacentToDoor(d, hero.position)) : [];
}

/** Unexplored stairs the player's hero could explore right now. */
export function explorableStairs(view: GameView, playerId: PlayerId): BoardStairs[] {
  const hero = heroWithAction(view, playerId);
  return hero ? view.stairs.filter((s) => !s.explored && isAtStairs(s, hero.position)) : [];
}

/** Monsters the player's hero could strike right now (M10). */
export function attackableMonsters(view: GameView, playerId: PlayerId): GameView['monsters'] {
  const hero = heroWithAction(view, playerId);
  if (!hero) return [];
  const board = new Board(view);
  return view.monsters.filter((m) => canStrike(board, hero.position, m.position));
}

/**
 * M3 UI hint: true if the active player can still reach a tile, or can still use
 * the action on a closed door, unexplored stairs or a monster from the current or a reachable tile.
 */
export function canStillAct(view: GameView, playerId: PlayerId): boolean {
  const turn = view.turn;
  if (view.phase !== 'playing' || !turn || turn.activePlayerId !== playerId) return false;
  const hero = view.heroes.find((h) => h.ownerId === playerId);
  if (!hero) return false;
  const board = new Board(view);
  const reachable = computeReachable(board, hero.id, hero.position, turn.movementLeft);
  if (reachable.size > 0) return true;
  if (turn.actionsLeft <= 0) return false;
  const standable = [hero.position, ...[...reachable.values()].map((r) => r.position)];
  return (
    view.doors.some((d) => !d.open && standable.some((p) => isAdjacentToDoor(d, p))) ||
    view.stairs.some((s) => !s.explored && standable.some((p) => isAtStairs(s, p))) ||
    view.monsters.some((m) => standable.some((p) => canStrike(board, p, m.position)))
  );
}
