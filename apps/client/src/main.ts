import '@fontsource-variable/fredoka';
import { Matrix, Vector3 } from '@babylonjs/core';
import './styles.css';
import { Music } from './audio/music.ts';
import { GameController } from './game-controller.ts';
import { listenForInstallPrompt } from './pwa/install.ts';
import { setupUpdates } from './pwa/update.ts';
import { AssetLibrary } from './scene/assets.ts';
import { BoardOverlay } from './scene/board-overlay.ts';
import { DungeonView } from './scene/dungeon-view.ts';
import { Effects } from './scene/effects.ts';
import { World } from './scene/world.ts';
import { el } from './ui/dom.ts';
import { Hud } from './ui/hud.ts';
import { LobbyUI } from './ui/lobby.ts';

async function main(): Promise<void> {
  // Before loading the models: Chrome may offer installing while they load.
  listenForInstallPrompt();
  let controller: GameController;
  // Until the controller exists nothing is joined, so a reload into a new version is harmless.
  const serviceWorkerReady = setupUpdates(() => (controller as GameController | undefined)?.isIdle() ?? true);
  const canvas = document.getElementById('scene') as HTMLCanvasElement;
  const ui = document.getElementById('ui')!;
  const labels = document.getElementById('labels')!;

  const loading = el('div', 'loading', 'Lade das Gewölbe …');
  ui.appendChild(loading);

  const world = new World(canvas);
  world.start();
  // First visit: models then load through the service worker and land in its cache.
  await serviceWorkerReady;
  const assets = new AssetLibrary(world.scene);
  await assets.load((done, total) => {
    loading.textContent = `Lade das Gewölbe … ${Math.round((done / total) * 100)} %`;
  });
  loading.remove();

  const effects = new Effects(world.scene);
  const dungeon = new DungeonView(world, assets, effects);
  const overlay = new BoardOverlay(world.scene, world.glow);

  const music = new Music();
  const hud = new Hud(
    ui,
    {
      onEndTurn: () => controller.endTurn(),
      onRestart: () => controller.restart(),
      onSelectLevel: (level) => controller.selectLevel(level),
      onRotate: (step) => controller.rotateView(step),
      onFocusHero: () => controller.focusHero(),
      onToggleGrid: () => controller.toggleGrid(),
    },
    music,
  );
  const lobby = new LobbyUI(
    ui,
    {
      onCreate: (name) => controller.createGame(name),
      onJoin: (code, name, takeOver) => controller.joinGame(code, name, takeOver),
    },
    music,
  );
  controller = new GameController({ world, assets, effects, dungeon, overlay, hud, lobby, labels, music });
  controller.start();
  window.setInterval(() => hud.setFps(world.engine.getFps()), 500);

  if (import.meta.env.DEV || new URLSearchParams(location.search).has('debug')) exposeDebugHandle(world, controller);
}

/** Debug handle for automated smoke tests (dev builds or `?debug` only). */
function exposeDebugHandle(world: World, controller: GameController): void {
  // Project a world point to CSS pixels.
  const toScreen = (x: number, y: number, z: number) => {
    const engine = world.engine;
    const p = Vector3.Project(
      new Vector3(x, y, z),
      Matrix.Identity(),
      world.scene.getTransformMatrix(),
      world.camera.viewport.toGlobal(engine.getRenderWidth(), engine.getRenderHeight()),
    );
    const s = engine.getHardwareScalingLevel();
    return { x: p.x * s, y: p.y * s };
  };
  const focusTile = (x: number, y: number, level = world.focusLevel) => {
    world.setFocusLevel(level);
    world.focus(new Vector3(x * 4, 0, y * 4));
  };
  (window as unknown as { __dungeon: unknown }).__dungeon = { world, controller, toScreen, focusTile };
}

main().catch((err) => {
  console.error(err);
  document.body.appendChild(el('pre', 'loading', `Fehler beim Start: ${String(err)}`));
});
