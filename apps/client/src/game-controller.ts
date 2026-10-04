import { Color4, Matrix, Vector3 } from '@babylonjs/core';
import {
  Board,
  attackableMonsters,
  canStillAct,
  computeReachable,
  explorableStairs,
  findPath,
  openableDoors,
  stairsEnds,
  type ReachableTile,
} from '@dungeon/game-core';
import {
  posKey,
  samePos,
  type CharacterId,
  type ClientMessage,
  type DoorId,
  type GameEvent,
  type GameView,
  type PlayerId,
  type Position,
  type ServerMessage,
  type StairsId,
  type StairsView,
} from '@dungeon/shared';
import type { Music } from './audio/music.ts';
import { Connection, sessionStore, type ConnectionStatus, type StoredSession } from './net/connection.ts';
import { reloadIfPending } from './pwa/update.ts';
import type { AssetLibrary } from './scene/assets.ts';
import type { BoardOverlay } from './scene/board-overlay.ts';
import { CharacterView, HERO_COLORS, type CharacterSpec } from './scene/characters.ts';
import type { DungeonView } from './scene/dungeon-view.ts';
import type { Effects } from './scene/effects.ts';
import { CELL, LEVEL_HEIGHT, levelY, tileCenter, worldToTile } from './scene/grid.ts';
import { wait } from './scene/tween.ts';
import type { World } from './scene/world.ts';
import type { Hud } from './ui/hud.ts';
import type { LobbyUI } from './ui/lobby.ts';

const REASON_TEXT: Record<string, string> = {
  INVALID_TARGET: 'Hier kann man nicht stehen',
  TARGET_OCCUPIED: 'Feld ist belegt',
  UNREACHABLE: 'Kein Weg dorthin',
  NOT_ENOUGH_MOVEMENT: 'Zu weit für diesen Zug',
};

export interface ControllerDeps {
  readonly world: World;
  readonly assets: AssetLibrary;
  readonly effects: Effects;
  readonly dungeon: DungeonView;
  readonly overlay: BoardOverlay;
  readonly hud: Hud;
  readonly lobby: LobbyUI;
  readonly labels: HTMLElement;
  readonly music: Music;
}

/** Movement (px) after which a press becomes a camera drag instead of a click or tap. */
const DRAG_THRESHOLD = { mouse: 6, touch: 10 };
/** How long the reason for a refused tap stays visible (touch has no hover). */
const TAP_HINT_MS = 1800;

/**
 * Client orchestration. The server is authoritative: this class only sends
 * requests, animates the events it receives and renders the resulting view.
 */
export class GameController {
  private readonly connection: Connection;
  private view: GameView | null = null;
  private session: StoredSession | null = null;
  private resuming = false;
  private joinRequest: { code: string; name: string } | null = null;
  private readonly characters = new Map<CharacterId, CharacterView>();
  private queue: Promise<void> = Promise.resolve();
  private queued = 0;
  private pending: string | null = null;
  private requestCounter = 0;
  private connected = false;
  private reachable = new Map<string, ReachableTile>();
  private openable = new Set<DoorId>();
  private explorable = new Set<StairsId>();
  /** Monsters the own hero can strike right now (M10). */
  private attackable = new Set<CharacterId>();
  /** Stairs whose omen (M8 presentation) has been played in this game ... */
  private readonly omensShown = new Set<StairsId>();
  /** ... identified by game ID and restart count, so a reconnect keeps them and a restart resets them. */
  private omensGame = '';
  private follow: CharacterView | null = null;
  private readonly keys = new Set<string>();
  private drag: { x: number; y: number; moved: boolean; button: number } | null = null;
  private lastPointer = { x: 0, y: 0 };
  /** Fingers on the canvas; two of them pinch (zoom) and pan together. */
  private readonly touches = new Map<number, { x: number; y: number }>();
  private pinch: { distance: number; x: number; y: number } | null = null;
  private touchInput = false;
  private tapHintTimer: number | undefined;
  /** Movement points shown while a hero's move is animated; null: as in the view. */
  private movementShown: number | null = null;
  /** Bumped when an update is done or abandoned (timeout), so its late animation callbacks do nothing. */
  private updateGeneration = 0;

  constructor(private readonly d: ControllerDeps) {
    this.connection = new Connection({
      onMessage: (m) => this.onServerMessage(m),
      onStatus: (s) => this.onConnectionStatus(s),
      onOpen: () => this.onOpen(),
    });
    this.bindInput();
    d.world.scene.onBeforeRenderObservable.add(() => this.onFrame());
    d.world.onLevelChanged.add((level) => {
      d.overlay.setFocusLevel(level);
      d.hud.minimap.setFocusLevel(level);
      d.hud.flashLevel(level);
      this.refreshInteraction();
    });
  }

  start(): void {
    const code = (new URLSearchParams(location.search).get('game') ?? '').toUpperCase();
    const stored = sessionStore.load();
    if (stored && (!code || code === stored.gameId)) {
      this.session = stored;
      this.resuming = true;
    } else {
      this.d.lobby.showStart(code);
    }
    this.connection.connect();
  }

  // ------------------------------------------------------------ lobby API

  createGame(name: string): void {
    this.joinRequest = null;
    this.send({ type: 'CREATE_GAME', playerName: name });
  }

  joinGame(code: string, name: string, takeOver: boolean): void {
    this.joinRequest = { code, name };
    this.send({ type: 'JOIN_GAME', gameId: code, playerName: name, ...(takeOver ? { takeOver: true } : {}) });
  }

  endTurn(): void {
    if (this.isMyTurn() && this.canInteract()) this.request({ type: 'END_TURN' });
  }

  /** Shows another storey (minimap buttons, Page Up/Down). */
  selectLevel(level: number): void {
    if (this.d.dungeon.knownLevels().includes(level)) this.d.world.setFocusLevel(level);
  }

  rotateView(step: 1 | -1): void {
    this.d.world.rotateView(step);
  }

  /** Camera on the own hero, on its storey. */
  focusHero(): void {
    const hero = this.characters.get(this.myHero()?.id ?? '');
    if (hero) this.focusCharacter(hero);
  }

  toggleGrid(): void {
    this.d.overlay.toggleGrid();
  }

  restart(): void {
    if (!this.connected) {
      this.d.hud.toast('Keine Verbindung zum Server.', 'error');
      return;
    }
    this.request({ type: 'RESTART_GAME' }, true);
  }

  /**
   * Start screen without a game: none joined, resumed, requested or still being
   * torn down (leaveGame clears the view only in its queued job). An app update
   * may reload the page now.
   */
  isIdle(): boolean {
    return this.session === null && !this.resuming && this.view === null && !this.d.lobby.isBusy();
  }

  // ------------------------------------------------------------ networking

  private send(message: ClientMessage): void {
    this.connection.send(message);
  }

  /** Sends a game action; `force` skips the turn/queue checks but never the connection check. */
  private request(message: ClientMessage, force = false): void {
    if (!this.connected || (!force && !this.canInteract())) return;
    const requestId = `r${++this.requestCounter}`;
    this.pending = requestId;
    this.clearInteraction();
    this.send({ ...message, requestId } as ClientMessage);
  }

  private onOpen(): void {
    if (!this.session) return;
    // Also after a reconnect: the game may have been discarded meanwhile (M9).
    this.resuming = true;
    this.send({ type: 'RESUME_SESSION', gameId: this.session.gameId, playerToken: this.session.playerToken });
  }

  private onConnectionStatus(status: ConnectionStatus): void {
    this.connected = status === 'open';
    const text: Record<ConnectionStatus, string | null> = {
      connecting: null,
      open: null,
      reconnecting: 'Verbindung verloren – verbinde neu …',
      replaced: 'Dieses Spiel wurde in einem anderen Tab geöffnet.',
      closed: 'Verbindung beendet.',
    };
    this.d.hud.setConnection(text[status]);
    if (!this.connected) this.pending = null;
    this.refreshInteraction();
  }

  private onServerMessage(message: ServerMessage): void {
    switch (message.type) {
      case 'SESSION': {
        this.session = { gameId: message.gameId, playerId: message.playerId, playerToken: message.playerToken };
        sessionStore.save(this.session);
        const url = new URL(location.href);
        url.searchParams.set('game', message.gameId);
        history.replaceState(null, '', url);
        break;
      }
      case 'GAME_STATE':
        this.resuming = false;
        this.enqueue(async () => {
          await this.rebuild(message.view);
          this.showPhase(message.view);
        });
        break;
      case 'GAME_UPDATE':
        // Only the answer to our own open request releases the input lock (M9).
        if (message.requestId !== undefined && message.requestId === this.pending) this.pending = null;
        this.enqueue(() => this.playUpdate(message.events, message.view));
        break;
      case 'ACTION_REJECTED':
        if (message.requestId === undefined || message.requestId === this.pending) this.pending = null;
        this.d.hud.toast(message.message, 'error');
        this.refreshInteraction();
        break;
      case 'ERROR':
        this.pending = null;
        this.onSessionError(message);
        break;
    }
  }

  private onSessionError(message: Extract<ServerMessage, { type: 'ERROR' }>): void {
    const sessionLost =
      (this.resuming && (message.code === 'GAME_NOT_FOUND' || message.code === 'INVALID_SESSION')) ||
      (this.view !== null && message.code === 'NO_SESSION');
    if (sessionLost) {
      this.leaveGame(message.code === 'GAME_NOT_FOUND' ? 'Das Spiel existiert nicht mehr.' : message.message);
      return;
    }
    if (!this.view) {
      if (message.code === 'GAME_FULL' && message.canTakeOver && this.joinRequest) {
        this.d.lobby.offerTakeOver(this.joinRequest.code, this.joinRequest.name, `${message.message} Möchtest du ihn übernehmen?`);
      } else {
        this.d.lobby.showError(message.message);
      }
      return;
    }
    this.d.hud.toast(message.message, 'error');
  }

  /** Back to the lobby with a clean scene, e.g. when the server discarded the game. */
  private leaveGame(reason: string): void {
    this.resuming = false;
    this.session = null;
    sessionStore.clear();
    const url = new URL(location.href);
    url.searchParams.delete('game');
    history.replaceState(null, '', url);
    this.enqueue(async () => {
      this.view = null;
      this.d.dungeon.clear();
      this.d.overlay.clear();
      for (const c of this.characters.values()) c.dispose();
      this.characters.clear();
      this.d.hud.closeOverlay();
      this.d.hud.hide();
      this.d.lobby.showStart('', reason);
      reloadIfPending();
    });
  }

  // ------------------------------------------------------------ state & animation

  private enqueue(job: () => Promise<void>): void {
    this.queued++;
    this.refreshInteraction();
    this.queue = this.queue
      .then(job)
      .catch((err) => console.error('update failed', err))
      .finally(() => {
        this.queued--;
        this.refreshInteraction();
      });
  }

  private showPhase(view: GameView): void {
    if (view.phase === 'waiting') {
      const link = `${location.origin}${location.pathname}?game=${view.gameId}`;
      this.d.lobby.showWaiting(view.gameId, link);
      this.d.hud.hide();
    } else {
      this.d.lobby.hide();
      this.d.hud.show();
    }
  }

  /** Snapshot: rebuild everything instantly, no discovery animation (M9). */
  private async rebuild(view: GameView): Promise<void> {
    // A snapshot may belong to a restarted game (e.g. restarted while disconnected).
    if (`${view.gameId}#${view.restarts}` !== this.omensGame) {
      this.omensShown.clear();
      this.omensGame = `${view.gameId}#${view.restarts}`;
    }
    this.d.dungeon.clear();
    this.d.overlay.clear();
    for (const c of this.characters.values()) c.dispose();
    this.characters.clear();
    this.follow = null;
    const mine = this.myHero(view);
    this.d.world.setFocusLevel(mine?.position.level ?? 0);
    for (const area of view.areas) {
      await this.d.dungeon.addArea(area, view);
      this.d.overlay.addGridTiles(area.tiles);
    }
    this.d.dungeon.ensureDoors(view);
    this.d.dungeon.ensureStairs(view);
    this.syncCharacters(view);
    this.d.world.focus(mine ? tileCenter(mine.position) : this.d.dungeon.areaCenter(view.areas[0]?.id ?? '') ?? Vector3.Zero(), true);
    this.applyView(view);
  }

  /**
   * Animates an update and then applies its view. The view is applied even if an
   * animation fails or hangs, so a client can never get stuck on an old turn (M9).
   */
  private async playUpdate(events: readonly GameEvent[], view: GameView): Promise<void> {
    const generation = this.updateGeneration;
    try {
      await withTimeout(this.animateAll(events, view, generation), animationBudget(events));
      this.syncCharacters(view);
    } catch (err) {
      console.error('animation failed, falling back to snapshot', err);
      // Abandon the running animations: they stop at their next event.
      this.updateGeneration++;
      await this.rebuild(view);
    } finally {
      this.updateGeneration++;
      this.movementShown = null;
      this.showPhase(view);
      this.applyView(view);
    }
  }

  private async animateAll(events: readonly GameEvent[], view: GameView, generation: number): Promise<void> {
    for (const [i, event] of events.entries()) {
      if (generation !== this.updateGeneration) return;
      if (event.type === 'GAME_RESTARTED') {
        await this.rebuild(view);
        this.d.hud.closeOverlay();
        this.d.hud.toast(`${this.playerName(view, event.byPlayerId)} hat ein neues Spiel gestartet.`);
        this.d.hud.log('Neues Spiel gestartet.');
        continue;
      }
      await this.animate(event, view, events.slice(i + 1));
    }
  }

  /** `later`: the remaining events of the same update (e.g. the step that follows exploring stairs). */
  private async animate(event: GameEvent, view: GameView, later: readonly GameEvent[]): Promise<void> {
    const { world, dungeon, hud, effects } = this.d;
    switch (event.type) {
      case 'PLAYER_JOINED': {
        const name = this.playerName(view, event.playerId);
        if (event.playerId !== this.session?.playerId) hud.toast(`${name} ist beigetreten.`);
        hud.log(`${name} ist beigetreten.`);
        const player = view.players.find((p) => p.id === event.playerId);
        const hero = view.heroes.find((h) => h.id === player?.heroId);
        if (hero && !this.characters.has(hero.id)) {
          this.ensureCharacter({ ...hero, monster: false });
          effects.burst(tileCenter(hero.position, 0.5), rgb(1, 0.85, 0.4), rgb(0.7, 0.5, 1));
        }
        break;
      }
      case 'GAME_STARTED':
        this.showPhase(view);
        hud.banner('Das Abenteuer beginnt!', 'Erkundet gemeinsam das Gewölbe der Laternen.', 2600);
        await wait(world.scene, 900);
        break;
      case 'PLAYER_CONNECTION': {
        const name = this.playerName(view, event.playerId);
        const text = event.connected ? `${name} ist wieder da.` : `${name} hat die Verbindung verloren.`;
        if (event.playerId !== this.session?.playerId) hud.toast(text, event.connected ? 'info' : 'error');
        hud.log(text);
        break;
      }
      case 'CHARACTER_MOVED': {
        const character = this.characters.get(event.characterId);
        if (!character) break;
        const from = character.tile;
        this.follow = character;
        const styleBetween = (a: Position, b: Position) =>
          view.stairs.find((s) => stairsEnds(s).every((end) => samePos(end, a) || samePos(end, b)))?.style ?? 'stone';
        // The active hero's movement points drain step by step (1 BP each) while it walks.
        // The view already holds the budget after this update, so count back from there.
        const activeHero = view.players.find((p) => p.id === view.turn?.activePlayerId)?.heroId;
        const sameTurn = !later.some((e) => e.type === 'TURN_STARTED' || e.type === 'GAME_RESTARTED');
        const laterSteps = later.reduce((n, e) => n + (e.type === 'CHARACTER_MOVED' && e.characterId === event.characterId ? e.path.length : 0), 0);
        const generation = this.updateGeneration;
        const onStep =
          view.turn && sameTurn && event.characterId === activeHero
            ? (begun: number) => {
                if (generation !== this.updateGeneration) return;
                this.movementShown = view.turn!.movementLeft + laterSteps + event.path.length - begun;
                hud.setMovementLeft(this.movementShown);
              }
            : undefined;
        await character.walk(event.path, styleBetween, onStep);
        if (this.follow === character) this.follow = null;
        // Abandoned update (timeout): the snapshot has taken over the camera and figures.
        if (generation !== this.updateGeneration) break;
        // The last step may have changed the storey without a frame in between.
        world.setFocusLevel(character.tile.level);
        await this.playOmens(character, from, event.path, view);
        break;
      }
      case 'DOOR_OPENED': {
        const hero = this.characters.get(event.characterId);
        const door = view.doors.find((d) => d.id === event.doorId);
        if (door) {
          world.focus(dungeon.doorCenter(door));
          hud.log(`${hero?.spec.name ?? 'Jemand'} öffnet die ${door.name}.`);
        }
        const heroView = view.heroes.find((h) => h.id === event.characterId);
        if (hero && heroView) {
          await hero.turnTo(heroView.facing);
          void hero.interact();
          await wait(world.scene, 450);
        }
        await dungeon.setDoorOpen(event.doorId, true);
        break;
      }
      case 'STAIRS_EXPLORED': {
        const hero = this.characters.get(event.characterId);
        const stairs = view.stairs.find((s) => s.id === event.stairsId);
        if (stairs) {
          world.focus(dungeon.stairsCenter(stairs));
          // The animated figure still stands where it explored from (the view already has it moved on).
          const from = hero?.tile ?? stairs.bottom;
          const farEnd = stairsEnds(stairs).find((p) => !samePos(p, from))!;
          const area = view.areas.find((a) => a.tiles.some((t) => samePos(t, farEnd)));
          const climbs = later.some((e) => e.type === 'CHARACTER_MOVED' && e.characterId === event.characterId);
          const goes = farEnd.level > stairs.bottom.level ? 'steigt hinauf' : 'steigt hinab';
          hud.log(`${stairs.name} erkundet: ${area?.name ?? 'ein neuer Bereich'} ist aufgedeckt. ${hero?.spec.name ?? 'Der Held'} ${climbs ? goes : 'bleibt stehen'}.`);
        }
        const heroView = view.heroes.find((h) => h.id === event.characterId);
        if (hero && heroView) {
          await hero.turnTo(heroView.facing);
          void hero.interact();
          await wait(world.scene, 450);
        }
        await dungeon.setStairsExplored(event.stairsId, true);
        break;
      }
      case 'AREA_REVEALED':
        // When the hero walks over right after (stairs), the camera stays on the new level.
        await this.revealArea(event, view, later.some((e) => e.type === 'CHARACTER_MOVED'));
        break;
      case 'MONSTER_DEFEATED': {
        const hero = this.characters.get(event.characterId);
        const monster = this.characters.get(event.monsterId);
        hud.log(`${hero?.spec.name ?? 'Ein Held'} besiegt ${monster?.spec.name ?? 'einen Gegner'}.`);
        if (monster) world.focus(monster.root.position);
        const heroView = view.heroes.find((h) => h.id === event.characterId);
        if (hero && heroView) await hero.turnTo(heroView.facing);
        const swing = hero?.strike();
        // The monster falls as the blow lands.
        await wait(world.scene, 380);
        if (monster) {
          await monster.die();
          // Only while still in the cast: after an abandoned update a snapshot has rebuilt (and disposed) it.
          if (this.characters.get(event.monsterId) === monster) {
            monster.dispose();
            this.characters.delete(event.monsterId);
          }
        }
        await swing;
        break;
      }
      case 'MONSTER_PHASE':
        hud.banner('Die Gegner ziehen', `Ende von Runde ${event.round}`, 1600);
        hud.log('Die Gegner ziehen.');
        await wait(world.scene, 700);
        break;
      case 'TURN_STARTED': {
        const player = view.players.find((p) => p.id === event.playerId);
        const hero = this.characters.get(player?.heroId ?? '');
        const mine = event.playerId === this.session?.playerId;
        hud.banner(mine ? 'Du bist am Zug!' : `${hero?.spec.name ?? player?.name} ist am Zug`, `Runde ${event.round}`, 1800);
        hud.log(`Runde ${event.round}: ${player?.name ?? '?'} ist am Zug.`);
        if (hero) this.focusCharacter(hero);
        break;
      }
      case 'GAME_WON':
        await wait(world.scene, 700);
        for (const c of this.characters.values()) if (!c.spec.monster) c.cheer();
        for (const c of this.characters.values()) {
          if (!c.spec.monster) effects.burst(c.root.position.add(new Vector3(0, 3, 0)), rgb(1, 0.9, 0.4), rgb(1, 0.5, 0.8), 120, 7, 0.5);
        }
        hud.log(view.objective.type === 'clearDungeon' ? 'Das Gewölbe ist erkundet und von allen Gegnern befreit!' : 'Das Gewölbe ist vollständig erkundet!');
        await wait(world.scene, 900);
        hud.showVictory(view.objective);
        break;
      case 'GAME_RESTARTED':
        break;
    }
  }

  /**
   * Omen (presentation only): the first time a hero walks into the area at the known
   * end of unexplored stairs, the camera glances at them and their omen swells.
   */
  private async playOmens(character: CharacterView, from: Position, path: readonly Position[], view: GameView): Promise<void> {
    if (character.spec.monster) return;
    const areaOf = (p: Position) => view.areas.find((a) => a.tiles.some((t) => samePos(t, p)))?.id;
    for (const stairs of view.stairs) {
      if (stairs.explored || this.omensShown.has(stairs.id)) continue;
      const fromAbove = view.areas.some((a) => a.tiles.some((t) => samePos(t, stairs.top)));
      const knownArea = areaOf(fromAbove ? stairs.top : stairs.bottom);
      if (!knownArea || areaOf(from) === knownArea || !path.some((p) => areaOf(p) === knownArea)) continue;
      this.omensShown.add(stairs.id);
      const { world, dungeon, hud } = this.d;
      world.focus(dungeon.stairsCenter(stairs));
      dungeon.swellOmen(stairs.id);
      if (fromAbove) {
        hud.banner(stairs.name, 'Kalter Hauch aus der Tiefe', 2200);
        hud.log(`Ein kalter, graublauer Hauch steigt aus der ${stairs.name}.`);
      } else {
        hud.banner(stairs.name, 'Sternenfunken von oben', 2200);
        hud.log(`Leuchtende Sternenfunken fallen die ${stairs.name} herab.`);
      }
      await wait(world.scene, 1600);
      world.focus(character.root.position);
    }
  }

  private async revealArea(event: Extract<GameEvent, { type: 'AREA_REVEALED' }>, view: GameView, stayOnLevel: boolean): Promise<void> {
    const { world, dungeon, hud, overlay } = this.d;
    const area = view.areas.find((a) => a.id === event.areaId);
    if (!area) return;
    const inArea = new Set(area.tiles.map(posKey));
    const via = event.via;
    const door = via.kind === 'door' ? view.doors.find((d) => d.id === via.id) : undefined;
    const stairs = via.kind === 'stairs' ? view.stairs.find((s) => s.id === via.id) : undefined;
    const passageTiles = door ? door.edges.flat() : stairs ? stairsEnds(stairs) : [];
    const origin = passageTiles.find((p) => inArea.has(posKey(p))) ?? area.tiles[0]!;
    const previousLevel = world.focusLevel;
    world.setFocusLevel(area.level);
    world.focus(Vector3.Lerp(tileCenter(origin), this.centerOf(area.tiles), 0.6));
    await dungeon.addArea(area, view, origin);
    overlay.addGridTiles(area.tiles);

    const monsters = event.monsterIds
      .map((id) => view.monsters.find((m) => m.id === id))
      .filter((m): m is NonNullable<typeof m> => !!m);
    const names = monsters.map((m) => m.name);
    hud.banner(
      `${area.name} entdeckt!`,
      names.length === 0 ? 'Der Weg ist frei.' : `${names.join(' und ')} ${names.length > 1 ? 'erwachen' : 'erwacht'}!`,
      2800,
    );
    hud.log(`${area.name} entdeckt${names.length ? ` – ${names.join(', ')}` : ''}.`);
    const awakenings = monsters.map(async (m, i) => {
      const c = this.ensureCharacter({ ...m, monster: true });
      c.sleep();
      await wait(world.scene, 250 + i * 450);
      await c.awaken();
    });
    await Promise.all(awakenings);
    // A storey discovered over stairs: back to the hero who explored it, unless it follows.
    if (area.level !== previousLevel && !stayOnLevel) {
      await wait(world.scene, 700);
      world.setFocusLevel(previousLevel);
    }
  }

  private syncCharacters(view: GameView): void {
    const alive = new Set<CharacterId>();
    for (const h of view.heroes) {
      alive.add(h.id);
      const c = this.ensureCharacter({ ...h, monster: false });
      if (!c.moving && !samePos(c.tile, h.position)) c.place(h.position, h.facing);
    }
    for (const m of view.monsters) {
      alive.add(m.id);
      this.ensureCharacter({ ...m, monster: true });
    }
    for (const [id, c] of this.characters) {
      if (!alive.has(id)) {
        c.dispose();
        this.characters.delete(id);
      }
    }
  }

  private ensureCharacter(spec: CharacterSpec): CharacterView {
    let c = this.characters.get(spec.id);
    if (!c) {
      c = new CharacterView(this.d.world, this.d.assets, this.d.effects, spec, this.d.labels);
      this.characters.set(spec.id, c);
    }
    return c;
  }

  private applyView(view: GameView): void {
    this.view = view;
    const activePlayer = view.players.find((p) => p.id === view.turn?.activePlayerId);
    for (const c of this.characters.values()) c.setActive(!c.spec.monster && c.spec.id === activePlayer?.heroId);
    this.refreshInteraction();
  }

  // ------------------------------------------------------------ interaction

  private isMyTurn(): boolean {
    return !!this.view && this.view.phase === 'playing' && this.view.turn?.activePlayerId === this.session?.playerId;
  }

  private canInteract(): boolean {
    return this.connected && this.queued === 0 && this.pending === null && this.isMyTurn();
  }

  private myHero(view: GameView | null = this.view) {
    const me = view?.players.find((p) => p.id === this.session?.playerId);
    return view?.heroes.find((h) => h.id === me?.heroId);
  }

  private clearInteraction(): void {
    this.reachable = new Map();
    this.openable = new Set();
    this.explorable = new Set();
    this.setAttackable(new Set());
    this.d.overlay.setReachable([]);
    this.d.overlay.setPath([]);
    this.d.overlay.setHover(null, false);
    this.d.dungeon.setOpenableDoors(this.openable);
    this.d.dungeon.setExplorableStairs(this.explorable);
    this.d.hud.tooltipAt(null);
  }

  private setAttackable(ids: Set<CharacterId>): void {
    this.attackable = ids;
    for (const c of this.characters.values()) if (c.spec.monster) c.setTargetable(ids.has(c.spec.id));
  }

  private refreshInteraction(): void {
    const view = this.view;
    if (!view) return;
    const you = this.session?.playerId ?? '';
    this.d.hud.update(view, you, {
      busy: this.queued > 0 || this.pending !== null,
      canStillAct: canStillAct(view, you),
      connected: this.connected,
      movementLeft: this.movementShown,
    });
    if (!this.canInteract()) {
      this.clearInteraction();
      return;
    }
    const hero = this.myHero(view)!;
    this.reachable = computeReachable(new Board(view), hero.id, hero.position, view.turn!.movementLeft);
    this.openable = new Set(openableDoors(view, you).map((d) => d.id));
    this.explorable = new Set(explorableStairs(view, you).map((s) => s.id));
    this.setAttackable(new Set(attackableMonsters(view, you).map((m) => m.id)));
    const focus = this.d.world.focusLevel;
    this.d.overlay.setReachable([...this.reachable.values()].map((r) => r.position).filter((p) => p.level === focus));
    this.d.dungeon.setOpenableDoors(this.openable);
    this.d.dungeon.setExplorableStairs(this.explorable);
    // A finger is not hovering: no preview at the spot of the last tap.
    if (!this.touchInput) this.hover(this.lastPointer.x, this.lastPointer.y);
  }

  /**
   * Where clicking stairs leads: preferably through the flight to the other storey,
   * otherwise to its nearer end. Undefined if neither end is reachable this turn.
   */
  private stairsTarget(stairs: StairsView): ReachableTile | undefined {
    const hero = this.myHero();
    if (!hero) return undefined;
    const ends = stairsEnds(stairs).sort((a, b) => Number(a.level === hero.position.level) - Number(b.level === hero.position.level));
    return ends.map((p) => this.reachable.get(posKey(p))).find((r) => r !== undefined);
  }

  /**
   * Resolves what the pointer means. Door, stairs and figure pick volumes can cover
   * floor tiles next to them, so priority is: openable door › explorable stairs ›
   * attackable monster › reachable tile › other. Tiles are picked on the floor of the focus level.
   */
  private pickAt(x: number, y: number): { door?: DoorId; stairs?: StairsId; character?: CharacterId; tile?: Position } {
    const { scene, camera, focusLevel } = this.d.world;
    let tile: Position | undefined;
    const ray = scene.createPickingRay(x, y, Matrix.Identity(), camera);
    if (ray.direction.y < -1e-4) {
      const t = (levelY(focusLevel) - ray.origin.y) / ray.direction.y;
      tile = worldToTile(ray.origin.add(ray.direction.scale(t)), focusLevel);
    }
    const hit = scene.pick(x, y, (m) => m.isPickable && m.isEnabled() && m.metadata?.pick === true);
    const door = this.d.dungeon.doorFromMesh(hit?.pickedMesh);
    const stairs = this.d.dungeon.stairsFromMesh(hit?.pickedMesh);
    const character = hit?.pickedMesh?.metadata?.characterId as CharacterId | undefined;
    if (door && this.openable.has(door)) return { door };
    if (stairs && this.explorable.has(stairs)) return { stairs };
    if (character && this.attackable.has(character)) return { character, tile: this.characters.get(character)?.tile };
    if (tile && this.reachable.has(posKey(tile))) return { tile };
    if (door) return { door };
    if (stairs) return { stairs };
    if (character) return { character, tile: this.characters.get(character)?.tile };
    return { tile };
  }

  private hover(x: number, y: number): void {
    const { overlay, hud } = this.d;
    if (!this.canInteract() || !this.view) {
      overlay.setHover(null, false);
      overlay.setPath([]);
      hud.tooltipAt(null);
      return;
    }
    const target = this.pickAt(x, y);
    const view = this.view;
    if (target.door) {
      const door = view.doors.find((d) => d.id === target.door)!;
      overlay.setHover(null, false);
      overlay.setPath([]);
      if (this.openable.has(door.id)) hud.tooltipAt(`${door.name} öffnen (Aktion)`, x, y, 'good');
      else if ((view.turn?.actionsLeft ?? 0) <= 0) hud.tooltipAt('Keine Aktion mehr in diesem Zug', x, y, 'bad');
      else hud.tooltipAt('Stelle dich direkt vor die Tür', x, y, 'bad');
      return;
    }
    if (target.stairs) {
      const stairs = view.stairs.find((s) => s.id === target.stairs)!;
      overlay.setHover(null, false);
      if (this.explorable.has(stairs.id)) {
        const hero = this.myHero()!;
        const far = stairsEnds(stairs).find((p) => !samePos(p, hero.position))!;
        if ((view.turn?.movementLeft ?? 0) >= 1) {
          overlay.setPath([far], hero.position);
          const goes = far.level > hero.position.level ? 'steigt hinauf' : 'steigt hinab';
          hud.tooltipAt(`${stairs.name} erkunden · 1 Aktion + 1 BP – deckt den Bereich auf, dein Held ${goes}.`, x, y, 'good');
        } else {
          overlay.setPath([]);
          hud.tooltipAt(`${stairs.name} erkunden · 1 Aktion – deckt den Bereich auf; ohne Bewegungspunkt bleibt dein Held stehen.`, x, y, 'good');
        }
        return;
      }
      if (!stairs.explored) {
        overlay.setPath([]);
        if ((view.turn?.actionsLeft ?? 0) <= 0) hud.tooltipAt('Keine Aktion mehr in diesem Zug', x, y, 'bad');
        else hud.tooltipAt('Stelle dich direkt vor die Treppe', x, y, 'bad');
        return;
      }
      const hero = this.myHero()!;
      const reach = this.stairsTarget(stairs);
      overlay.setPath(reach?.path ?? [], hero.position);
      if (!reach) hud.tooltipAt('Zu weit für diesen Zug', x, y, 'bad');
      else {
        const climb = reach.position.level - hero.position.level;
        const text =
          climb > 0
            ? `Hinauf · ${reach.cost} BP – dein Held wechselt ins höhere Geschoss.`
            : climb < 0
              ? `Hinab · ${reach.cost} BP – dein Held wechselt ins tiefere Geschoss.`
              : `Zur ${stairs.name} · ${reach.cost} BP`;
        hud.tooltipAt(text, x, y, 'good');
      }
      return;
    }
    const monster = view.monsters.find((m) => m.id === target.character);
    if (monster) {
      const attackable = this.attackable.has(monster.id);
      overlay.setPath([]);
      overlay.setHover(monster.position, attackable);
      if (attackable) hud.tooltipAt(`${monster.name} angreifen (Aktion) – ein Schlag besiegt ihn`, x, y, 'good');
      else if ((view.turn?.actionsLeft ?? 0) <= 0) hud.tooltipAt('Keine Aktion mehr in diesem Zug', x, y, 'bad');
      else hud.tooltipAt(`Stelle dich direkt neben ${monster.name}`, x, y, 'bad');
      return;
    }
    const tile = target.tile;
    if (!tile || !new Board(view).hasTile(tile)) {
      overlay.setHover(null, false);
      overlay.setPath([]);
      hud.tooltipAt(null);
      return;
    }
    const reach = this.reachable.get(posKey(tile));
    if (reach) {
      overlay.setHover(tile, true);
      overlay.setPath(reach.path, this.myHero()!.position);
      hud.tooltipAt(`${reach.cost} ${reach.cost === 1 ? 'Feld' : 'Felder'}`, x, y, 'good');
      return;
    }
    overlay.setPath([]);
    const hero = this.myHero(view)!;
    if (samePos(tile, hero.position)) {
      overlay.setHover(null, false);
      hud.tooltipAt(`${hero.name} – noch ${view.turn!.movementLeft} Bewegung`, x, y);
      return;
    }
    const result = findPath(new Board(view), hero.id, hero.position, tile, view.turn!.movementLeft);
    overlay.setHover(tile, false);
    hud.tooltipAt(result.ok ? null : REASON_TEXT[result.reason] ?? 'Nicht möglich', x, y, 'bad');
  }

  /** Acts on what is under the pointer; false if there was nothing to do. */
  private click(x: number, y: number): boolean {
    if (!this.canInteract() || !this.view) return false;
    const target = this.pickAt(x, y);
    const hero = this.myHero()!;
    if (target.door) {
      if (!this.openable.has(target.door)) return false;
      this.request({ type: 'OPEN_DOOR', characterId: hero.id, doorId: target.door });
      return true;
    }
    if (target.stairs) {
      const stairs = this.view.stairs.find((s) => s.id === target.stairs)!;
      if (this.explorable.has(stairs.id)) {
        this.request({ type: 'EXPLORE_STAIRS', characterId: hero.id, stairsId: stairs.id });
        return true;
      }
      const reach = stairs.explored ? this.stairsTarget(stairs) : undefined;
      if (!reach) return false;
      this.request({ type: 'MOVE_CHARACTER', characterId: hero.id, target: reach.position });
      return true;
    }
    if (target.character && this.attackable.has(target.character)) {
      this.request({ type: 'ATTACK', characterId: hero.id, targetId: target.character });
      return true;
    }
    if (target.tile && this.reachable.has(posKey(target.tile))) {
      this.request({ type: 'MOVE_CHARACTER', characterId: hero.id, target: target.tile });
      return true;
    }
    if (target.character === hero.id) this.d.world.focus(tileCenter(hero.position));
    return false;
  }

  /** Touch has no hover: a tap acts at once; if it cannot, the hover text explains why for a moment. */
  private tap(x: number, y: number): void {
    window.clearTimeout(this.tapHintTimer);
    this.lastPointer = { x, y };
    if (this.click(x, y)) return;
    this.hover(x, y);
    this.tapHintTimer = window.setTimeout(() => {
      this.d.hud.tooltipAt(null);
      this.d.overlay.setHover(null, false);
      this.d.overlay.setPath([]);
    }, TAP_HINT_MS);
  }

  /** Distance and midpoint of the first two fingers. */
  private pinchState(): { distance: number; x: number; y: number } {
    const [a, b] = [...this.touches.values()] as [{ x: number; y: number }, { x: number; y: number }];
    return { distance: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)), x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  }

  private bindInput(): void {
    const canvas = this.d.world.canvas;
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    canvas.addEventListener('pointerdown', (e) => {
      this.touchInput = e.pointerType === 'touch';
      this.d.hud.touchInput = this.touchInput;
      canvas.setPointerCapture(e.pointerId);
      if (this.touchInput) {
        this.touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
        if (this.touches.size >= 2) {
          // A second finger turns the gesture into a pinch; no tap any more.
          this.drag = null;
          this.pinch = this.pinchState();
          this.d.hud.tooltipAt(null);
          return;
        }
      }
      this.drag = { x: e.clientX, y: e.clientY, moved: false, button: e.button };
    });
    canvas.addEventListener('pointermove', (e) => {
      const finger = this.touches.get(e.pointerId);
      if (finger) {
        finger.x = e.clientX;
        finger.y = e.clientY;
        if (this.pinch && this.touches.size >= 2) {
          const next = this.pinchState();
          this.d.world.zoom(this.pinch.distance / next.distance - 1);
          this.d.world.pan(next.x - this.pinch.x, next.y - this.pinch.y);
          this.pinch = next;
          return;
        }
      } else {
        this.lastPointer = { x: e.clientX, y: e.clientY };
      }
      if (this.drag) {
        const dx = e.clientX - this.drag.x;
        const dy = e.clientY - this.drag.y;
        if (!this.drag.moved && Math.hypot(dx, dy) > (finger ? DRAG_THRESHOLD.touch : DRAG_THRESHOLD.mouse)) this.drag.moved = true;
        if (this.drag.moved) {
          this.d.world.pan(dx, dy);
          this.drag.x = e.clientX;
          this.drag.y = e.clientY;
          this.d.hud.tooltipAt(null);
          return;
        }
      }
      if (!finger) this.hover(e.clientX, e.clientY);
    });
    const release = (e: PointerEvent, cancelled: boolean) => {
      if (this.touches.delete(e.pointerId) && this.pinch) {
        if (this.touches.size >= 2) {
          // Still two fingers down: pinch on with them.
          this.pinch = this.pinchState();
        } else {
          // The finger still down pans on, without jumping and without tapping.
          this.pinch = null;
          const [rest] = [...this.touches.values()];
          if (rest) this.drag = { x: rest.x, y: rest.y, moved: true, button: 0 };
        }
        return;
      }
      const drag = this.drag;
      this.drag = null;
      if (cancelled || !drag || drag.moved || drag.button !== 0) return;
      if (e.pointerType === 'touch') this.tap(e.clientX, e.clientY);
      else this.click(e.clientX, e.clientY);
    };
    canvas.addEventListener('pointerup', (e) => release(e, false));
    canvas.addEventListener('pointercancel', (e) => release(e, true));
    // A lifted finger also "leaves"; its tap hint must stay.
    canvas.addEventListener('pointerleave', (e) => e.pointerType !== 'touch' && this.d.hud.tooltipAt(null));
    canvas.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        this.d.world.zoom(Math.sign(e.deltaY) * 0.1);
      },
      { passive: false },
    );
    window.addEventListener('keydown', (e) => {
      // Never fire game hotkeys into dialogs, buttons or inputs (ending a turn is irreversible).
      if (e.repeat || document.querySelector('.overlay')) return;
      if (e.target instanceof HTMLElement && e.target.closest('button, input, textarea, [role=dialog]')) return;
      const key = e.key.toLowerCase();
      if (key === 'q') this.rotateView(-1);
      else if (key === 'e') this.rotateView(1);
      else if (key === 'g') this.toggleGrid();
      else if (key === 'f') this.focusHero();
      else if (key === 'm') this.d.music.toggle();
      else if (key === 'pageup' || key === 'pagedown') {
        e.preventDefault();
        const levels = this.d.dungeon.knownLevels();
        const index = levels.indexOf(this.d.world.focusLevel) + (key === 'pageup' ? 1 : -1);
        if (index >= 0 && index < levels.length) this.d.world.setFocusLevel(levels[index]!);
      } else if (key === ' ') {
        e.preventDefault();
        this.endTurn();
      } else this.keys.add(key);
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.key.toLowerCase()));
    window.addEventListener('blur', () => this.keys.clear());
  }

  private onFrame(): void {
    const { world } = this.d;
    const dt = world.engine.getDeltaTime() / 1000;
    const speed = 700 * dt;
    let dx = 0;
    let dy = 0;
    if (this.keys.has('a') || this.keys.has('arrowleft')) dx += speed;
    if (this.keys.has('d') || this.keys.has('arrowright')) dx -= speed;
    if (this.keys.has('w') || this.keys.has('arrowup')) dy += speed;
    if (this.keys.has('s') || this.keys.has('arrowdown')) dy -= speed;
    if (dx || dy) world.pan(dx, dy);
    if (this.follow) {
      // The camera follows a walking figure, also up and down stairs.
      world.setFocusLevel(this.follow.viewLevel);
      world.focus(this.follow.root.position);
    }
    if (this.view) world.clampTarget(this.view.width, this.view.height);
    this.d.hud.minimap.frame(
      world.camera.alpha,
      [...this.characters.values()].map((c) => ({
        x: c.root.position.x / CELL,
        y: c.root.position.z / CELL,
        level: c.root.position.y / LEVEL_HEIGHT,
        color: c.spec.monster ? '' : HERO_COLORS[c.spec.kind as keyof typeof HERO_COLORS],
        monster: c.spec.monster,
      })),
    );
  }

  /** Camera on a figure, on its storey. */
  private focusCharacter(character: CharacterView): void {
    this.d.world.setFocusLevel(character.tile.level);
    this.d.world.focus(character.root.position);
  }

  private playerName(view: GameView, id: PlayerId): string {
    return view.players.find((p) => p.id === id)?.name ?? 'Jemand';
  }

  private centerOf(tiles: readonly Position[]): Vector3 {
    const sum = new Vector3();
    for (const t of tiles) sum.addInPlace(tileCenter(t));
    return sum.scale(1 / Math.max(1, tiles.length));
  }
}

function rgb(r: number, g: number, b: number): Color4 {
  return new Color4(r, g, b, 1);
}

/** Upper bound for one update's animations (a reveal takes ~4 s). */
const ANIMATION_TIMEOUT_MS = 20_000;
/** Time allowed per step of a figure, a ladder climb included. */
const STEP_BUDGET_MS = 1_500;

/** Animation time an update may take: grows with the steps walked (e.g. many monsters in one phase). */
function animationBudget(events: readonly GameEvent[]): number {
  return events.reduce((ms, e) => ms + (e.type === 'CHARACTER_MOVED' ? e.path.length * STEP_BUDGET_MS : 0), ANIMATION_TIMEOUT_MS);
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error(`animation timeout after ${ms} ms`)), ms);
    promise.then(
      (value) => {
        window.clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        window.clearTimeout(timer);
        reject(err);
      },
    );
  });
}
