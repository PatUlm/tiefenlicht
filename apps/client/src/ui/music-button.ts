import type { Music } from '../audio/music.ts';
import { iconButton } from './dom.ts';

/** Music on/off toggle; every instance follows the shared state. */
export function musicButton(music: Music): HTMLButtonElement {
  const b = iconButton('♪', '', 'music-button', () => music.toggle());
  const render = (on: boolean) => {
    const label = on ? 'Musik aus (M)' : 'Musik an (M)';
    b.title = label;
    b.setAttribute('aria-label', label);
    b.setAttribute('aria-pressed', String(on));
    b.classList.toggle('off', !on);
  };
  render(music.enabled);
  music.onChange(render);
  return b;
}
