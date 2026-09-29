import type { GameView, PlayerId } from '@dungeon/shared';
import { HERO_COLORS } from '../scene/characters.ts';
import { button, el } from './dom.ts';

export interface HudHandlers {
  onEndTurn(): void;
  onRestart(): void;
}

export interface HudState {
  readonly busy: boolean;
  /** False once nothing useful is left this turn (M3 hint). */
  readonly canStillAct: boolean;
  readonly connected: boolean;
}

const HERO_ICON = { dwarf: '⚒', darkelf: '🗡' } as const;

/** HTML overlay: players, turn budget, objective, log, toasts and banners. */
export class Hud {
  private readonly root: HTMLDivElement;
  private readonly players: HTMLDivElement;
  private readonly codeChip: HTMLDivElement;
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
  private bannerTimer: number | undefined;
  private overlay: HTMLDivElement | null = null;

  constructor(
    parent: HTMLElement,
    private readonly handlers: HudHandlers,
  ) {
    this.root = el('div');
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
    const restart = button('Neues Spiel', 'secondary small', () => void this.confirmRestart());
    right.append(objective, restart);
    top.append(left, right);

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

    this.logBox = el('div', 'panel log');
    const help = el('div', 'panel help');
    for (const [key, text] of [
      ['Klick', 'Laufen / Tür öffnen'],
      ['Ziehen', 'Kamera schwenken'],
      ['Rad', 'Zoomen'],
      ['Q E', 'Ansicht drehen'],
      ['F', 'Held fokussieren'],
      ['G', 'Raster an/aus'],
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

    this.root.append(top, this.turnBar, this.logBox, help, this.toasts, this.bannerBox, this.tooltip, this.connection);
  }

  show(): void {
    this.root.style.display = '';
  }

  hide(): void {
    this.root.style.display = 'none';
  }

  update(view: GameView, you: PlayerId, state: HudState): void {
    this.codeChip.replaceChildren(document.createTextNode('Code '), el('b', undefined, view.gameId));

    const heroes = new Map(view.heroes.map((h) => [h.id, h]));
    const active = view.turn?.activePlayerId;
    this.players.replaceChildren(
      ...[...view.players]
        .sort((a, b) => a.slot - b.slot)
        .map((p) => {
          const hero = heroes.get(p.heroId);
          const row = el('div', `player${p.id === active ? ' active' : ''}`);
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

    const o = view.objective;
    this.objectiveText.textContent = o.completed ? 'Gewölbe erkundet! ✨' : `Erkunde das Gewölbe (${o.revealedAreas}/${o.totalAreas})`;
    this.progress.replaceChildren(...Array.from({ length: o.totalAreas }, (_, i) => el('span', i < o.revealedAreas ? 'done' : '')));

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
          ? 'Klicke ein leuchtendes Feld zum Laufen. Steht dein Held an einer Tür, klicke sie an.'
          : 'Nichts mehr zu tun – beende deinen Zug.';
    } else {
      this.turnWho.textContent = `Runde ${turn.round} · ${activeHero?.name ?? '…'} ist am Zug`;
      this.turnHint.textContent = activePlayer && !activePlayer.connected ? `${activePlayer.name} ist getrennt – das Spiel wartet.` : `${activePlayer?.name ?? ''} spielt gerade.`;
    }
    const max = view.rules.movementPerTurn;
    const left = turn?.movementLeft ?? 0;
    this.movePips.replaceChildren(...Array.from({ length: max }, (_, i) => el('span', `pip${i < left ? ' on' : ''}`)));
    this.actionPips.replaceChildren(
      ...Array.from({ length: view.rules.actionsPerTurn }, (_, i) => el('span', `pip action${i < (turn?.actionsLeft ?? 0) ? ' on' : ''}`)),
    );
    this.endTurn.style.display = mine ? '' : 'none';
    this.endTurn.disabled = state.busy || !state.connected;
    this.endTurn.classList.toggle('pulse', mine && !state.canStillAct && !state.busy);
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
    this.tooltip.style.left = `${x}px`;
    this.tooltip.style.top = `${y}px`;
  }

  setConnection(text: string | null): void {
    this.connection.style.display = text ? '' : 'none';
    this.connection.textContent = text ?? '';
  }

  showVictory(): void {
    this.closeOverlay();
    const overlay = el('div', 'overlay');
    const dialog = el('div', 'panel dialog');
    dialog.append(
      el('h2', undefined, 'Gewölbe erkundet!'),
      el('p', undefined, 'Ihr habt alle Räume entdeckt. Schaut euch in Ruhe um – oder startet eine neue Partie.'),
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
