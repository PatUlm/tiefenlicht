import type { GameView, ObjectiveView, PlayerId } from '@dungeon/shared';
import type { Music } from '../audio/music.ts';
import { HERO_COLORS } from '../scene/characters.ts';
import { button, el, iconButton } from './dom.ts';
import { Minimap, levelName } from './minimap.ts';
import { musicButton } from './music-button.ts';

export interface HudHandlers {
  onEndTurn(): void;
  onRestart(): void;
  onSelectLevel(level: number): void;
  onRotate(step: 1 | -1): void;
  onFocusHero(): void;
  onToggleGrid(): void;
}

/** Touch screens skip the control explanation in the turn bar (styles.css uses the same query for the touch layout). */
const coarsePointer = window.matchMedia('(pointer: coarse)');

export interface HudState {
  readonly busy: boolean;
  /** False once nothing useful is left this turn (M3 hint). */
  readonly canStillAct: boolean;
  readonly connected: boolean;
  /** Movement points while a move is animated (null: as in the view). */
  readonly movementLeft: number | null;
}

const HERO_ICON = { dwarf: '⚒', darkelf: '🗡' } as const;

/** HTML overlay: players, turn budget, objective, minimap, log, toasts and banners. */
export class Hud {
  readonly minimap: Minimap;
  private readonly root: HTMLDivElement;
  private readonly players: HTMLDivElement;
  private readonly codeChip: HTMLDivElement;
  private readonly menu: HTMLDivElement;
  private readonly menuButton: HTMLButtonElement;
  private readonly menuCode: HTMLDivElement;
  private readonly menuFps: HTMLDivElement;
  private readonly objectiveText: HTMLDivElement;
  private readonly progress: HTMLDivElement;
  private readonly turnBar: HTMLDivElement;
  private readonly turnWho: HTMLDivElement;
  private readonly turnHint: HTMLDivElement;
  private readonly movePips: HTMLDivElement;
  private readonly actionPips: HTMLDivElement;
  private readonly endTurn: HTMLButtonElement;
  private readonly logBox: HTMLDivElement;
  private readonly toasts: HTMLDivElement;
  private readonly bannerBox: HTMLDivElement;
  private readonly tooltip: HTMLDivElement;
  private readonly connection: HTMLDivElement;
  private readonly fps: HTMLDivElement;
  private readonly levelFlash: HTMLDivElement;
  private bannerTimer: number | undefined;
  private levelFlashTimer: number | undefined;
  private overlay: HTMLDivElement | null = null;
  /** Set by the controller per pointer: touch tooltips sit above the finger. */
  touchInput = false;

  constructor(
    parent: HTMLElement,
    private readonly handlers: HudHandlers,
    music: Music,
  ) {
    this.root = el('div', 'hud');
    this.root.style.display = 'none';
    parent.appendChild(this.root);

    const top = el('div', 'hud-top');
    const left = el('div', 'hud-left');
    const title = el('div', 'panel title-chip');
    const titleText = el('div');
    titleText.append(el('div', 'name', 'Tiefenlicht'), el('div', 'dungeon', 'Das Gewölbe der Laternen'));
    this.codeChip = el('div', 'code-chip');
    title.append(titleText, this.codeChip);
    this.players = el('div', 'panel players');
    left.append(title, this.players);

    const right = el('div', 'hud-right');
    const objective = el('div', 'panel objective');
    this.objectiveText = el('div', 'text');
    this.progress = el('div', 'progress');
    objective.append(el('div', 'label', 'Ziel'), this.objectiveText, this.progress);
    const restart = button('Neues Spiel', 'secondary small restart', () => void this.confirmRestart());
    // Small screens: title, code, grid, restart and FPS move into a menu (styles.css).
    this.menuButton = iconButton('☰', 'Menü', 'menu-button', () => this.toggleMenu());
    this.menu = el('div', 'panel hud-menu');
    this.menuCode = el('div', 'menu-code');
    this.menuFps = el('div', 'menu-fps');
    this.menu.append(
      el('div', 'menu-title', 'Tiefenlicht'),
      this.menuCode,
      button('Raster an/aus', 'secondary small', () => {
        this.toggleMenu(false);
        this.handlers.onToggleGrid();
      }),
      button('Neues Spiel', 'secondary small', () => {
        this.toggleMenu(false);
        this.confirmRestart();
      }),
      this.menuFps,
    );
    const actions = el('div', 'hud-actions');
    actions.append(restart, musicButton(music), this.menuButton, this.menu);
    this.fps = el('div', 'panel fps');
    this.minimap = new Minimap({ onSelectLevel: (level) => this.handlers.onSelectLevel(level) });
    right.append(objective, actions, this.minimap.root, this.fps);
    top.append(left, right);
    document.addEventListener('pointerdown', (e) => {
      if (this.menu.classList.contains('open') && !actions.contains(e.target as Node)) this.toggleMenu(false);
    });

    this.turnBar = el('div', 'panel turn-bar');
    const who = el('div');
    this.turnWho = el('div', 'who');
    this.turnHint = el('div', 'hint');
    who.append(this.turnWho, this.turnHint);
    const budget = el('div', 'budget');
    const moveRow = el('div', 'budget-row');
    this.movePips = el('div', 'budget-row');
    moveRow.append(el('span', 'caption', 'Bewegung'), this.movePips);
    const actionRow = el('div', 'budget-row');
    this.actionPips = el('div', 'budget-row');
    actionRow.append(el('span', 'caption', 'Aktion'), this.actionPips);
    budget.append(moveRow, actionRow);
    this.endTurn = button('Zug beenden', '', () => this.handlers.onEndTurn());
    this.turnBar.append(who, budget, this.endTurn);

    // Thumb controls for touch and small screens (keyboard shortcuts elsewhere).
    const camera = el('div', 'camera-controls');
    camera.append(
      iconButton('↺', 'Ansicht drehen (Q)', '', () => this.handlers.onRotate(-1)),
      iconButton('◎', 'Held fokussieren (F)', '', () => this.handlers.onFocusHero()),
      iconButton('↻', 'Ansicht drehen (E)', '', () => this.handlers.onRotate(1)),
    );
    const bottom = el('div', 'hud-bottom');
    bottom.append(camera, this.turnBar);
    // Toasts and the storey name sit above the bottom bar on small screens.
    new ResizeObserver(() => this.root.style.setProperty('--hud-bottom', `${bottom.offsetHeight}px`)).observe(bottom);

    this.logBox = el('div', 'panel log');
    const help = el('div', 'panel help');
    for (const [key, text] of [
      ['Klick', 'Laufen / Tür / Treppe / Angriff'],
      ['Ziehen', 'Kamera schwenken'],
      ['Rad', 'Zoomen'],
      ['Q E', 'Ansicht drehen'],
      ['Bild↑↓', 'Ebene wechseln'],
      ['F', 'Held fokussieren'],
      ['G', 'Raster an/aus'],
      ['M', 'Musik an/aus'],
      ['␣', 'Zug beenden'],
    ] as const) {
      const row = el('div');
      row.append(el('kbd', undefined, key), document.createTextNode(text));
      help.appendChild(row);
    }
    this.toasts = el('div', 'toasts');
    this.bannerBox = el('div', 'panel banner');
    this.tooltip = el('div', 'tooltip');
    this.tooltip.style.opacity = '0';
    this.connection = el('div', 'panel connection');
    this.connection.style.display = 'none';
    this.levelFlash = el('div', 'panel level-flash');

    this.root.append(top, this.levelFlash, bottom, this.logBox, help, this.toasts, this.bannerBox, this.tooltip, this.connection);
  }

  private toggleMenu(open = !this.menu.classList.contains('open')): void {
    this.menu.classList.toggle('open', open);
    this.menuButton.setAttribute('aria-expanded', String(open));
  }

  show(): void {
    this.root.style.display = '';
  }

  hide(): void {
    this.root.style.display = 'none';
  }

  /** Briefly names the storey the camera switched to. */
  flashLevel(level: number): void {
    this.levelFlash.textContent = levelName(level);
    this.levelFlash.classList.add('show');
    window.clearTimeout(this.levelFlashTimer);
    this.levelFlashTimer = window.setTimeout(() => this.levelFlash.classList.remove('show'), 1400);
  }

  /** Frame-rate readout (averaged by the engine), coloured by how smooth it is. */
  setFps(fps: number): void {
    const level = fps >= 50 ? 'good' : fps >= 30 ? 'ok' : 'bad';
    for (const node of [this.fps, this.menuFps]) {
      node.textContent = `${Math.round(fps)} FPS`;
      node.dataset['level'] = level;
    }
  }

  update(view: GameView, you: PlayerId, state: HudState): void {
    this.codeChip.replaceChildren(document.createTextNode('Code '), el('b', undefined, view.gameId));
    this.menuCode.replaceChildren(document.createTextNode('Spielcode '), el('b', undefined, view.gameId));

    const heroes = new Map(view.heroes.map((h) => [h.id, h]));
    const active = view.turn?.activePlayerId;
    this.players.replaceChildren(
      ...[...view.players]
        .sort((a, b) => a.slot - b.slot)
        .map((p) => {
          const hero = heroes.get(p.heroId);
          const row = el('div', `player${p.id === active ? ' active' : ''}${p.id === you ? ' you' : ''}`);
          row.style.setProperty('--player-color', hero ? HERO_COLORS[hero.kind] : '#888');
          const info = el('div', 'info');
          info.append(el('span', 'hero', hero?.name ?? '?'), el('span', 'who', `${p.name}${p.id === you ? ' (du)' : ''} · ${hero?.kind === 'dwarf' ? 'Zwerg' : 'Dunkelelf'}`));
          const status = !p.connected
            ? el('span', 'state offline', 'getrennt')
            : p.id === active
              ? el('span', 'state turn', 'am Zug')
              : el('span', 'state', 'wartet');
          row.append(el('div', 'dot', hero ? HERO_ICON[hero.kind] : '?'), info, status);
          return row;
        }),
    );

    this.minimap.update(
      view,
      view.heroes.map((h) => ({ level: h.position.level, color: HERO_COLORS[h.kind] })),
    );

    const o = view.objective;
    const visit = o.type === 'visitAllAreas';
    const clear = o.type === 'clearDungeon';
    // Visit objective: entered areas are full, discovered but not yet entered ones half lit.
    const done = visit ? o.visitedAreas : o.revealedAreas;
    // Goal and count separately: phones show only the count (styles.css).
    this.objectiveText.replaceChildren(
      el(
        'span',
        'goal',
        o.completed ? (clear ? 'Gewölbe befreit! ✨' : 'Gewölbe erkundet! ✨') : visit ? 'Alle Bereiche betreten' : clear ? 'Alles entdecken & besiegen' : 'Erkunde das Gewölbe',
      ),
      el('span', 'count', o.completed ? '' : `${done}/${o.totalAreas}`),
    );
    // Monsters: defeated of those met so far (hidden ones are not counted, M6).
    const metMonsters = o.defeatedMonsters + view.monsters.length;
    if (clear && !o.completed && metMonsters > 0) {
      const foes = el('span', 'foes', `⚔ ${o.defeatedMonsters}/${metMonsters}`);
      foes.title = 'Besiegte Gegner von den bisher entdeckten';
      this.objectiveText.append(foes);
    }
    this.progress.replaceChildren(
      ...Array.from({ length: o.totalAreas }, (_, i) => el('span', i < done ? 'done' : visit && i < o.revealedAreas ? 'seen' : '')),
    );

    const turn = view.turn;
    const mine = turn?.activePlayerId === you;
    const activePlayer = view.players.find((p) => p.id === turn?.activePlayerId);
    const activeHero = activePlayer ? heroes.get(activePlayer.heroId) : undefined;
    this.turnBar.classList.toggle('inactive', !mine);
    if (!turn) {
      this.turnWho.textContent = 'Warte auf Mitspieler …';
      this.turnHint.textContent = '';
    } else if (mine) {
      this.turnWho.textContent = `Runde ${turn.round} · Du bist am Zug`;
      this.turnHint.textContent = !state.connected
        ? 'Verbindung wird wiederhergestellt …'
        : state.canStillAct
          ? coarsePointer.matches
            ? ''
            : 'Klicke ein leuchtendes Feld zum Laufen. Steht dein Held an einer Tür, einer Treppe oder neben einem Gegner, klicke darauf.'
          : 'Nichts mehr zu tun – beende deinen Zug.';
    } else {
      this.turnWho.textContent = `Runde ${turn.round} · ${activeHero?.name ?? '…'} ist am Zug`;
      this.turnHint.textContent = activePlayer && !activePlayer.connected ? `${activePlayer.name} ist getrennt – das Spiel wartet.` : `${activePlayer?.name ?? ''} spielt gerade.`;
    }
    const max = view.rules.movementPerTurn;
    const left = state.movementLeft ?? turn?.movementLeft ?? 0;
    this.movePips.replaceChildren(...Array.from({ length: max }, (_, i) => el('span', `pip${i < left ? ' on' : ''}`)));
    this.actionPips.replaceChildren(
      ...Array.from({ length: view.rules.actionsPerTurn }, (_, i) => el('span', `pip action${i < (turn?.actionsLeft ?? 0) ? ' on' : ''}`)),
    );
    this.endTurn.style.display = mine ? '' : 'none';
    this.endTurn.disabled = state.busy || !state.connected;
    this.endTurn.classList.toggle('pulse', mine && !state.canStillAct && !state.busy);
  }

  /** Movement points during a move animation; switches the existing pips, so they fade out. */
  setMovementLeft(left: number): void {
    [...this.movePips.children].forEach((pip, i) => pip.classList.toggle('on', i < left));
  }

  log(text: string): void {
    this.logBox.appendChild(el('div', 'log-entry', text));
    while (this.logBox.children.length > 7) this.logBox.firstChild?.remove();
  }

  toast(text: string, kind: 'info' | 'error' = 'info', ms = 3200): void {
    const t = el('div', `panel toast${kind === 'error' ? ' error' : ''}`, text);
    this.toasts.appendChild(t);
    while (this.toasts.children.length > 3) this.toasts.firstChild?.remove();
    window.setTimeout(() => {
      t.style.opacity = '0';
      window.setTimeout(() => t.remove(), 450);
    }, ms);
  }

  banner(big: string, small = '', ms = 2200): void {
    this.bannerBox.replaceChildren(el('div', 'big', big), el('div', 'small', small));
    this.bannerBox.classList.add('show');
    window.clearTimeout(this.bannerTimer);
    this.bannerTimer = window.setTimeout(() => this.bannerBox.classList.remove('show'), ms);
  }

  tooltipAt(text: string | null, x = 0, y = 0, kind: 'good' | 'bad' | '' = ''): void {
    if (!text) {
      this.tooltip.style.opacity = '0';
      return;
    }
    this.tooltip.textContent = text;
    this.tooltip.className = `tooltip ${kind}`;
    this.tooltip.style.opacity = '1';
    // Beside the pointer. For a finger further out and raised, so neither the finger
    // nor the tapped tile and figure are covered. Always inside the screen.
    const width = this.tooltip.offsetWidth;
    const height = this.tooltip.offsetHeight;
    const margin = 8;
    const offset = this.touchInput ? 52 : 14;
    let left = x + offset;
    let top = this.touchInput ? y - height - 36 : y + 14;
    if (left + width > window.innerWidth - margin) left = x - width - offset;
    if (top < margin) top = y + 28;
    left = Math.max(margin, Math.min(window.innerWidth - width - margin, left));
    top = Math.max(margin, Math.min(window.innerHeight - height - margin, top));
    this.tooltip.style.left = `${left}px`;
    this.tooltip.style.top = `${top}px`;
  }

  setConnection(text: string | null): void {
    this.connection.style.display = text ? '' : 'none';
    this.connection.textContent = text ?? '';
  }

  showVictory(objective: ObjectiveView): void {
    this.closeOverlay();
    const overlay = el('div', 'overlay');
    const dialog = el('div', 'panel dialog');
    const summary =
      objective.type === 'visitAllAreas'
        ? `Ihr habt alle ${objective.totalAreas} Bereiche aufgedeckt und betreten. Jeder Winkel ist erkundet.`
        : objective.type === 'clearDungeon'
          ? `Ihr habt alle ${objective.totalAreas} Bereiche entdeckt und alle ${objective.defeatedMonsters} Gegner besiegt.`
          : 'Ihr habt alle Räume entdeckt.';
    dialog.append(
      el('h2', undefined, objective.type === 'clearDungeon' ? 'Gewölbe befreit!' : 'Gewölbe erkundet!'),
      el('p', undefined, `${summary} Schaut euch in Ruhe um – oder startet eine neue Partie.`),
    );
    const row = el('div', 'row');
    row.append(
      button('Weiter umsehen', 'secondary', () => this.closeOverlay()),
      button('Neues Spiel', '', () => {
        this.closeOverlay();
        this.handlers.onRestart();
      }),
    );
    dialog.append(row);
    overlay.appendChild(dialog);
    this.root.appendChild(overlay);
    this.overlay = overlay;
  }

  closeOverlay(): void {
    this.overlay?.remove();
    this.overlay = null;
  }

  private confirmRestart(): void {
    this.closeOverlay();
    const overlay = el('div', 'overlay');
    const dialog = el('div', 'panel dialog');
    dialog.append(el('h2', undefined, 'Neues Spiel?'), el('p', undefined, 'Die aktuelle Partie wird für beide Spieler zurückgesetzt.'));
    const row = el('div', 'row');
    row.append(
      button('Abbrechen', 'secondary', () => this.closeOverlay()),
      button('Neu starten', '', () => {
        this.closeOverlay();
        this.handlers.onRestart();
      }),
    );
    dialog.append(row);
    overlay.appendChild(dialog);
    overlay.addEventListener('click', (e) => e.target === overlay && this.closeOverlay());
    this.root.appendChild(overlay);
    this.overlay = overlay;
  }
}
