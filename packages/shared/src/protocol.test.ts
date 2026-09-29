import { describe, expect, it } from 'vitest';
import { MAX_CLIENT_MESSAGE_BYTES } from './constants.ts';
import { parseClientMessage, sanitizePlayerName } from './protocol.ts';

describe('parseClientMessage', () => {
  it('accepts well-formed messages', () => {
    expect(parseClientMessage('{"type":"MOVE_CHARACTER","characterId":"hero-1","target":{"x":7,"y":4},"requestId":"r1"}')).toEqual({
      type: 'MOVE_CHARACTER',
      characterId: 'hero-1',
      target: { x: 7, y: 4 },
      requestId: 'r1',
    });
    expect(parseClientMessage('{"type":"JOIN_GAME","gameId":"abcde","playerName":"  Ana  "}')).toEqual({
      type: 'JOIN_GAME',
      gameId: 'ABCDE',
      playerName: 'Ana',
    });
    expect(parseClientMessage('{"type":"END_TURN"}')).toEqual({ type: 'END_TURN' });
  });

  it('accepts the remaining message types', () => {
    expect(parseClientMessage('{"type":"OPEN_DOOR","characterId":"hero-1","doorId":"door-1","requestId":"r2"}')).toEqual({
      type: 'OPEN_DOOR',
      characterId: 'hero-1',
      doorId: 'door-1',
      requestId: 'r2',
    });
    expect(parseClientMessage('{"type":"RESUME_SESSION","gameId":"abcde","playerToken":"0f8c-11aa"}')).toEqual({
      type: 'RESUME_SESSION',
      gameId: 'ABCDE',
      playerToken: '0f8c-11aa',
    });
    expect(parseClientMessage('{"type":"RESTART_GAME"}')).toEqual({ type: 'RESTART_GAME' });
    expect(parseClientMessage('{"type":"CREATE_GAME","playerName":"Ana"}')).toEqual({ type: 'CREATE_GAME', playerName: 'Ana' });
  });

  it('only honours takeOver when it is literally true', () => {
    expect(parseClientMessage('{"type":"JOIN_GAME","gameId":"ABCDE","playerName":"Cid","takeOver":true}')).toEqual({
      type: 'JOIN_GAME',
      gameId: 'ABCDE',
      playerName: 'Cid',
      takeOver: true,
    });
    expect(parseClientMessage('{"type":"JOIN_GAME","gameId":"ABCDE","playerName":"Cid","takeOver":"true"}')).toEqual({
      type: 'JOIN_GAME',
      gameId: 'ABCDE',
      playerName: 'Cid',
    });
  });

  it('rejects malformed input without throwing', () => {
    const bad = [
      'not json',
      'null',
      '[]',
      '{"type":"NOPE"}',
      '{"type":"MOVE_CHARACTER","characterId":"hero-1","target":{"x":1.5,"y":4}}',
      '{"type":"MOVE_CHARACTER","characterId":"hero-1","target":{"x":"1","y":4}}',
      '{"type":"MOVE_CHARACTER","characterId":"hero 1","target":{"x":1,"y":4}}',
      '{"type":"MOVE_CHARACTER","characterId":"hero-1"}',
      '{"type":"MOVE_CHARACTER","characterId":"hero-1","target":{"x":10000,"y":4}}',
      '{"type":"MOVE_CHARACTER","characterId":"hero-1","target":{"x":1,"y":-10000}}',
      '{"type":"OPEN_DOOR","characterId":"hero-1","doorId":{}}',
      '{"type":"CREATE_GAME","playerName":"   "}',
      '{"type":"RESUME_SESSION","gameId":"ABCDE"}',
    ];
    for (const raw of bad) expect(parseClientMessage(raw)).toBeNull();
  });

  it('rejects frames above the size limit', () => {
    const padding = ' '.repeat(MAX_CLIENT_MESSAGE_BYTES);
    expect(parseClientMessage(`{"type":"END_TURN"}${padding}`)).toBeNull();
    expect(parseClientMessage(`{"type":"END_TURN"}${' '.repeat(100)}`)).toEqual({ type: 'END_TURN' });
  });

  it('drops invalid request ids instead of echoing them', () => {
    expect(parseClientMessage('{"type":"END_TURN","requestId":"<script>"}')).toEqual({ type: 'END_TURN' });
    expect(parseClientMessage(`{"type":"END_TURN","requestId":"${'a'.repeat(65)}"}`)).toEqual({ type: 'END_TURN' });
  });

  it('strips unknown fields from nested positions', () => {
    expect(
      parseClientMessage('{"type":"MOVE_CHARACTER","characterId":"hero-1","target":{"x":1,"y":2,"evil":"x"},"extra":1}'),
    ).toEqual({ type: 'MOVE_CHARACTER', characterId: 'hero-1', target: { x: 1, y: 2 } });
  });
});

describe('sanitizePlayerName', () => {
  it('strips control characters and limits the length', () => {
    expect(sanitizePlayerName('A\u0000n​a')).toBe('Ana');
    expect(sanitizePlayerName('x'.repeat(50))).toHaveLength(20);
    expect(sanitizePlayerName(42)).toBeNull();
  });

  it('turns tabs and newlines into single spaces', () => {
    expect(sanitizePlayerName('Ana\tBen')).toBe('Ana Ben');
    expect(sanitizePlayerName('Ana\r\n\nBen')).toBe('Ana Ben');
  });

  it('never splits a surrogate pair when cutting', () => {
    const name = sanitizePlayerName(`${'a'.repeat(19)}🐉🐉`);
    expect(name).toBe(`${'a'.repeat(19)}🐉`);
    expect(Array.from(name!).at(-1)).toBe('🐉');
  });

  it('does not leave a trailing space after cutting', () => {
    expect(sanitizePlayerName(`${'a'.repeat(19)} bcd`)).toBe('a'.repeat(19));
  });
});
