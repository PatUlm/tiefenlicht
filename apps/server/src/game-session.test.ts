import { describe, expect, it } from 'vitest';
import { PROTOTYPE_DUNGEON } from '@dungeon/game-core/content';
import type { ServerMessage } from '@dungeon/shared';
import { CLOSE_TOO_MANY_ATTEMPTS, ClientHandler, MAX_FAILED_LOOKUPS } from './client-handler.ts';
import { GameRegistry } from './game-registry.ts';
import { CLOSE_REPLACED, type Connection } from './game-session.ts';

class FakeConnection implements Connection {
  readonly messages: ServerMessage[] = [];
  closed: { code: number; reason: string } | undefined;
  send(message: ServerMessage) {
    this.messages.push(message);
  }
  close(code: number, reason: string) {
    this.closed = { code, reason };
  }
  last<T extends ServerMessage['type']>(type: T): Extract<ServerMessage, { type: T }> | undefined {
    return this.messages.filter((m): m is Extract<ServerMessage, { type: T }> => m.type === type).at(-1);
  }
}

function client(registry: GameRegistry) {
  const conn = new FakeConnection();
  const handler = new ClientHandler(conn, registry);
  const send = (msg: object) => handler.onMessage(JSON.stringify(msg));
  return { conn, handler, send };
}

function twoPlayerGame() {
  const registry = new GameRegistry(PROTOTYPE_DUNGEON);
  const a = client(registry);
  a.send({ type: 'CREATE_GAME', playerName: 'Ana' });
  const session = a.conn.last('SESSION')!;
  const b = client(registry);
  b.send({ type: 'JOIN_GAME', gameId: session.gameId.toLowerCase(), playerName: 'Ben' });
  return { registry, a, b, gameId: session.gameId, tokenA: session.playerToken, tokenB: b.conn.last('SESSION')!.playerToken };
}

describe('lobby flow', () => {
  it('creates a game, lets a second player join and starts it for both', () => {
    const { a, b, gameId } = twoPlayerGame();
    expect(gameId).toMatch(/^[A-Z2-9]{5}$/);
    expect(b.conn.last('GAME_STATE')?.view.phase).toBe('playing');
    const update = a.conn.last('GAME_UPDATE')!;
    expect(update.events.map((e) => e.type)).toEqual(['PLAYER_JOINED', 'GAME_STARTED', 'TURN_STARTED']);
    expect(update.view.version).toBe(b.conn.last('GAME_STATE')!.view.version);
  });

  it('never sends a token to anyone but its owner', () => {
    const { a, b, tokenA, tokenB } = twoPlayerGame();
    b.send({ type: 'MOVE_CHARACTER', characterId: 'hero-2', target: { x: 10, y: 2, level: 0 } });
    a.send({ type: 'END_TURN' });
    expect(JSON.stringify(b.conn.messages)).not.toContain(tokenA);
    expect(JSON.stringify(a.conn.messages)).not.toContain(tokenB);
  });

  it('rejects unknown games, a third player and malformed messages', () => {
    const { registry, gameId } = twoPlayerGame();
    const c = client(registry);
    c.send({ type: 'JOIN_GAME', gameId: 'ZZZZZ', playerName: 'Cid' });
    expect(c.conn.last('ERROR')?.code).toBe('GAME_NOT_FOUND');
    c.send({ type: 'JOIN_GAME', gameId, playerName: 'Cid' });
    expect(c.conn.last('ERROR')).toMatchObject({ code: 'GAME_FULL' });
    expect(c.conn.last('ERROR')?.canTakeOver).toBeUndefined();
    c.handler.onMessage('{"type":"MOVE_CHARACTER","target":{"x":1e9}}');
    expect(c.conn.last('ERROR')?.code).toBe('BAD_MESSAGE');
    c.send({ type: 'END_TURN' });
    expect(c.conn.last('ERROR')?.code).toBe('NO_SESSION');
  });
});

describe('actions', () => {
  it('broadcasts accepted actions and rejects others only to the sender', () => {
    const { a, b } = twoPlayerGame();
    const bBefore = b.conn.messages.length;
    b.send({ type: 'END_TURN', requestId: 'r1' });
    expect(b.conn.last('ACTION_REJECTED')).toMatchObject({ code: 'NOT_YOUR_TURN', requestId: 'r1' });
    expect(a.conn.messages.at(-1)?.type).toBe('GAME_UPDATE');
    expect(b.conn.messages.length).toBe(bBefore + 1);

    a.send({ type: 'MOVE_CHARACTER', characterId: 'hero-1', target: { x: 9, y: 4, level: 0 } });
    for (const c of [a, b]) {
      expect(c.conn.last('GAME_UPDATE')?.events).toEqual([
        { type: 'CHARACTER_MOVED', characterId: 'hero-1', path: [2, 3, 4].map((y) => ({ x: 9, y, level: 0 })) },
      ]);
    }
  });
});

describe('reconnect and takeover (M9)', () => {
  it('marks disconnects and resumes with the token as a snapshot', () => {
    const { registry, a, b, gameId, tokenB } = twoPlayerGame();
    b.handler.onClose();
    expect(a.conn.last('GAME_UPDATE')?.events).toEqual([{ type: 'PLAYER_CONNECTION', playerId: 'player-2', connected: false }]);

    const b2 = client(registry);
    b2.send({ type: 'RESUME_SESSION', gameId, playerToken: tokenB });
    expect(b2.conn.last('SESSION')?.playerId).toBe('player-2');
    expect(b2.conn.last('GAME_STATE')?.view.players.every((p) => p.connected)).toBe(true);
    expect(a.conn.last('GAME_UPDATE')?.events).toEqual([{ type: 'PLAYER_CONNECTION', playerId: 'player-2', connected: true }]);
  });

  it('replaces an older live connection that uses the same token', () => {
    const { registry, a, gameId, tokenA } = twoPlayerGame();
    const a2 = client(registry);
    a2.send({ type: 'RESUME_SESSION', gameId, playerToken: tokenA });
    expect(a.conn.closed?.code).toBe(CLOSE_REPLACED);
    // The old socket closing afterwards must not mark the player as disconnected.
    a.handler.onClose();
    a2.send({ type: 'END_TURN' });
    expect(a2.conn.last('GAME_UPDATE')?.view.players.every((p) => p.connected)).toBe(true);
  });

  it('rejects unknown tokens', () => {
    const { registry, gameId } = twoPlayerGame();
    const c = client(registry);
    c.send({ type: 'RESUME_SESSION', gameId, playerToken: 'not-a-token' });
    expect(c.conn.last('ERROR')?.code).toBe('INVALID_SESSION');
  });

  it('offers and performs a takeover of a disconnected seat, revoking the old token', () => {
    const { registry, a, b, gameId, tokenB } = twoPlayerGame();
    b.handler.onClose();
    const c = client(registry);
    c.send({ type: 'JOIN_GAME', gameId, playerName: 'Cid' });
    expect(c.conn.last('ERROR')).toMatchObject({ code: 'GAME_FULL', canTakeOver: true });
    c.send({ type: 'JOIN_GAME', gameId, playerName: 'Cid', takeOver: true });
    expect(c.conn.last('SESSION')?.playerId).toBe('player-2');
    expect(a.conn.last('GAME_UPDATE')?.view.players.find((p) => p.id === 'player-2')).toMatchObject({ name: 'Cid', connected: true });

    const old = client(registry);
    old.send({ type: 'RESUME_SESSION', gameId, playerToken: tokenB });
    expect(old.conn.last('ERROR')?.code).toBe('INVALID_SESSION');
  });
});

describe('review 03 hardening', () => {
  it('echoes the requestId only to the originating connection', () => {
    const { a, b } = twoPlayerGame();
    a.send({ type: 'MOVE_CHARACTER', characterId: 'hero-1', target: { x: 9, y: 3, level: 0 }, requestId: 'r7' });
    expect(a.conn.last('GAME_UPDATE')?.requestId).toBe('r7');
    expect(b.conn.last('GAME_UPDATE')?.requestId).toBeUndefined();
  });

  it('treats a takeover request in the waiting phase as a normal join (creator seat stays safe)', () => {
    const registry = new GameRegistry(PROTOTYPE_DUNGEON);
    const a = client(registry);
    a.send({ type: 'CREATE_GAME', playerName: 'Ana' });
    const { gameId, playerToken } = a.conn.last('SESSION')!;
    a.handler.onClose();
    const eve = client(registry);
    eve.send({ type: 'JOIN_GAME', gameId, playerName: 'Eve', takeOver: true });
    expect(eve.conn.last('SESSION')?.playerId).toBe('player-2');
    const back = client(registry);
    back.send({ type: 'RESUME_SESSION', gameId, playerToken });
    expect(back.conn.last('SESSION')?.playerId).toBe('player-1');
  });

  it('ignores actions sent over a replaced connection', () => {
    const { registry, a, b, gameId, tokenA } = twoPlayerGame();
    const a2 = client(registry);
    a2.send({ type: 'RESUME_SESSION', gameId, playerToken: tokenA });
    const before = b.conn.messages.length;
    a.send({ type: 'END_TURN' });
    expect(b.conn.messages.length).toBe(before);
    expect(a.conn.last('ACTION_REJECTED')).toBeUndefined();
  });

  it('restarts for both players via the handler', () => {
    const { a, b } = twoPlayerGame();
    a.send({ type: 'MOVE_CHARACTER', characterId: 'hero-1', target: { x: 9, y: 3, level: 0 } });
    b.send({ type: 'RESTART_GAME' });
    for (const c of [a, b]) {
      const update = c.conn.last('GAME_UPDATE')!;
      expect(update.events[0]).toEqual({ type: 'GAME_RESTARTED', byPlayerId: 'player-2' });
      expect(update.view.heroes[0]?.position).toEqual({ x: 9, y: 1, level: 0 });
    }
  });

  it('closes a socket after too many failed code or token lookups', () => {
    const registry = new GameRegistry(PROTOTYPE_DUNGEON);
    const c = client(registry);
    for (let i = 0; i < MAX_FAILED_LOOKUPS - 1; i++) c.send({ type: 'JOIN_GAME', gameId: `ZZZZ${i}`, playerName: 'Cid' });
    expect(c.conn.closed).toBeUndefined();
    c.send({ type: 'RESUME_SESSION', gameId: 'ZZZZZ', playerToken: 'nope' });
    expect(c.conn.closed?.code).toBe(CLOSE_TOO_MANY_ATTEMPTS);
  });
});

describe('registry', () => {
  it('expires idle games without connections and enforces capacity', () => {
    const registry = new GameRegistry(PROTOTYPE_DUNGEON, { maxGames: 1, idleTimeoutMs: 1000 });
    const a = client(registry);
    a.send({ type: 'CREATE_GAME', playerName: 'Ana' });
    const b = client(registry);
    b.send({ type: 'CREATE_GAME', playerName: 'Ben' });
    expect(b.conn.last('ERROR')?.code).toBe('GAME_FULL');

    registry.sweep(Date.now() + 10_000);
    expect(registry.size).toBe(1); // still connected
    a.handler.onClose();
    registry.sweep(Date.now() + 10_000);
    expect(registry.size).toBe(0);
  });
});
