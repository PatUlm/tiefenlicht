import { randomUUID } from 'node:crypto';
import {
  addPlayer,
  applyAction,
  createGame,
  createView,
  renamePlayer,
  setPlayerConnected,
  type GameState,
} from '@dungeon/game-core';
import {
  PLAYERS_PER_GAME,
  type DungeonDefinition,
  type GameAction,
  type GameEvent,
  type PlayerId,
  type ServerMessage,
} from '@dungeon/shared';

/** Transport abstraction so sessions can be tested without real sockets. */
export interface Connection {
  send(message: ServerMessage): void;
  close(code: number, reason: string): void;
}

/** Close code sent to a socket whose seat was claimed by a newer connection. */
export const CLOSE_REPLACED = 4001;

export type SeatResult =
  | { readonly ok: true; readonly playerId: PlayerId }
  | { readonly ok: false; readonly code: 'GAME_FULL' | 'INVALID_SESSION'; readonly canTakeOver?: boolean };

/**
 * One running game: authoritative state, player tokens and live connections.
 * All rule decisions are delegated to game-core; this class only does
 * session bookkeeping and fan-out (M9).
 */
export class GameSession {
  private state: GameState;
  /** token → player. Tokens are secret and only ever sent to their owner. */
  private readonly tokens = new Map<string, PlayerId>();
  private readonly connections = new Map<PlayerId, Connection>();
  private lastActivity: number;

  constructor(
    readonly gameId: string,
    dungeon: DungeonDefinition,
    now: number = Date.now(),
  ) {
    this.state = createGame(gameId, dungeon);
    this.lastActivity = now;
  }

  get snapshot(): GameState {
    return this.state;
  }

  hasConnections(): boolean {
    return this.connections.size > 0;
  }

  idleSince(): number {
    return this.lastActivity;
  }

  /** Seats a new player in the next free slot. */
  join(conn: Connection, name: string): SeatResult {
    const playerId = `player-${this.state.players.length + 1}`;
    const result = addPlayer(this.state, playerId, name);
    if (!result.ok) return { ok: false, code: 'GAME_FULL', canTakeOver: this.disconnectedPlayer() !== undefined };
    this.bind(conn, playerId);
    this.commit(result.state, result.events, { snapshotFor: conn });
    conn.send({ type: 'GAME_STATE', view: createView(this.state) });
    return { ok: true, playerId };
  }

  /** Hands a disconnected seat to a new person (confirmed in the UI). Old tokens are revoked. */
  takeOver(conn: Connection, name: string): SeatResult {
    // Only a full game has orphaned seats; otherwise this is an ordinary join.
    if (this.state.players.length < PLAYERS_PER_GAME) return this.join(conn, name);
    const player = this.disconnectedPlayer();
    if (!player) return { ok: false, code: 'GAME_FULL', canTakeOver: false };
    for (const [token, owner] of this.tokens) if (owner === player.id) this.tokens.delete(token);
    this.bind(conn, player.id);
    const renamed = renamePlayer(this.state, player.id, name);
    const connected = setPlayerConnected(renamed, player.id, true);
    this.commit(connected.state, connected.events, { snapshotFor: conn });
    conn.send({ type: 'GAME_STATE', view: createView(this.state) });
    return { ok: true, playerId: player.id };
  }

  /** Re-attaches a returning player by token; a previous live socket is replaced. */
  resume(conn: Connection, token: string): SeatResult {
    const playerId = this.tokens.get(token);
    if (!playerId) return { ok: false, code: 'INVALID_SESSION' };
    this.connections.get(playerId)?.close(CLOSE_REPLACED, 'Sitzung wurde in einem anderen Tab geöffnet.');
    this.connections.set(playerId, conn);
    conn.send({ type: 'SESSION', gameId: this.gameId, playerId, playerToken: token });
    const connected = setPlayerConnected(this.state, playerId, true);
    if (connected.events.length > 0) this.commit(connected.state, connected.events, { snapshotFor: conn });
    conn.send({ type: 'GAME_STATE', view: createView(this.state) });
    this.lastActivity = Date.now();
    return { ok: true, playerId };
  }

  /** Called when a socket closes. Ignored if the socket was already replaced. */
  disconnect(conn: Connection, playerId: PlayerId): void {
    if (this.connections.get(playerId) !== conn) return;
    this.connections.delete(playerId);
    const result = setPlayerConnected(this.state, playerId, false);
    this.commit(result.state, result.events);
  }

  handleAction(conn: Connection, playerId: PlayerId, action: GameAction, requestId?: string): void {
    if (this.connections.get(playerId) !== conn) return;
    const result = applyAction(this.state, playerId, action);
    if (!result.ok) {
      conn.send({
        type: 'ACTION_REJECTED',
        code: result.code,
        message: result.message,
        ...(requestId ? { requestId } : {}),
      });
      return;
    }
    this.commit(result.state, result.events, { origin: conn, requestId });
  }

  private disconnectedPlayer() {
    return this.state.players.find((p) => !p.connected);
  }

  private bind(conn: Connection, playerId: PlayerId): void {
    const token = randomUUID();
    this.tokens.set(token, playerId);
    this.connections.get(playerId)?.close(CLOSE_REPLACED, 'Platz wurde übernommen.');
    this.connections.set(playerId, conn);
    conn.send({ type: 'SESSION', gameId: this.gameId, playerId, playerToken: token });
  }

  /**
   * Stores the new state and fans the update out. `snapshotFor` receives a
   * plain snapshot instead (it has no prior state to animate from); the
   * `origin` connection gets its `requestId` echoed so it can release its
   * input lock for exactly that request.
   */
  private commit(
    next: GameState,
    events: readonly GameEvent[],
    opts: { snapshotFor?: Connection; origin?: Connection; requestId?: string | undefined } = {},
  ): void {
    this.state = next;
    this.lastActivity = Date.now();
    const view = createView(next);
    for (const conn of this.connections.values()) {
      if (conn === opts.snapshotFor) continue;
      const echo = conn === opts.origin && opts.requestId ? { requestId: opts.requestId } : {};
      conn.send({ type: 'GAME_UPDATE', events, view, ...echo });
    }
  }
}
