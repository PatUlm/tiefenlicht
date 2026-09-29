import { parseClientMessage, type ClientMessage, type PlayerId, type SessionErrorCode } from '@dungeon/shared';
import type { GameRegistry } from './game-registry.ts';
import type { Connection, GameSession, SeatResult } from './game-session.ts';

const SESSION_ERRORS: Record<SessionErrorCode, string> = {
  BAD_MESSAGE: 'Ungültige Nachricht.',
  GAME_NOT_FOUND: 'Spiel nicht gefunden. Prüfe den Code.',
  GAME_FULL: 'Das Spiel ist bereits voll.',
  INVALID_SESSION: 'Deine Sitzung ist abgelaufen.',
  NO_SESSION: 'Du bist keinem Spiel beigetreten.',
  ALREADY_IN_GAME: 'Diese Verbindung ist bereits einem Spiel zugeordnet.',
};

/** Failed JOIN/RESUME lookups per socket before it is closed (code guessing). */
export const MAX_FAILED_LOOKUPS = 5;
export const CLOSE_TOO_MANY_ATTEMPTS = 4008;

/**
 * Per-socket protocol handler: routes lobby messages to the registry and game
 * actions to the bound session. Never throws on client input.
 */
export class ClientHandler {
  private session: GameSession | undefined;
  private playerId: PlayerId | undefined;
  private failedLookups = 0;

  constructor(
    private readonly conn: Connection,
    private readonly registry: GameRegistry,
  ) {}

  onMessage(raw: string): void {
    const message = parseClientMessage(raw);
    if (!message) return this.error('BAD_MESSAGE');
    try {
      this.dispatch(message);
    } catch (err) {
      console.error('[server] handler error', err);
      this.error('BAD_MESSAGE');
    }
  }

  onClose(): void {
    if (this.session && this.playerId) this.session.disconnect(this.conn, this.playerId);
    this.session = undefined;
    this.playerId = undefined;
  }

  private dispatch(message: ClientMessage): void {
    switch (message.type) {
      case 'CREATE_GAME': {
        if (this.session) return this.error('ALREADY_IN_GAME');
        const session = this.registry.create();
        if (!session) return this.error('GAME_FULL', 'Der Server ist ausgelastet. Bitte später erneut versuchen.');
        return this.seat(session, session.join(this.conn, message.playerName));
      }
      case 'JOIN_GAME': {
        if (this.session) return this.error('ALREADY_IN_GAME');
        const session = this.registry.get(message.gameId);
        if (!session) return this.failedLookup('GAME_NOT_FOUND');
        const result = message.takeOver
          ? session.takeOver(this.conn, message.playerName)
          : session.join(this.conn, message.playerName);
        return this.seat(session, result);
      }
      case 'RESUME_SESSION': {
        if (this.session) return this.error('ALREADY_IN_GAME');
        const session = this.registry.get(message.gameId);
        if (!session) return this.failedLookup('GAME_NOT_FOUND');
        return this.seat(session, session.resume(this.conn, message.playerToken));
      }
      default: {
        if (!this.session || !this.playerId) return this.error('NO_SESSION');
        const { requestId, ...action } = message;
        this.session.handleAction(this.conn, this.playerId, action, requestId);
      }
    }
  }

  private seat(session: GameSession, result: SeatResult): void {
    if (!result.ok) {
      const canTakeOver = result.code === 'GAME_FULL' && result.canTakeOver === true;
      if (result.code === 'INVALID_SESSION') return this.failedLookup('INVALID_SESSION');
      return this.error(
        result.code,
        canTakeOver ? 'Das Spiel ist voll, aber ein Platz ist gerade verwaist.' : undefined,
        canTakeOver,
      );
    }
    this.session = session;
    this.playerId = result.playerId;
  }

  /** Unknown game code or token. Guessing is cut off after a few attempts per socket. */
  private failedLookup(code: 'GAME_NOT_FOUND' | 'INVALID_SESSION'): void {
    this.error(code);
    if (++this.failedLookups >= MAX_FAILED_LOOKUPS) this.conn.close(CLOSE_TOO_MANY_ATTEMPTS, 'Zu viele Fehlversuche.');
  }

  private error(code: SessionErrorCode, message?: string, canTakeOver?: boolean): void {
    this.conn.send({
      type: 'ERROR',
      code,
      message: message ?? SESSION_ERRORS[code],
      ...(canTakeOver ? { canTakeOver } : {}),
    });
  }
}
