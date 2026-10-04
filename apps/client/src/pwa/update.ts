import { registerSW } from 'virtual:pwa-register';

/**
 * Updates of the installed app: the service worker looks for a new version on
 * start, every 30 minutes and whenever the app comes back to the foreground.
 * A new version takes over by itself; the page reloads into it only while no
 * game is joined (never in the middle of a game).
 */
let reloadPending = false;
let isSafe: () => boolean = () => true;

/** How long the very first visit waits for the service worker before loading the models. */
const FIRST_INSTALL_WAIT_MS = 10_000;

/**
 * Registers the service worker. The returned promise resolves once it controls
 * the page (at most after a few seconds), so the models load through its cache
 * already on the first visit.
 */
export function setupUpdates(safeToReload: () => boolean): Promise<void> {
  isSafe = safeToReload;
  if (!import.meta.env.PROD || !('serviceWorker' in navigator)) return Promise.resolve();
  void dropStaleModelCaches();
  registerSW({
    immediate: true,
    // Without this hook autoUpdate reloads every open page at once, games included.
    // It is not called for the very first install.
    onNeedReload() {
      reloadPending = true;
      reloadIfPending();
    },
    onRegisteredSW(_url, reg) {
      if (!reg) return;
      setInterval(() => void reg.update(), 30 * 60 * 1000);
      document.addEventListener('visibilitychange', () => {
        if (!document.hidden) void reg.update();
      });
    },
  });
  if (navigator.serviceWorker.controller) return Promise.resolve();
  return new Promise((resolve) => {
    navigator.serviceWorker.addEventListener('controllerchange', () => resolve(), { once: true });
    setTimeout(resolve, FIRST_INSTALL_WAIT_MS);
  });
}

/** Call when the app reaches a calm moment (back in the lobby). */
export function reloadIfPending(): void {
  if (reloadPending && isSafe()) location.reload();
}

/** Models of earlier releases live in caches named after their content hash. */
async function dropStaleModelCaches(): Promise<void> {
  try {
    for (const name of await caches.keys()) {
      if (name.startsWith('tiefenlicht-models') && name !== __MODELS_CACHE__) await caches.delete(name);
    }
  } catch {
    /* CacheStorage unavailable (e.g. private mode): nothing to clean up */
  }
}

export const APP_VERSION = __APP_VERSION__;
