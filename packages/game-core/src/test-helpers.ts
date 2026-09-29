import type { DungeonDefinition, GameAction, PlayerId } from '@dungeon/shared';
import { PROTOTYPE_DUNGEON } from './content/index.ts';
import { addPlayer, applyAction, createGame } from './game.ts';
import type { GameState } from './state.ts';

export const P1: PlayerId = 'player-1';
export const P2: PlayerId = 'player-2';

/** A started two-player game on the given dungeon (default: v0.1 prototype). */
export function startedGame(dungeon: DungeonDefinition = PROTOTYPE_DUNGEON): GameState {
  let state = createGame('TEST', dungeon);
  for (const [id, name] of [
    [P1, 'Ana'],
    [P2, 'Ben'],
  ] as const) {
    const joined = addPlayer(state, id, name);
    if (!joined.ok) throw new Error('join failed');
    state = joined.state;
  }
  return state;
}

/** Applies an action and throws if it is rejected. */
export function act(state: GameState, playerId: PlayerId, action: GameAction) {
  const result = applyAction(state, playerId, action);
  if (!result.ok) throw new Error(`${action.type} rejected: ${result.code}`);
  return result;
}
