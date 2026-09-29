import { randomInt } from 'node:crypto';
import type { DungeonDefinition } from '@dungeon/shared';
import { GameSession } from './game-session.ts';

/** Unambiguous characters for human-typed game codes (no 0/O, 1/I/L). */
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 5;

export interface RegistryOptions {
  readonly maxGames: number;
  /** Games without any connection are dropped after this many ms. */
  readonly idleTimeoutMs: number;
}

export const DEFAULT_REGISTRY_OPTIONS: RegistryOptions = {
  maxGames: 200,
  idleTimeoutMs: 30 * 60 * 1000,
};

/** In-memory lobby: creates, finds and expires game sessions. */
export class GameRegistry {
  private readonly games = new Map<string, GameSession>();

  constructor(
    private readonly dungeon: DungeonDefinition,
    private readonly options: RegistryOptions = DEFAULT_REGISTRY_OPTIONS,
  ) {}

  get size(): number {
    return this.games.size;
  }

  /** Returns null when the server is at capacity. */
  create(): GameSession | null {
    this.sweep();
    if (this.games.size >= this.options.maxGames) return null;
    let id: string;
    do {
      id = Array.from({ length: CODE_LENGTH }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join('');
    } while (this.games.has(id));
    const session = new GameSession(id, this.dungeon);
    this.games.set(id, session);
    return session;
  }

  get(gameId: string): GameSession | undefined {
    return this.games.get(gameId);
  }

  /** Removes games that have had no connection for longer than the idle timeout. */
  sweep(now: number = Date.now()): void {
    for (const [id, session] of this.games) {
      if (!session.hasConnections() && now - session.idleSince() > this.options.idleTimeoutMs) {
        this.games.delete(id);
      }
    }
  }
}
