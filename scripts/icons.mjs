// Renders the PWA icons (PNG) from assets/icons/icon.svg.
// Usage: node scripts/icons.mjs
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';

const DIR = 'assets/icons';
const SIZES = { 'icon-192.png': 192, 'icon-512.png': 512, 'apple-touch-icon.png': 180 };

const svg = await readFile(`${DIR}/icon.svg`, 'utf8');
const browser = await chromium.launch();
for (const [file, size] of Object.entries(SIZES)) {
  const page = await browser.newPage({ viewport: { width: size, height: size } });
  await page.setContent(
    `<style>html,body{margin:0}svg{display:block;width:${size}px;height:${size}px}</style>${svg}`,
  );
  await page.screenshot({ path: `${DIR}/${file}` });
  await page.close();
  console.log(`${DIR}/${file}`);
}
await browser.close();
