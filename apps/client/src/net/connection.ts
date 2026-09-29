import { WS_PATH, type ClientMessage, type ServerMessage } from '@dungeon/shared';

/** Close code used by the server when a newer tab took over this seat. */
const CLOSE_REPLACED = 4001;
const LOBBY_MESSAGES = new Set<ClientMessage['type']>(['CREATE_GAME', 'JOIN_GAME']);

export interface StoredSession {
  readonly gameId: string;
  readonly playerId: string;
  readonly playerToken: string;
}

const SESSION_KEY = 'dungeon.session';

/** Per-tab session storage (M9): two tabs of one browser can be two players. */
export const sessionStore = {
  load(): StoredSession | null {
    try {
      const raw = sessionStorage.getItem(SESSION_KEY);
      return raw ? (JSON.parse(raw) as StoredSession) : null;
    } catch {
      return null;
    }
  },
  save(session: StoredSession): void {
    try {
      sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
    } catch {
      /* storage unavailable: session just won't survive a reload */
    }
  },
  clear(): void {
    try {
      sessionStorage.removeItem(SESSION_KEY);
    } catch {
      /* ignore */
    }
  },
};

export type ConnectionStatus = 'connecting' | 'open' | 'reconnecting' | 'replaced' | 'closed';

export interface ConnectionHandlers {
  onMessage(message: ServerMessage): void;
  onStatus(status: ConnectionStatus): void;
  /** Called after every (re)connect so the app can resume its session. */
  onOpen(): void;
}

/** WebSocket wrapper with automatic reconnect and JSON framing. */
export class Connection {
  private socket: WebSocket | null = null;
  private retries = 0;
  private stopped = false;
  private readonly queue: ClientMessage[] = [];

  constructor(private readonly handlers: ConnectionHandlers) {}

  connect(): void {
    this.stopped = false;
    const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
    const socket = new WebSocket(`${protocol}://${location.host}${WS_PATH}`);
    this.socket = socket;
    this.handlers.onStatus(this.retries === 0 ? 'connecting' : 'reconnecting');

    socket.addEventListener('open', () => {
      this.retries = 0;
      this.handlers.onStatus('open');
      this.handlers.onOpen();
      for (const msg of this.queue.splice(0)) socket.send(JSON.stringify(msg));
    });
    socket.addEventListener('message', (event) => {
      try {
        this.handlers.onMessage(JSON.parse(String(event.data)) as ServerMessage);
      } catch (err) {
        console.error('bad server message', err);
      }
    });
    socket.addEventListener('close', (event) => {
      if (this.socket !== socket) return;
      this.socket = null;
      if (event.code === CLOSE_REPLACED) {
        this.stopped = true;
        this.handlers.onStatus('replaced');
        return;
      }
      if (this.stopped) {
        this.handlers.onStatus('closed');
        return;
      }
      this.retries++;
      this.handlers.onStatus('reconnecting');
      const delay = Math.min(5000, 400 * 2 ** Math.min(this.retries, 4));
      setTimeout(() => {
        if (!this.stopped) this.connect();
      }, delay);
    });
  }

  /**
   * Sends immediately when connected. While (re)connecting only lobby messages
   * are buffered; game actions are dropped so nothing fires minutes later.
   */
  send(message: ClientMessage): void {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(message));
    else if (LOBBY_MESSAGES.has(message.type)) this.queue.push(message);
  }
}
