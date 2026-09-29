import type { AreaId, CharacterId, DoorId, GameView, PlayerId, Position } from './types.ts';
import { MAX_CLIENT_MESSAGE_BYTES, MAX_PLAYER_NAME_LENGTH } from './constants.ts';

// ---------------------------------------------------------------------------
// Game actions (requests a client may send; validated by the server)
// ---------------------------------------------------------------------------

export interface MoveCharacterAction {
  readonly type: 'MOVE_CHARACTER';
  readonly characterId: CharacterId;
  readonly target: Position;
}

export interface OpenDoorAction {
  readonly type: 'OPEN_DOOR';
  readonly characterId: CharacterId;
  readonly doorId: DoorId;
}

export interface EndTurnAction {
  readonly type: 'END_TURN';
}

export interface RestartGameAction {
  readonly type: 'RESTART_GAME';
}

export type GameAction = MoveCharacterAction | OpenDoorAction | EndTurnAction | RestartGameAction;

// ---------------------------------------------------------------------------
// Game events (facts produced by the server; the client animates them)
// ---------------------------------------------------------------------------

export type GameEvent =
  | { readonly type: 'PLAYER_JOINED'; readonly playerId: PlayerId }
  | { readonly type: 'PLAYER_CONNECTION'; readonly playerId: PlayerId; readonly connected: boolean }
  | { readonly type: 'GAME_STARTED' }
  | {
      readonly type: 'CHARACTER_MOVED';
      readonly characterId: CharacterId;
      /** Tiles entered, in order, excluding the start tile. */
      readonly path: readonly Position[];
    }
  | { readonly type: 'DOOR_OPENED'; readonly doorId: DoorId; readonly characterId: CharacterId }
  | {
      readonly type: 'AREA_REVEALED';
      readonly areaId: AreaId;
      readonly viaDoorId: DoorId;
      readonly monsterIds: readonly CharacterId[];
    }
  | { readonly type: 'TURN_STARTED'; readonly playerId: PlayerId; readonly round: number }
  | { readonly type: 'GAME_WON' }
  | { readonly type: 'GAME_RESTARTED'; readonly byPlayerId: PlayerId };

export type RejectionCode =
  | 'GAME_NOT_RUNNING'
  | 'NOT_YOUR_TURN'
  | 'NOT_YOUR_CHARACTER'
  | 'UNKNOWN_CHARACTER'
  | 'UNKNOWN_DOOR'
  | 'INVALID_TARGET'
  | 'TARGET_OCCUPIED'
  | 'UNREACHABLE'
  | 'NOT_ENOUGH_MOVEMENT'
  | 'DOOR_ALREADY_OPEN'
  | 'DOOR_NOT_ADJACENT'
  | 'NO_ACTION_LEFT';

// ---------------------------------------------------------------------------
// Wire messages
// ---------------------------------------------------------------------------

export type ClientMessage =
  | { readonly type: 'CREATE_GAME'; readonly playerName: string }
  | {
      readonly type: 'JOIN_GAME';
      readonly gameId: string;
      readonly playerName: string;
      /** Take over a disconnected slot of a full game (confirmed by the user). */
      readonly takeOver?: boolean;
    }
  | { readonly type: 'RESUME_SESSION'; readonly gameId: string; readonly playerToken: string }
  | ({ readonly requestId?: string } & GameAction);

export type SessionErrorCode =
  | 'BAD_MESSAGE'
  | 'GAME_NOT_FOUND'
  | 'GAME_FULL'
  | 'INVALID_SESSION'
  | 'NO_SESSION'
  | 'ALREADY_IN_GAME';

export type ServerMessage =
  | {
      readonly type: 'SESSION';
      readonly gameId: string;
      readonly playerId: PlayerId;
      readonly playerToken: string;
    }
  | { readonly type: 'GAME_STATE'; readonly view: GameView }
  | {
      readonly type: 'GAME_UPDATE';
      readonly events: readonly GameEvent[];
      readonly view: GameView;
      /** Only in the copy sent to the connection whose request caused the update. */
      readonly requestId?: string;
    }
  | {
      readonly type: 'ACTION_REJECTED';
      readonly requestId?: string;
      readonly code: RejectionCode;
      readonly message: string;
    }
  | {
      readonly type: 'ERROR';
      readonly code: SessionErrorCode;
      readonly message: string;
      /** GAME_FULL only: a disconnected slot could be taken over. */
      readonly canTakeOver?: boolean;
    };

// ---------------------------------------------------------------------------
// Validation of untrusted client input
// ---------------------------------------------------------------------------

const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isId(value: unknown): value is string {
  return typeof value === 'string' && ID_PATTERN.test(value);
}

function isPosition(value: unknown): value is Position {
  return (
    isRecord(value) &&
    Number.isInteger(value.x) &&
    Number.isInteger(value.y) &&
    Math.abs(value.x as number) < 10_000 &&
    Math.abs(value.y as number) < 10_000
  );
}

/**
 * Trims and bounds a display name; returns null if nothing usable remains.
 * Does not escape HTML: clients must render names as text only (M9).
 */
export function sanitizePlayerName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const collapsed = value
    .replace(/[\t\n\r]/g, ' ') // whitespace controls become spaces before stripping
    .replace(/[\p{Cc}\p{Cf}]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
  // Cut by code points so surrogate pairs (emoji) are never split, then trim again.
  const cleaned = Array.from(collapsed).slice(0, MAX_PLAYER_NAME_LENGTH).join('').trim();
  return cleaned.length > 0 ? cleaned : null;
}

/** Parses a raw WebSocket payload into a typed message, or null if malformed. */
export function parseClientMessage(raw: string): ClientMessage | null {
  // Second line of defence: counts UTF-16 units, not bytes. The hard byte limit
  // is the WebSocket server's maxPayload.
  if (raw.length > MAX_CLIENT_MESSAGE_BYTES) return null;
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(data) || typeof data.type !== 'string') return null;
  const requestId = isId(data.requestId) ? data.requestId : undefined;
  const withRequest = <T extends GameAction>(msg: T): ClientMessage => (requestId ? { ...msg, requestId } : msg);

  switch (data.type) {
    case 'CREATE_GAME': {
      const playerName = sanitizePlayerName(data.playerName);
      return playerName ? { type: 'CREATE_GAME', playerName } : null;
    }
    case 'JOIN_GAME': {
      const playerName = sanitizePlayerName(data.playerName);
      if (!playerName || !isId(data.gameId)) return null;
      return {
        type: 'JOIN_GAME',
        gameId: data.gameId.toUpperCase(),
        playerName,
        ...(data.takeOver === true ? { takeOver: true } : {}),
      };
    }
    case 'RESUME_SESSION':
      if (!isId(data.gameId) || !isId(data.playerToken)) return null;
      return { type: 'RESUME_SESSION', gameId: data.gameId.toUpperCase(), playerToken: data.playerToken };
    case 'MOVE_CHARACTER':
      if (!isId(data.characterId) || !isPosition(data.target)) return null;
      return withRequest({
        type: 'MOVE_CHARACTER',
        characterId: data.characterId,
        target: { x: data.target.x, y: data.target.y },
      });
    case 'OPEN_DOOR':
      if (!isId(data.characterId) || !isId(data.doorId)) return null;
      return withRequest({ type: 'OPEN_DOOR', characterId: data.characterId, doorId: data.doorId });
    case 'END_TURN':
      return withRequest({ type: 'END_TURN' });
    case 'RESTART_GAME':
      return withRequest({ type: 'RESTART_GAME' });
    default:
      return null;
  }
}
