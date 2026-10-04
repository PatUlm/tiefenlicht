// Takes the README screenshots from a running server (built client).
// Usage: pnpm build && pnpm start, then: node scripts/screenshots.mjs [http://localhost:8080]
// Two browser contexts per device: A creates a game, B joins with the code.
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';

const BASE = process.argv[2] ?? 'http://localhost:8080';
const OUT = 'docs/screenshots';
const DEVICES = {
  'tablet-quer': { viewport: { width: 1280, height: 800 }, hasTouch: true },
  'tablet-hoch': { viewport: { width: 800, height: 1280 }, hasTouch: true },
  handy: { viewport: { width: 412, height: 915 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 },
};

// Software WebGL: slow (a few FPS) but deterministic and headless.
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
await mkdir(OUT, { recursive: true });

async function lobby(context) {
  const page = await context.newPage();
  await page.goto(BASE);
  await page.waitForSelector('.lobby-card h1', { timeout: 180_000 });
  // Software rendering shows single-digit FPS; the readout is not part of the game.
  await page.addStyleTag({ content: '.fps, .menu-fps { display: none !important; }' });
  return page;
}

for (const [name, device] of Object.entries(DEVICES)) {
  const a = await browser.newContext(device);
  const b = await browser.newContext(device);
  const host = await lobby(a);
  await host.fill('.field input', 'Brakka');
  if (name === 'tablet-quer') await host.screenshot({ path: `${OUT}/lobby.jpg`, quality: 85 });
  await host.click('text=Neues Spiel erstellen');
  const code = (await host.textContent('.waiting-code', { timeout: 30_000 }))?.trim();

  const guest = await lobby(b);
  await guest.fill('.field input', 'Ilyria');
  await guest.fill('.code-input', code);
  await guest.click('text=Beitreten');

  await host.waitForSelector('.turn-bar .who:not(:empty)', { timeout: 120_000 });
  // Let the lobby fade out and the camera settle.
  await host.waitForTimeout(4000);
  await host.screenshot({ path: `${OUT}/${name}.jpg`, quality: 85 });
  console.log(`${OUT}/${name}.jpg`);
  await a.close();
  await b.close();
}
await browser.close();
