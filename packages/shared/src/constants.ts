// Per-turn budgets are map parameters (`DungeonDefinition.rules`, sent as `view.rules`).
export const PLAYERS_PER_GAME = 2;
export const MAX_PLAYER_NAME_LENGTH = 20;

export const WS_PATH = '/ws';
export const DEFAULT_SERVER_PORT = 8080;
/** Upper bound for a single client WebSocket frame. */
export const MAX_CLIENT_MESSAGE_BYTES = 4 * 1024;
