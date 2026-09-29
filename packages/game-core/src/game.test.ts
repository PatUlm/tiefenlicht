import { describe, expect, it } from 'vitest';
import { posKey, type Position } from '@dungeon/shared';
import { PROTOTYPE_DUNGEON } from './content/index.ts';
import { addPlayer, applyAction, canStillAct, createGame, openableDoors, setPlayerConnected } from './game.ts';
import type { GameState } from './state.ts';
import { act, P1, P2, startedGame } from './test-helpers.ts';
import { createView } from './visibility.ts';

const move = (characterId: string, target: Position) => ({ type: 'MOVE_CHARACTER', characterId, target }) as const;
const open = (characterId: string, doorId: string) => ({ type: 'OPEN_DOOR', characterId, doorId }) as const;
const END = { type: 'END_TURN' } as const;

/** Plays the expected opening from docs/game-mechanics.md M8 up to the given turn. */
function playOpening(turns: number, from: GameState = startedGame()): GameState {
  let s = from;
  const steps: [string, (s: GameState) => GameState][] = [
    [P1, (g) => act(act(act(g, P1, move('hero-1', { x: 9, y: 6 })).state, P1, open('hero-1', 'door-1')).state, P1, move('hero-1', { x: 9, y: 9 })).state],
    [P2, (g) => act(g, P2, move('hero-2', { x: 10, y: 9 })).state],
    [P1, (g) => act(act(g, P1, move('hero-1', { x: 4, y: 12 })).state, P1, open('hero-1', 'door-2')).state],
    [P2, (g) => act(act(g, P2, move('hero-2', { x: 15, y: 12 })).state, P2, open('hero-2', 'door-3')).state],
  ];
  for (const [player, turn] of steps.slice(0, turns)) {
    s = turn(s);
    s = act(s, player, END).state;
  }
  return s;
}

describe('game setup', () => {
  it('waits for two players, then starts with slot 0', () => {
    let s = createGame('G', PROTOTYPE_DUNGEON);
    const first = addPlayer(s, P1, 'Ana');
    expect(first.ok && first.state.phase).toBe('waiting');
    s = (first as Extract<typeof first, { ok: true }>).state;
    const second = addPlayer(s, P2, 'Ben');
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.state.phase).toBe('playing');
    expect(second.state.turn).toMatchObject({ activePlayerId: P1, round: 1, movementLeft: 8, actionsLeft: 1 });
    expect(second.state.heroes.map((h) => h.kind)).toEqual(['dwarf', 'darkelf']);
    expect(second.events.map((e) => e.type)).toEqual(['PLAYER_JOINED', 'GAME_STARTED', 'TURN_STARTED']);
    expect(addPlayer(second.state, 'player-3', 'Cid')).toEqual({ ok: false, code: 'GAME_FULL' });
  });

  it('rejects every action, including a restart, before the game started', () => {
    const joined = addPlayer(createGame('G', PROTOTYPE_DUNGEON), P1, 'Ana');
    if (!joined.ok) throw new Error();
    for (const action of [END, move('hero-1', { x: 9, y: 2 }), open('hero-1', 'door-1'), { type: 'RESTART_GAME' } as const]) {
      expect(applyAction(joined.state, P1, action)).toMatchObject({ ok: false, code: 'GAME_NOT_RUNNING' });
    }
  });

  it('rejects unknown action types at runtime instead of throwing', () => {
    const bogus = { type: 'JOIN_GAME' } as unknown as Parameters<typeof applyAction>[2];
    expect(applyAction(startedGame(), P1, bogus)).toMatchObject({ ok: false, code: 'GAME_NOT_RUNNING' });
  });

  it('tracks connection state with a version bump', () => {
    const s = startedGame();
    const off = setPlayerConnected(s, P2, false);
    expect(off.state.players.find((p) => p.id === P2)?.connected).toBe(false);
    expect(off.state.version).toBe(s.version + 1);
    expect(setPlayerConnected(off.state, P2, false).events).toEqual([]);
  });
});

describe('turn order and authority', () => {
  it('only lets the active player act, and only with their own hero', () => {
    const s = startedGame();
    expect(applyAction(s, P2, move('hero-2', { x: 10, y: 2 }))).toMatchObject({ ok: false, code: 'NOT_YOUR_TURN' });
    expect(applyAction(s, P1, move('hero-2', { x: 10, y: 2 }))).toMatchObject({ ok: false, code: 'NOT_YOUR_CHARACTER' });
    expect(applyAction(s, P1, move('hero-9', { x: 10, y: 2 }))).toMatchObject({ ok: false, code: 'UNKNOWN_CHARACTER' });
    expect(applyAction(s, 'stranger', END)).toMatchObject({ ok: false, code: 'NOT_YOUR_TURN' });
    expect(applyAction(s, 'stranger', { type: 'RESTART_GAME' })).toMatchObject({ ok: false, code: 'NOT_YOUR_TURN' });
  });

  it('applies the same authority checks to OPEN_DOOR', () => {
    const s = act(startedGame(), P1, move('hero-1', { x: 9, y: 6 })).state;
    expect(applyAction(s, P2, open('hero-2', 'door-1'))).toMatchObject({ ok: false, code: 'NOT_YOUR_TURN' });
    expect(applyAction(s, P1, open('hero-2', 'door-1'))).toMatchObject({ ok: false, code: 'NOT_YOUR_CHARACTER' });
    expect(applyAction(s, P1, open('hero-9', 'door-1'))).toMatchObject({ ok: false, code: 'UNKNOWN_CHARACTER' });
  });

  it('alternates turns, refreshes the budget and counts rounds', () => {
    let s = startedGame();
    s = act(s, P1, move('hero-1', { x: 9, y: 3 })).state;
    expect(s.turn?.movementLeft).toBe(6);
    const ended = act(s, P1, END);
    expect(ended.events).toEqual([{ type: 'TURN_STARTED', playerId: P2, round: 1 }]);
    expect(ended.state.turn).toMatchObject({ activePlayerId: P2, movementLeft: 8, actionsLeft: 1 });
    const back = act(ended.state, P2, END);
    expect(back.state.turn).toMatchObject({ activePlayerId: P1, round: 2 });
  });
});

describe('movement', () => {
  it('moves along the server-computed path and spends movement', () => {
    const s = startedGame();
    const result = act(s, P1, move('hero-1', { x: 9, y: 6 }));
    expect(result.events).toEqual([
      {
        type: 'CHARACTER_MOVED',
        characterId: 'hero-1',
        path: [2, 3, 4, 5, 6].map((y) => ({ x: 9, y })),
      },
    ]);
    expect(result.state.heroes[0]).toMatchObject({ position: { x: 9, y: 6 }, facing: 'S' });
    expect(result.state.turn?.movementLeft).toBe(3);
  });

  it('allows splitting movement and rejects moves beyond the budget', () => {
    let s = startedGame();
    s = act(s, P1, move('hero-1', { x: 9, y: 4 })).state;
    s = act(s, P1, move('hero-1', { x: 10, y: 6 })).state;
    expect(s.turn?.movementLeft).toBe(2);
    expect(applyAction(s, P1, move('hero-1', { x: 5, y: 5 }))).toMatchObject({ ok: false, code: 'NOT_ENOUGH_MOVEMENT' });
  });

  it('rejects hidden tiles with the same code as non-existing ones (no leak)', () => {
    const s = startedGame();
    // (4,18) holds a monster in the hidden crypt; (0,0) does not exist at all.
    const hiddenMonster = applyAction(s, P1, move('hero-1', { x: 4, y: 18 }));
    const nothing = applyAction(s, P1, move('hero-1', { x: 0, y: 0 }));
    expect(hiddenMonster).toMatchObject({ ok: false, code: 'INVALID_TARGET' });
    expect(nothing).toMatchObject({ ok: false, code: 'INVALID_TARGET' });
  });

  it('cannot pass the closed double door', () => {
    const s = startedGame();
    expect(applyAction(s, P1, move('hero-1', { x: 9, y: 7 }))).toMatchObject({ ok: false, code: 'INVALID_TARGET' });
  });

  it('rejects ending on the ally', () => {
    const s = startedGame();
    expect(applyAction(s, P1, move('hero-1', { x: 10, y: 1 }))).toMatchObject({ ok: false, code: 'TARGET_OCCUPIED' });
  });
});

describe('doors and discovery', () => {
  it('requires adjacency and an action', () => {
    let s = startedGame();
    expect(applyAction(s, P1, open('hero-1', 'door-1'))).toMatchObject({ ok: false, code: 'DOOR_NOT_ADJACENT' });
    expect(applyAction(s, P1, open('hero-1', 'door-2'))).toMatchObject({ ok: false, code: 'UNKNOWN_DOOR' });
    expect(applyAction(s, P1, open('hero-1', 'door-x'))).toMatchObject({ ok: false, code: 'UNKNOWN_DOOR' });
    s = act(s, P1, move('hero-1', { x: 10, y: 6 })).state; // either leaf of the double door works
    s = act(s, P1, open('hero-1', 'door-1')).state;
    expect(applyAction(s, P1, open('hero-1', 'door-1'))).toMatchObject({ ok: false, code: 'DOOR_ALREADY_OPEN' });
  });

  it('opening the double door reveals the corridor and allows moving on', () => {
    let s = startedGame();
    s = act(s, P1, move('hero-1', { x: 9, y: 6 })).state;
    const opened = act(s, P1, open('hero-1', 'door-1'));
    expect(opened.events).toEqual([
      { type: 'DOOR_OPENED', doorId: 'door-1', characterId: 'hero-1' },
      { type: 'AREA_REVEALED', areaId: 'corridor', viaDoorId: 'door-1', monsterIds: [] },
    ]);
    expect(opened.state.turn).toMatchObject({ actionsLeft: 0, movementLeft: 3 });
    const moved = act(opened.state, P1, move('hero-1', { x: 9, y: 9 }));
    expect(moved.state.turn?.movementLeft).toBe(0);
  });

  it('only one action per turn', () => {
    let s = startedGame();
    s = act(s, P1, move('hero-1', { x: 9, y: 6 })).state;
    s = { ...s, turn: { ...s.turn!, actionsLeft: 0 } };
    expect(applyAction(s, P1, open('hero-1', 'door-1'))).toMatchObject({ ok: false, code: 'NO_ACTION_LEFT' });
  });

  it('plays the expected opening: each player reveals a room with monsters in round 2', () => {
    const afterTurn3 = playOpening(3);
    expect(afterTurn3.revealedAreas).toContain('crypt');
    expect(afterTurn3.objectiveCompleted).toBe(false);

    let s = playOpening(3);
    s = act(s, P2, move('hero-2', { x: 15, y: 12 })).state;
    const final = act(s, P2, open('hero-2', 'door-3'));
    expect(final.events.map((e) => e.type)).toEqual(['DOOR_OPENED', 'AREA_REVEALED', 'GAME_WON']);
    expect(final.events[1]).toMatchObject({ areaId: 'mage', monsterIds: ['monster-3'] });
    expect(final.state.objectiveCompleted).toBe(true);
  });

  it('keeps the game running after the objective (M7) and announces victory only once', () => {
    let s = playOpening(4);
    expect(s.phase).toBe('playing');
    s = act(s, P1, move('hero-1', { x: 4, y: 14 })).state;
    expect(s.heroes[0]?.position).toEqual({ x: 4, y: 14 });
    expect(act(s, P1, END).events.some((e) => e.type === 'GAME_WON')).toBe(false);
  });

  it('reveals the crypt monsters with the crypt', () => {
    const s = playOpening(2);
    const moved = act(s, P1, move('hero-1', { x: 4, y: 12 })).state;
    const opened = act(moved, P1, open('hero-1', 'door-2'));
    expect(opened.events[1]).toMatchObject({ type: 'AREA_REVEALED', areaId: 'crypt', monsterIds: ['monster-1', 'monster-2'] });
  });
});

describe('restart', () => {
  it('lets any player restart at any time with the same slots', () => {
    const s = playOpening(3);
    const restarted = act(s, P2, { type: 'RESTART_GAME' });
    expect(restarted.events).toEqual([
      { type: 'GAME_RESTARTED', byPlayerId: P2 },
      { type: 'TURN_STARTED', playerId: P1, round: 1 },
    ]);
    expect(restarted.state.version).toBe(s.version + 1);
    expect(restarted.state.revealedAreas).toEqual(['hall']);
    expect(restarted.state.openDoors).toEqual([]);
    expect(restarted.state.players).toEqual(s.players);
    expect(restarted.state.heroes.map((h) => h.position)).toEqual([
      { x: 9, y: 1 },
      { x: 10, y: 1 },
    ]);
  });

  it('resets the objective so a new round can be won again', () => {
    const won = playOpening(4);
    expect(won.objectiveCompleted).toBe(true);
    const restarted = act(won, P1, { type: 'RESTART_GAME' }).state;
    expect(restarted.objectiveCompleted).toBe(false);
    expect(createView(restarted).objective).toMatchObject({ revealedAreas: 1, completed: false });

    let s = playOpening(3, restarted);
    s = act(s, P2, move('hero-2', { x: 15, y: 12 })).state;
    expect(act(s, P2, open('hero-2', 'door-3')).events.map((e) => e.type)).toContain('GAME_WON');
  });
});

describe('visibility (M6)', () => {
  it('initial view contains nothing outside the hall except the door edge', () => {
    const view = createView(startedGame());
    const hallTiles = new Set(view.areas.flatMap((a) => a.tiles).map(posKey));
    expect(view.areas.map((a) => a.id)).toEqual(['hall']);
    expect(view.monsters).toEqual([]);
    expect(view.doors.map((d) => d.id)).toEqual(['door-1']);
    const coords: Position[] = [
      ...view.props.map((p) => p.position),
      ...view.wallDecor.map((d) => d.position),
      ...view.heroes.map((h) => h.position),
    ];
    expect(coords.every((c) => hallTiles.has(posKey(c)))).toBe(true);
    const serialized = JSON.stringify(view);
    for (const secret of ['crypt', 'Krypta', 'mage', 'Magierstube', 'corridor', 'monster-']) {
      expect(serialized).not.toContain(secret);
    }
  });

  it('shows newly reachable doors once the corridor is revealed', () => {
    let s = startedGame();
    s = act(s, P1, move('hero-1', { x: 9, y: 6 })).state;
    s = act(s, P1, open('hero-1', 'door-1')).state;
    const view = createView(s);
    expect(view.doors.map((d) => [d.id, d.open])).toEqual([
      ['door-1', true],
      ['door-2', false],
      ['door-3', false],
    ]);
    expect(view.monsters).toEqual([]);
    expect(view.objective).toMatchObject({ revealedAreas: 2, totalAreas: 4, completed: false });
  });

  it('after the crypt reveal nothing of the hidden mage room leaks', () => {
    const s = playOpening(3); // crypt revealed, P2 to move, mage room still hidden
    const view = createView(s);
    expect(view.areas.map((a) => a.id).sort()).toEqual(['corridor', 'crypt', 'hall']);
    expect(view.monsters.map((m) => m.id)).toEqual(['monster-1', 'monster-2']);
    expect(view.props.some((p) => p.id.startsWith('mage-'))).toBe(false);
    expect(view.wallDecor.some((d) => d.id.startsWith('mage-'))).toBe(false);
    expect(view.doors.find((d) => d.id === 'door-3')).toMatchObject({ open: false });
    expect(JSON.stringify(view)).not.toContain('Magierstube');
    // Moving onto the hidden mage's tile is indistinguishable from a non-existing tile.
    expect(applyAction(s, P2, move('hero-2', { x: 16, y: 17 }))).toMatchObject({ ok: false, code: 'INVALID_TARGET' });
  });
});

describe('UI hints', () => {
  it('canStillAct turns false once nothing is possible', () => {
    let s = startedGame();
    expect(canStillAct(createView(s), P1)).toBe(true);
    expect(canStillAct(createView(s), P2)).toBe(false);
    s = act(s, P1, move('hero-1', { x: 9, y: 6 })).state;
    expect(openableDoors(createView(s), P1).map((d) => d.id)).toEqual(['door-1']);
    s = act(s, P1, open('hero-1', 'door-1')).state;
    s = act(s, P1, move('hero-1', { x: 9, y: 9 })).state;
    expect(canStillAct(createView(s), P1)).toBe(false);
  });

  it('canStillAct stays true with no movement left while a door can still be opened', () => {
    let s = startedGame();
    s = act(s, P1, move('hero-1', { x: 9, y: 6 })).state;
    s = act(s, P1, move('hero-1', { x: 9, y: 5 })).state;
    s = act(s, P1, move('hero-1', { x: 10, y: 5 })).state;
    s = act(s, P1, move('hero-1', { x: 10, y: 6 })).state;
    expect(s.turn).toMatchObject({ movementLeft: 0, actionsLeft: 1 });
    expect(canStillAct(createView(s), P1)).toBe(true);
    s = act(s, P1, open('hero-1', 'door-1')).state;
    expect(canStillAct(createView(s), P1)).toBe(false);
  });
});
