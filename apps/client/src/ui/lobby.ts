import { MAX_PLAYER_NAME_LENGTH } from '@dungeon/shared';
import type { Music } from '../audio/music.ts';
import { canInstall, onInstallChange, promptInstall } from '../pwa/install.ts';
import { APP_VERSION } from '../pwa/update.ts';
import { button, el } from './dom.ts';
import { musicButton } from './music-button.ts';

export interface LobbyHandlers {
  onCreate(name: string): void;
  onJoin(code: string, name: string, takeOver: boolean): void;
}

const NAME_KEY = 'dungeon.playerName';

function loadName(): string {
  try {
    return localStorage.getItem(NAME_KEY) ?? '';
  } catch {
    return '';
  }
}

function saveName(name: string): void {
  try {
    localStorage.setItem(NAME_KEY, name);
  } catch {
    /* ignore */
  }
}

/** Start screen: create a game or join one by code; afterwards the waiting card. */
export class LobbyUI {
  private readonly root: HTMLDivElement;
  private readonly card: HTMLDivElement;
  private errorBox: HTMLDivElement | null = null;
  /** Shown on the start screen while the browser offers installing (Android Chrome). */
  private readonly installButton: HTMLButtonElement;
  private busy = false;

  constructor(
    parent: HTMLElement,
    private readonly handlers: LobbyHandlers,
    music: Music,
  ) {
    this.root = el('div', 'lobby');
    this.card = el('div', 'panel lobby-card');
    this.root.append(this.card, musicButton(music));
    parent.appendChild(this.root);
    this.installButton = button('Als App installieren', 'secondary small install', () => void promptInstall());
    const renderInstall = () => (this.installButton.hidden = !canInstall());
    renderInstall();
    onInstallChange(renderInstall);
  }

  showStart(prefillCode = '', error = ''): void {
    this.busy = false;
    this.root.classList.remove('fade');
    this.card.replaceChildren();
    this.card.append(el('h1', 'logo', 'Tiefenlicht'), el('p', 'subtitle', 'Ein Dungeon-Brettspiel · Tech-Prototyp v0.5'));

    const nameField = el('div', 'field');
    const nameInput = el('input');
    nameInput.maxLength = MAX_PLAYER_NAME_LENGTH;
    nameInput.placeholder = 'Dein Name';
    nameInput.value = loadName();
    nameInput.autocomplete = 'off';
    nameField.append(el('label', undefined, 'Name'), nameInput);

    const codeInput = el('input', 'code-input');
    codeInput.maxLength = 5;
    codeInput.placeholder = 'CODE';
    codeInput.value = prefillCode;
    codeInput.autocomplete = 'off';

    const name = () => {
      const value = nameInput.value.trim();
      if (!value) {
        this.showError('Bitte gib einen Namen ein.');
        nameInput.focus();
        return null;
      }
      saveName(value);
      return value;
    };
    const create = button('Neues Spiel erstellen', prefillCode ? 'secondary' : '', () => {
      const n = name();
      if (n && !this.busy) {
        this.busy = true;
        this.handlers.onCreate(n);
      }
    });
    const join = button('Beitreten', prefillCode ? '' : 'secondary', () => {
      const n = name();
      const code = codeInput.value.trim().toUpperCase();
      if (!n) return;
      if (code.length !== 5) {
        this.showError('Der Spielcode hat 5 Zeichen.');
        codeInput.focus();
        return;
      }
      if (!this.busy) {
        this.busy = true;
        this.handlers.onJoin(code, n, false);
      }
    });
    codeInput.addEventListener('keydown', (e) => e.key === 'Enter' && join.click());
    nameInput.addEventListener('keydown', (e) => e.key === 'Enter' && (prefillCode ? join : create).click());

    const joinRow = el('div', 'join-row');
    joinRow.append(codeInput, join);
    const joinField = el('div', 'field');
    joinField.append(el('label', undefined, 'Spielcode deines Mitspielers'), joinRow);

    const actions = el('div', 'lobby-actions');
    if (prefillCode) actions.append(joinField, el('div', 'divider', 'oder'), create);
    else actions.append(create, el('div', 'divider', 'oder'), joinField);

    this.errorBox = el('div', 'lobby-error', error);
    this.card.append(
      nameField,
      actions,
      this.errorBox,
      this.installButton,
      el('div', 'lobby-foot', 'Zwei Spieler · Zwerg & Dunkelelf · Assets: KayKit (CC0)'),
      el('div', 'lobby-version', `Version ${APP_VERSION}`),
    );
    (prefillCode || !nameInput.value ? nameInput : create).focus();
  }

  showWaiting(code: string, link: string): void {
    this.root.classList.remove('fade');
    this.card.replaceChildren();
    const copy = button('Einladungslink kopieren', '', () => {
      void navigator.clipboard?.writeText(link).then(
        () => (copy.textContent = 'Link kopiert ✓'),
        () => (copy.textContent = link),
      );
    });
    const waiting = el('p', 'subtitle');
    waiting.append(el('span', 'spinner'), document.createTextNode('Warte auf den zweiten Spieler …'));
    this.card.append(
      el('h1', 'logo', 'Tiefenlicht'),
      el('p', 'subtitle', 'Dein Spielcode'),
      el('div', 'waiting-code', code),
      copy,
      waiting,
      el('div', 'lobby-foot', 'Tipp: Öffne den Link in einem zweiten Browserfenster, um lokal zu zweit zu spielen.'),
    );
  }

  /** GAME_FULL with an orphaned seat: ask before taking it over (M9). */
  offerTakeOver(code: string, name: string, message: string): void {
    this.busy = false;
    this.showError(message);
    const take = button('Verwaisten Platz übernehmen', '', () => {
      if (this.busy) return;
      this.busy = true;
      this.handlers.onJoin(code, name, true);
    });
    this.errorBox?.after(take);
  }

  showError(message: string): void {
    this.busy = false;
    if (this.errorBox) this.errorBox.textContent = message;
  }

  /** A create or join request is on its way to the server. */
  isBusy(): boolean {
    return this.busy;
  }

  hide(): void {
    this.root.classList.add('fade');
  }
}
