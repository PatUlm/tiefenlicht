import { describe, expect, it } from 'vitest';
import { posKey, type DungeonDefinition, type Position } from '@dungeon/shared';
import { PROTOTYPE_DUNGEON } from './content/index.ts';
import { addPlayer, applyAction, attackableMonsters, canStillAct, createGame, explorableStairs, openableDoors, setPlayerConnected } from './game.ts';
import type { GameState } from './state.ts';
import { act, P1, P2, startedGame } from './test-helpers.ts';
import { createView } from './visibility.ts';

const move = (characterId: string, target: Position) => ({ type: 'MOVE_CHARACTER', characterId, target }) as const;
const open = (characterId: string, doorId: string) => ({ type: 'OPEN_DOOR', characterId, doorId }) as const;
const explore = (characterId: string, stairsId: string) => ({ type: 'EXPLORE_STAIRS', characterId, stairsId }) as const;
const END = { type: 'END_TURN' } as const;
const attack = (characterId: string, targetId: string) => ({ type: 'ATTACK', characterId, targetId }) as const;

/** The prototype with v0.2 rules: monsters stay put, entering every area wins. Keeps the scripted opening stable. */
const STATIC_DUNGEON: DungeonDefinition = {
  ...PROTOTYPE_DUNGEON,
  victory: { type: 'visitAllAreas' },
  rules: { ...PROTOTYPE_DUNGEON.rules, monsterMovementPerTurn: 0 },
};

/** Plays the expected opening from docs/game-mechanics.md M8 up to the given turn. */
function playOpening(turns: number, from: GameState = startedGame(STATIC_DUNGEON)): GameState {
  let s = from;
  const steps: [string, (s: GameState) => GameState][] = [
    [P1, (g) => act(act(act(g, P1, move('hero-1', { x: 9, y: 6, level: 0 })).state, P1, open('hero-1', 'door-1')).state, P1, move('hero-1', { x: 9, y: 9, level: 0 })).state],
    [P2, (g) => act(g, P2, move('hero-2', { x: 10, y: 9, level: 0 })).state],
    [P1, (g) => act(act(g, P1, move('hero-1', { x: 4, y: 12, level: 0 })).state, P1, open('hero-1', 'door-2')).state],
    [P2, (g) => act(act(g, P2, move('hero-2', { x: 15, y: 12, level: 0 })).state, P2, open('hero-2', 'door-3')).state],
    [P1, (g) => act(g, P1, move('hero-1', { x: 7, y: 14, level: 0 })).state],
    // Exploring stairs with a movement point left takes the hero along to the other level.
    [P2, (g) => act(act(g, P2, move('hero-2', { x: 18, y: 16, level: 0 })).state, P2, explore('hero-2', 'stairs-1')).state],
    [P1, (g) => act(act(g, P1, move('hero-1', { x: 8, y: 17, level: 0 })).state, P1, explore('hero-1', 'stairs-2')).state],
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
    for (const action of [END, move('hero-1', { x: 9, y: 2, level: 0 }), open('hero-1', 'door-1'), { type: 'RESTART_GAME' } as const]) {
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
    expect(applyAction(s, P2, move('hero-2', { x: 10, y: 2, level: 0 }))).toMatchObject({ ok: false, code: 'NOT_YOUR_TURN' });
    expect(applyAction(s, P1, move('hero-2', { x: 10, y: 2, level: 0 }))).toMatchObject({ ok: false, code: 'NOT_YOUR_CHARACTER' });
    expect(applyAction(s, P1, move('hero-9', { x: 10, y: 2, level: 0 }))).toMatchObject({ ok: false, code: 'UNKNOWN_CHARACTER' });
    expect(applyAction(s, 'stranger', END)).toMatchObject({ ok: false, code: 'NOT_YOUR_TURN' });
    expect(applyAction(s, 'stranger', { type: 'RESTART_GAME' })).toMatchObject({ ok: false, code: 'NOT_YOUR_TURN' });
  });

  it('applies the same authority checks to OPEN_DOOR', () => {
    const s = act(startedGame(), P1, move('hero-1', { x: 9, y: 6, level: 0 })).state;
    expect(applyAction(s, P2, open('hero-2', 'door-1'))).toMatchObject({ ok: false, code: 'NOT_YOUR_TURN' });
    expect(applyAction(s, P1, open('hero-2', 'door-1'))).toMatchObject({ ok: false, code: 'NOT_YOUR_CHARACTER' });
    expect(applyAction(s, P1, open('hero-9', 'door-1'))).toMatchObject({ ok: false, code: 'UNKNOWN_CHARACTER' });
  });

  it('alternates turns, refreshes the budget and counts rounds', () => {
    let s = startedGame();
    s = act(s, P1, move('hero-1', { x: 9, y: 3, level: 0 })).state;
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
    const result = act(s, P1, move('hero-1', { x: 9, y: 6, level: 0 }));
    expect(result.events).toEqual([
      {
        type: 'CHARACTER_MOVED',
        characterId: 'hero-1',
        path: [2, 3, 4, 5, 6].map((y) => ({ x: 9, y, level: 0 })),
      },
    ]);
    expect(result.state.heroes[0]).toMatchObject({ position: { x: 9, y: 6, level: 0 }, facing: 'S' });
    expect(result.state.turn?.movementLeft).toBe(3);
  });

  it('allows splitting movement and rejects moves beyond the budget', () => {
    let s = startedGame();
    s = act(s, P1, move('hero-1', { x: 9, y: 4, level: 0 })).state;
    s = act(s, P1, move('hero-1', { x: 10, y: 6, level: 0 })).state;
    expect(s.turn?.movementLeft).toBe(2);
    expect(applyAction(s, P1, move('hero-1', { x: 5, y: 5, level: 0 }))).toMatchObject({ ok: false, code: 'NOT_ENOUGH_MOVEMENT' });
  });

  it('rejects hidden tiles with the same code as non-existing ones (no leak)', () => {
    const s = startedGame();
    // (4,18) holds a monster in the hidden crypt; (0,0) does not exist at all.
    const hiddenMonster = applyAction(s, P1, move('hero-1', { x: 4, y: 18, level: 0 }));
    const nothing = applyAction(s, P1, move('hero-1', { x: 0, y: 0, level: 0 }));
    expect(hiddenMonster).toMatchObject({ ok: false, code: 'INVALID_TARGET' });
    expect(nothing).toMatchObject({ ok: false, code: 'INVALID_TARGET' });
  });

  it('cannot pass the closed double door', () => {
    const s = startedGame();
    expect(applyAction(s, P1, move('hero-1', { x: 9, y: 7, level: 0 }))).toMatchObject({ ok: false, code: 'INVALID_TARGET' });
  });

  it('rejects ending on the ally', () => {
    const s = startedGame();
    expect(applyAction(s, P1, move('hero-1', { x: 10, y: 1, level: 0 }))).toMatchObject({ ok: false, code: 'TARGET_OCCUPIED' });
  });
});

describe('doors and discovery', () => {
  it('requires adjacency and an action', () => {
    let s = startedGame();
    expect(applyAction(s, P1, open('hero-1', 'door-1'))).toMatchObject({ ok: false, code: 'DOOR_NOT_ADJACENT' });
    expect(applyAction(s, P1, open('hero-1', 'door-2'))).toMatchObject({ ok: false, code: 'UNKNOWN_DOOR' });
    expect(applyAction(s, P1, open('hero-1', 'door-x'))).toMatchObject({ ok: false, code: 'UNKNOWN_DOOR' });
    s = act(s, P1, move('hero-1', { x: 10, y: 6, level: 0 })).state; // either leaf of the double door works
    s = act(s, P1, open('hero-1', 'door-1')).state;
    expect(applyAction(s, P1, open('hero-1', 'door-1'))).toMatchObject({ ok: false, code: 'DOOR_ALREADY_OPEN' });
  });

  it('opening the double door reveals the corridor and allows moving on', () => {
    let s = startedGame();
    s = act(s, P1, move('hero-1', { x: 9, y: 6, level: 0 })).state;
    const opened = act(s, P1, open('hero-1', 'door-1'));
    expect(opened.events).toEqual([
      { type: 'DOOR_OPENED', doorId: 'door-1', characterId: 'hero-1' },
      { type: 'AREA_REVEALED', areaId: 'corridor', via: { kind: 'door', id: 'door-1' }, monsterIds: [] },
    ]);
    expect(opened.state.turn).toMatchObject({ actionsLeft: 0, movementLeft: 3 });
    const moved = act(opened.state, P1, move('hero-1', { x: 9, y: 9, level: 0 }));
    expect(moved.state.turn?.movementLeft).toBe(0);
  });

  it('only one action per turn', () => {
    let s = startedGame();
    s = act(s, P1, move('hero-1', { x: 9, y: 6, level: 0 })).state;
    s = { ...s, turn: { ...s.turn!, actionsLeft: 0 } };
    expect(applyAction(s, P1, open('hero-1', 'door-1'))).toMatchObject({ ok: false, code: 'NO_ACTION_LEFT' });
  });

  it('plays the expected opening: each player reveals a room with monsters in round 2', () => {
    const afterTurn3 = playOpening(3);
    expect(afterTurn3.revealedAreas).toContain('crypt');

    let s = playOpening(3);
    s = act(s, P2, move('hero-2', { x: 15, y: 12, level: 0 })).state;
    const mage = act(s, P2, open('hero-2', 'door-3'));
    expect(mage.events.map((e) => e.type)).toEqual(['DOOR_OPENED', 'AREA_REVEALED']);
    expect(mage.events[1]).toMatchObject({ areaId: 'mage', monsterIds: ['monster-3'] });
    expect(mage.state.objectiveCompleted).toBe(false);
  });

  it('continues over both stairs and wins by entering the last chamber in round 4', () => {
    const afterTurn6 = playOpening(6);
    expect(afterTurn6.revealedAreas).toContain('observatory');
    expect(createView(afterTurn6).objective).toMatchObject({ revealedAreas: 5, visitedAreas: 5, completed: false });

    const s = act(playOpening(6), P1, move('hero-1', { x: 8, y: 17, level: 0 })).state;
    const explored = act(s, P1, explore('hero-1', 'stairs-2'));
    // Reveal first, then the hero takes the stairs down; entering the last area wins.
    expect(explored.events.map((e) => e.type)).toEqual(['STAIRS_EXPLORED', 'AREA_REVEALED', 'CHARACTER_MOVED', 'GAME_WON']);
    expect(explored.events[1]).toMatchObject({ areaId: 'ossuary', via: { kind: 'stairs', id: 'stairs-2' }, monsterIds: ['monster-4'] });
    expect(explored.events[2]).toEqual({ type: 'CHARACTER_MOVED', characterId: 'hero-1', path: [{ x: 8, y: 19, level: -1 }] });
    // Exploring from the landing faces the hero down the flight.
    expect(explored.state.heroes[0]).toMatchObject({ position: { x: 8, y: 19, level: -1 }, facing: 'S' });
    expect(explored.state.turn).toMatchObject({ actionsLeft: 0, movementLeft: 3, round: 4 });
    expect(explored.state.objectiveCompleted).toBe(true);
  });

  it('only reveals when no movement point is left; the hero stays', () => {
    let s = act(playOpening(6), P1, move('hero-1', { x: 8, y: 17, level: 0 })).state;
    s = { ...s, turn: { ...s.turn!, movementLeft: 0 } };
    const explored = act(s, P1, explore('hero-1', 'stairs-2'));
    expect(explored.events.map((e) => e.type)).toEqual(['STAIRS_EXPLORED', 'AREA_REVEALED']);
    expect(explored.state.heroes[0]).toMatchObject({ position: { x: 8, y: 17, level: 0 } });
    // All areas revealed is not enough: the ossuary still has to be entered.
    expect(explored.state.objectiveCompleted).toBe(false);
  });

  it('still supports the reveal-only objective', () => {
    let s = playOpening(6, startedGame({ ...STATIC_DUNGEON, victory: { type: 'revealAllAreas' } }));
    s = act(s, P1, move('hero-1', { x: 8, y: 17, level: 0 })).state;
    s = { ...s, turn: { ...s.turn!, movementLeft: 0 } };
    expect(act(s, P1, explore('hero-1', 'stairs-2')).events.map((e) => e.type)).toEqual(['STAIRS_EXPLORED', 'AREA_REVEALED', 'GAME_WON']);
  });

  it('keeps the game running after the objective (M7) and announces victory only once', () => {
    let s = playOpening(7);
    expect(s.phase).toBe('playing');
    s = act(s, P2, move('hero-2', { x: 17, y: 14, level: 1 })).state;
    expect(s.heroes[1]?.position).toEqual({ x: 17, y: 14, level: 1 });
    expect(act(s, P2, END).events.some((e) => e.type === 'GAME_WON')).toBe(false);
  });

  it('reveals the crypt monsters with the crypt', () => {
    const s = playOpening(2);
    const moved = act(s, P1, move('hero-1', { x: 4, y: 12, level: 0 })).state;
    const opened = act(moved, P1, open('hero-1', 'door-2'));
    expect(opened.events[1]).toMatchObject({ type: 'AREA_REVEALED', areaId: 'crypt', monsterIds: ['monster-1', 'monster-2'] });
  });
});

describe('stairs', () => {
  it('requires known stairs, standing at one of their ends and an action', () => {
    expect(applyAction(startedGame(), P1, explore('hero-1', 'stairs-1'))).toMatchObject({ ok: false, code: 'UNKNOWN_STAIRS' });
    let s = playOpening(5); // mage room and crypt revealed, P2 to move
    expect(applyAction(s, P2, explore('hero-2', 'stairs-x'))).toMatchObject({ ok: false, code: 'UNKNOWN_STAIRS' });
    expect(applyAction(s, P2, explore('hero-2', 'stairs-1'))).toMatchObject({ ok: false, code: 'STAIRS_NOT_ADJACENT' });
    s = act(s, P2, move('hero-2', { x: 18, y: 16, level: 0 })).state;
    s = { ...s, turn: { ...s.turn!, actionsLeft: 0 } };
    expect(applyAction(s, P2, explore('hero-2', 'stairs-1'))).toMatchObject({ ok: false, code: 'NO_ACTION_LEFT' });
  });

  it('unexplored stairs lead nowhere: the far level does not exist yet', () => {
    let s = playOpening(5);
    s = act(s, P2, move('hero-2', { x: 18, y: 16, level: 0 })).state;
    expect(applyAction(s, P2, move('hero-2', { x: 18, y: 14, level: 1 }))).toMatchObject({ ok: false, code: 'INVALID_TARGET' });
    const explored = act(s, P2, explore('hero-2', 'stairs-1'));
    expect(explored.events[0]).toEqual({ type: 'STAIRS_EXPLORED', stairsId: 'stairs-1', characterId: 'hero-2' });
    expect(explored.events[1]).toMatchObject({ areaId: 'observatory', via: { kind: 'stairs', id: 'stairs-1' }, monsterIds: ['monster-5'] });
    // The last movement point takes the hero up right away.
    expect(explored.events[2]).toEqual({ type: 'CHARACTER_MOVED', characterId: 'hero-2', path: [{ x: 18, y: 14, level: 1 }] });
    expect(explored.state.heroes[1]).toMatchObject({ position: { x: 18, y: 14, level: 1 }, facing: 'N' });
    expect(explored.state.turn).toMatchObject({ actionsLeft: 0, movementLeft: 0 });
    expect(applyAction(explored.state, P2, explore('hero-2', 'stairs-1'))).toMatchObject({ ok: false, code: 'STAIRS_ALREADY_EXPLORED' });
  });

  it('one step leads from the landing down to the foot and back up', () => {
    let s = playOpening(7); // stairs-1 explored, hero-2 on its landing, P2 to move
    const down = act(s, P2, move('hero-2', { x: 18, y: 16, level: 0 }));
    expect(down.events[0]).toEqual({ type: 'CHARACTER_MOVED', characterId: 'hero-2', path: [{ x: 18, y: 16, level: 0 }] });
    expect(down.state.heroes[1]).toMatchObject({ facing: 'S' });
    expect(down.state.turn?.movementLeft).toBe(7);
    s = act(down.state, P2, move('hero-2', { x: 18, y: 17, level: 0 })).state;
    const up = act(s, P2, move('hero-2', { x: 17, y: 14, level: 1 }));
    expect(up.events[0]).toMatchObject({
      path: [
        { x: 18, y: 16, level: 0 },
        { x: 18, y: 14, level: 1 },
        { x: 17, y: 14, level: 1 },
      ],
    });
    expect(up.state.turn?.movementLeft).toBe(3);
  });
});

describe('monsters and combat (M10)', () => {
  /** Real prototype rules: hero-1 opens the crypt in round 2 and waits in its doorway (4,12); P2 is to end the round. */
  function cryptOpened(): GameState {
    let s = startedGame();
    s = act(act(act(s, P1, move('hero-1', { x: 9, y: 6, level: 0 })).state, P1, open('hero-1', 'door-1')).state, P1, move('hero-1', { x: 9, y: 9, level: 0 })).state;
    s = act(s, P1, END).state;
    s = act(act(s, P2, move('hero-2', { x: 10, y: 9, level: 0 })).state, P2, END).state;
    s = act(act(s, P1, move('hero-1', { x: 4, y: 12, level: 0 })).state, P1, open('hero-1', 'door-2')).state;
    return act(s, P1, END).state;
  }
  /** One more round later: monster-2 stands in the crypt doorway (4,13), right below hero-1; P1 is to move. */
  const doorwayBlocked = () => act(act(act(cryptOpened(), P2, END).state, P1, END).state, P2, END).state;

  it('dormant monsters in hidden areas do not move', () => {
    const s = act(startedGame(), P1, END).state;
    const ended = act(s, P2, END);
    expect(ended.events).toEqual([{ type: 'TURN_STARTED', playerId: P1, round: 2 }]);
    expect(ended.state.monsters).toEqual(s.monsters);
  });

  it('awake monsters walk up to three steps towards the nearest hero once both players have moved', () => {
    const ended = act(cryptOpened(), P2, END);
    expect(ended.events).toEqual([
      { type: 'MONSTER_PHASE', round: 2 },
      // Around the sarcophagus, then up the crypt.
      { type: 'CHARACTER_MOVED', characterId: 'monster-1', path: [{ x: 5, y: 18, level: 0 }, { x: 5, y: 17, level: 0 }, { x: 5, y: 16, level: 0 }] },
      { type: 'CHARACTER_MOVED', characterId: 'monster-2', path: [{ x: 7, y: 14, level: 0 }, { x: 7, y: 13, level: 0 }, { x: 6, y: 13, level: 0 }] },
      { type: 'TURN_STARTED', playerId: P1, round: 3 },
    ]);
    expect(ended.state.monsters.find((m) => m.id === 'monster-2')).toMatchObject({ position: { x: 6, y: 13, level: 0 }, facing: 'W' });
    // The mage room is still hidden: its monster sleeps.
    expect(ended.state.monsters.find((m) => m.id === 'monster-3')?.position).toEqual(PROTOTYPE_DUNGEON.monsters[2]!.position);
  });

  it('a monster next to a hero stays where it is', () => {
    const s = doorwayBlocked();
    expect(s.monsters.find((m) => m.id === 'monster-2')?.position).toEqual({ x: 4, y: 13, level: 0 });
    const ended = act(act(s, P1, END).state, P2, END);
    expect(ended.events.some((e) => e.type === 'CHARACTER_MOVED' && e.characterId === 'monster-2')).toBe(false);
  });

  it('a hero strikes an adjacent monster across an open door, using the action', () => {
    const s = doorwayBlocked();
    expect(attackableMonsters(createView(s), P1).map((m) => m.id)).toEqual(['monster-2']);
    const struck = act(s, P1, attack('hero-1', 'monster-2'));
    expect(struck.events).toEqual([{ type: 'MONSTER_DEFEATED', monsterId: 'monster-2', characterId: 'hero-1' }]);
    expect(struck.state.monsters.map((m) => m.id)).not.toContain('monster-2');
    expect(struck.state.heroes[0]).toMatchObject({ position: { x: 4, y: 12, level: 0 }, facing: 'S' });
    expect(struck.state.turn).toMatchObject({ actionsLeft: 0, movementLeft: 8 });
    expect(createView(struck.state).objective).toMatchObject({ defeatedMonsters: 1, completed: false });
    // The way into the crypt is free again.
    expect(act(struck.state, P1, move('hero-1', { x: 4, y: 13, level: 0 })).state.heroes[0]?.position).toEqual({ x: 4, y: 13, level: 0 });
  });

  it('rejects strikes on hidden, distant or walled-off monsters and without an action', () => {
    expect(applyAction(startedGame(), P1, attack('hero-1', 'monster-1'))).toMatchObject({ ok: false, code: 'UNKNOWN_CHARACTER' });
    expect(applyAction(startedGame(), P1, attack('hero-1', 'monster-99'))).toMatchObject({ ok: false, code: 'UNKNOWN_CHARACTER' });
    expect(applyAction(startedGame(), P2, attack('hero-2', 'monster-1'))).toMatchObject({ ok: false, code: 'NOT_YOUR_TURN' });

    const s = act(cryptOpened(), P2, END).state; // monster-2 at (6,13), inside the crypt wall
    expect(applyAction(s, P1, attack('hero-1', 'monster-2'))).toMatchObject({ ok: false, code: 'TARGET_NOT_ADJACENT' });
    const alongWall = act(s, P1, move('hero-1', { x: 6, y: 12, level: 0 })).state;
    expect(applyAction(alongWall, P1, attack('hero-1', 'monster-2'))).toMatchObject({ ok: false, code: 'TARGET_NOT_ADJACENT' });

    const noAction = { ...doorwayBlocked(), turn: { ...doorwayBlocked().turn!, actionsLeft: 0 } };
    expect(applyAction(noAction, P1, attack('hero-1', 'monster-2'))).toMatchObject({ ok: false, code: 'NO_ACTION_LEFT' });
    expect(attackableMonsters(createView(noAction), P1)).toEqual([]);
  });

  it('wins once every area is revealed and every monster defeated', () => {
    const s = doorwayBlocked();
    const allAreas = PROTOTYPE_DUNGEON.areas.map((a) => a.id);
    const lastMonster = { ...s, revealedAreas: allAreas, monsters: s.monsters.filter((m) => m.id === 'monster-2') };
    expect(act(lastMonster, P1, attack('hero-1', 'monster-2')).events.map((e) => e.type)).toEqual(['MONSTER_DEFEATED', 'GAME_WON']);

    // Every monster beaten, but an area still undiscovered: not yet.
    const areaLeft = { ...lastMonster, revealedAreas: allAreas.filter((id) => id !== 'observatory') };
    const struck = act(areaLeft, P1, attack('hero-1', 'monster-2'));
    expect(struck.events.map((e) => e.type)).toEqual(['MONSTER_DEFEATED']);
    expect(struck.state.objectiveCompleted).toBe(false);
  });

  it('canStillAct counts a possible strike even without movement left', () => {
    const s = { ...doorwayBlocked(), turn: { ...doorwayBlocked().turn!, movementLeft: 0 } };
    // No movement left: only the strike at monster-2 remains.
    expect(canStillAct(createView(s), P1)).toBe(true);
    const struck = act(s, P1, attack('hero-1', 'monster-2')).state;
    expect(canStillAct(createView(struck), P1)).toBe(false);
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
    expect(restarted.state.restarts).toBe(1);
    expect(restarted.state.revealedAreas).toEqual(['hall']);
    expect(restarted.state.openDoors).toEqual([]);
    expect(restarted.state.players).toEqual(s.players);
    expect(restarted.state.heroes.map((h) => h.position)).toEqual([
      { x: 9, y: 1, level: 0 },
      { x: 10, y: 1, level: 0 },
    ]);
  });

  it('resets the objective so a new round can be won again', () => {
    const won = playOpening(7);
    expect(won.objectiveCompleted).toBe(true);
    const restarted = act(won, P2, { type: 'RESTART_GAME' }).state;
    expect(restarted.objectiveCompleted).toBe(false);
    expect(restarted.exploredStairs).toEqual([]);
    expect(createView(restarted).objective).toMatchObject({ revealedAreas: 1, completed: false });

    expect(restarted.visitedAreas).toEqual(['hall']);
    expect(playOpening(7, restarted).objectiveCompleted).toBe(true);
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
    s = act(s, P1, move('hero-1', { x: 9, y: 6, level: 0 })).state;
    s = act(s, P1, open('hero-1', 'door-1')).state;
    const view = createView(s);
    expect(view.doors.map((d) => [d.id, d.open])).toEqual([
      ['door-1', true],
      ['door-2', false],
      ['door-3', false],
    ]);
    expect(view.monsters).toEqual([]);
    expect(view.objective).toMatchObject({ revealedAreas: 2, totalAreas: 6, completed: false });
  });

  it('shows stairs touching a revealed area, but nothing of the level beyond', () => {
    expect(createView(startedGame()).stairs).toEqual([]);
    const view = createView(playOpening(4));
    expect(view.stairs).toEqual([
      { id: 'stairs-1', name: 'Turmtreppe', bottom: { x: 18, y: 16, level: 0 }, direction: 'N', style: 'stone', top: { x: 18, y: 14, level: 1 }, explored: false },
      { id: 'stairs-2', name: 'Gruftstiege', bottom: { x: 8, y: 19, level: -1 }, direction: 'N', style: 'ladder', top: { x: 8, y: 17, level: 0 }, explored: false },
    ]);
    expect(view.areas.every((a) => a.level === 0)).toBe(true);
    const serialized = JSON.stringify(view);
    for (const secret of ['observatory', 'Sternwarte', 'ossuary', 'Gebeinkammer', 'monster-4', 'monster-5']) {
      expect(serialized).not.toContain(secret);
    }
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
    expect(applyAction(s, P2, move('hero-2', { x: 16, y: 17, level: 0 }))).toMatchObject({ ok: false, code: 'INVALID_TARGET' });
  });
});

describe('UI hints', () => {
  it('canStillAct turns false once nothing is possible', () => {
    let s = startedGame();
    expect(canStillAct(createView(s), P1)).toBe(true);
    expect(canStillAct(createView(s), P2)).toBe(false);
    s = act(s, P1, move('hero-1', { x: 9, y: 6, level: 0 })).state;
    expect(openableDoors(createView(s), P1).map((d) => d.id)).toEqual(['door-1']);
    s = act(s, P1, open('hero-1', 'door-1')).state;
    s = act(s, P1, move('hero-1', { x: 9, y: 9, level: 0 })).state;
    expect(canStillAct(createView(s), P1)).toBe(false);
  });

  it('canStillAct stays true with no movement left while a door can still be opened', () => {
    let s = startedGame();
    s = act(s, P1, move('hero-1', { x: 9, y: 6, level: 0 })).state;
    s = act(s, P1, move('hero-1', { x: 9, y: 5, level: 0 })).state;
    s = act(s, P1, move('hero-1', { x: 10, y: 5, level: 0 })).state;
    s = act(s, P1, move('hero-1', { x: 10, y: 6, level: 0 })).state;
    expect(s.turn).toMatchObject({ movementLeft: 0, actionsLeft: 1 });
    expect(canStillAct(createView(s), P1)).toBe(true);
    s = act(s, P1, open('hero-1', 'door-1')).state;
    expect(canStillAct(createView(s), P1)).toBe(false);
  });

  it('offers unexplored stairs to a hero standing at either end', () => {
    let s = playOpening(5);
    expect(explorableStairs(createView(s), P2)).toEqual([]);
    s = act(s, P2, move('hero-2', { x: 18, y: 16, level: 0 })).state;
    expect(s.turn?.movementLeft).toBe(1);
    expect(explorableStairs(createView(s), P2).map((st) => st.id)).toEqual(['stairs-1']);
    s = act(s, P2, move('hero-2', { x: 18, y: 17, level: 0 })).state;
    expect(canStillAct(createView(s), P2)).toBe(false);
  });
});
