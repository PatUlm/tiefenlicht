import { RawTexture, Texture, type Scene } from '@babylonjs/core';

/**
 * Colour scheme for the dungeon ("Stein & Fackelschein"): a neutral, believable
 * base – grey stone, darker grey floors, natural wood – while accents (banners,
 * gold, books, flames, magic, the figures) stay saturated and comic-like.
 *
 * All KayKit dungeon models share one 1024×1024 palette of 8×4 cells, each a
 * vertical light→dark gradient. We recolour whole cells at load time: every
 * pixel keeps its relative brightness within the cell (so bevel highlights and
 * gradients survive) and is mapped onto the target [light, dark] gradient.
 */
type Gradient = readonly [light: string, dark: string];
type CellKey = `r${0 | 1 | 2 | 3}c${0 | 1 | 2 | 3 | 4 | 5 | 6 | 7}`;

const BASE_SCHEME: Partial<Record<CellKey, Gradient>> = {
  r0c1: ['#adaba6', '#6c6a66'], // wall stone: neutral mid grey (a touch warm)
  r0c0: ['#7c7a76', '#4b4946'], // dark stone trims, caps
  r0c5: ['#8e9296', '#5b5f63'], // floor slabs: cooler, darker slate grey
  r0c4: ['#9c7452', '#5d402a'], // wood: natural brown (barrels, crates, doors, planks)
  r0c2: ['#ad8862', '#79593d'], // light wood
  r0c6: ['#a77c50', '#6c4b2e'], // golden-brown wood (was orange)
  r0c7: ['#6d5440', '#3e2e21'], // dark wood (dark floor boards, handles)
  r0c3: ['#34353a', '#1b1c20'], // iron / black
  r2c0: ['#86a653', '#4e6f36'], // moss (was teal)
  r1c1: ['#dcc49c', '#b28f62'], // rope, parchment (slightly muted tan)
};

/**
 * The KayKit adventurer textures use the same 8×4 cell layout. A figure scheme
 * tints every cell (multiplied) except the listed ones, which get their own gradient.
 */
export interface FigureScheme {
  readonly tint: readonly [r: number, g: number, b: number];
  readonly cells: Partial<Record<CellKey, Gradient>>;
}

/** Dark elf (Rogue_Hooded): dark grey skin, violet hood and tunic, pale eyes that read on the dark face. */
export const DARK_ELF_SCHEME: FigureScheme = {
  tint: [0.72, 0.58, 1.0],
  cells: {
    r0c0: ['#9496a3', '#5d5f6c'], // skin: cool grey, light enough to read under the hood
    r0c1: ['#4a3f5c', '#2c2538'], // eyebrows
    r0c2: ['#e8e0ff', '#b8a8e6'], // eyes
    r1c1: ['#7a5fc6', '#3e2f77'], // hood, cape
    r1c0: ['#54468f', '#2b2350'], // tunic
  },
};

/** Stone objects reuse the dark-wood cell; for them it must be grey stone. */
const STONE_OVERRIDES: Partial<Record<CellKey, Gradient>> = {
  r0c7: ['#858380', '#52504d'],
};

export type PaletteVariant = 'base' | 'stone';

/** Models whose dark-wood cell is actually rock (rubble, pillars, candle stands). */
export const STONE_MODELS: ReadonlySet<string> = new Set([
  'floor_tile_large_rocks',
  'rubble_half',
  'pillar',
  'pillar_decorated',
  'column',
  'candle_triple',
  'candle_lit',
  'candle_melted',
]);

const PALETTE_URL = '/textures/kaykit-dungeon-palette.png';
const COLS = 8;
const ROWS = 4;

function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function luminance(d: ArrayLike<number>, i: number): number {
  return 0.2126 * d[i]! + 0.7152 * d[i + 1]! + 0.0722 * d[i + 2]!;
}

/** RGBA rows, top first (ImageData or a texture read back from the GPU). */
interface Pixels {
  readonly width: number;
  readonly height: number;
  readonly data: ArrayLike<number>;
}

function recolour(source: Pixels, scheme: Partial<Record<CellKey, Gradient>>, tint?: FigureScheme['tint']): Uint8Array {
  const { width, height } = source;
  const src = source.data;
  const out = new Uint8Array(src);
  if (tint) {
    for (let i = 0; i < out.length; i += 4) for (let c = 0; c < 3; c++) out[i + c] = Math.round(src[i + c]! * tint[c]!);
  }
  const cw = width / COLS;
  const ch = height / ROWS;
  for (const [key, gradient] of Object.entries(scheme) as [CellKey, Gradient][]) {
    const row = Number(key[1]);
    const col = Number(key[3]);
    const x0 = col * cw;
    const y0 = row * ch;
    let min = 255;
    let max = 0;
    for (let y = y0; y < y0 + ch; y++) {
      for (let x = x0; x < x0 + cw; x++) {
        const l = luminance(src, (y * width + x) * 4);
        if (l < min) min = l;
        if (l > max) max = l;
      }
    }
    const light = hexToRgb(gradient[0]);
    const dark = hexToRgb(gradient[1]);
    const span = Math.max(1, max - min);
    for (let y = y0; y < y0 + ch; y++) {
      for (let x = x0; x < x0 + cw; x++) {
        const i = (y * width + x) * 4;
        // Slight extrapolation keeps bevel highlights brighter than the gradient.
        const t = Math.min(1.12, (luminance(src, i) - min) / span);
        for (let c = 0; c < 3; c++) out[i + c] = Math.max(0, Math.min(255, dark[c]! + (light[c]! - dark[c]!) * t));
      }
    }
  }
  return out;
}

async function loadImageData(url: string): Promise<ImageData> {
  const img = new Image();
  img.src = url;
  await img.decode();
  const canvas = document.createElement('canvas');
  canvas.width = img.width;
  canvas.height = img.height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(img, 0, 0);
  return ctx.getImageData(0, 0, img.width, img.height);
}

function paletteTexture(pixels: Uint8Array, width: number, height: number, scene: Scene, name: string): Texture {
  // Image rows are top-first, matching glTF UVs (the loader uses invertY=false).
  const tex = RawTexture.CreateRGBATexture(pixels, width, height, scene, true, false, Texture.TRILINEAR_SAMPLINGMODE);
  tex.name = name;
  tex.gammaSpace = true;
  tex.wrapU = Texture.CLAMP_ADDRESSMODE;
  tex.wrapV = Texture.CLAMP_ADDRESSMODE;
  return tex;
}

/** Builds the recoloured palette textures (one per variant). */
export async function createDungeonPalettes(scene: Scene): Promise<Record<PaletteVariant, Texture>> {
  const source = await loadImageData(PALETTE_URL);
  const make = (scheme: Partial<Record<CellKey, Gradient>>, name: string) =>
    paletteTexture(recolour(source, scheme), source.width, source.height, scene, name);
  return {
    base: make(BASE_SCHEME, 'dungeon-palette'),
    stone: make({ ...BASE_SCHEME, ...STONE_OVERRIDES }, 'dungeon-palette-stone'),
  };
}

/** A recoloured copy of a loaded figure texture (read back from the GPU, rows top-first like the source). */
export async function createFigureTexture(source: Texture, scheme: FigureScheme, name: string): Promise<Texture> {
  const { width, height } = source.getSize();
  const data = await source.readPixels();
  if (!data) throw new Error(`Texture not readable: ${source.name}`);
  const pixels = { width, height, data: new Uint8Array(data.buffer, data.byteOffset, data.byteLength) };
  return paletteTexture(recolour(pixels, scheme.cells, scheme.tint), width, height, source.getScene()!, name);
}
