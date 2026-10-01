import { Color3, DynamicTexture, Mesh, MeshBuilder, StandardMaterial, Texture, Vector4, VertexData, type InstancedMesh, type Scene } from '@babylonjs/core';
import { DIRECTION_OFFSETS, posKey, step, type Direction, type Position } from '@dungeon/shared';
import { MAX_LIGHTS } from './assets.ts';
import { CELL, tileNoise } from './grid.ts';

/**
 * Herringbone parquet for wooden rooms: boards at 45° whose zig-zag runs east–west,
 * framed by a dark frieze along the walls with mitred corners.
 *
 * Seen in a frame turned by 45°, herringbone is a lattice of RATIO×1 boards spanned
 * by (1, 1) and (RATIO, −RATIO) board widths. Turned back, that lattice is
 * axis-aligned: one board every √2 widths along x, one zig-zag band every RATIO·√2
 * widths along z. Choosing PERIODS boards per tile makes the pattern repeat exactly
 * once per tile, so every tile shows the same texture and the floor runs on seamlessly.
 */
const RATIO = 4;
/** Zig-zag bands per tile (north–south). */
const BANDS = 2;
/** Boards per tile along x; the board width is CELL / (PERIODS·√2) ≈ 0.354. */
const PERIODS = RATIO * BANDS;
const TEXTURE_SIZE = 1024;
/** Joint width in board widths (≈0.02 world units). */
const JOINT = 0.02 / (CELL / (PERIODS * Math.SQRT2));

const WOOD = '#9c7452';
const WOOD_LIGHT = '#ad8862';
const WOOD_DARK = '#79593d';
const JOINT_COLOUR = '#5d402a';
const FRIEZE_WOOD = '#6d5440';

/** Width of the frieze along the walls (world units). */
const FRIEZE = 0.25;
/** The KayKit wall's plinth and cap reach this far into the room, so the frieze starts there. */
const WALL_INSET = 0.5;
/** Top of the floor slab (matches the KayKit floor tiles) and the frieze just above it. */
const FLOOR_TOP = 0.05;
const FLOOR_BOTTOM = -0.1;
const FRIEZE_Y = FLOOR_TOP + 0.01;
/** Frieze boards running north–south are a touch darker, so the mitres read. */
const CROSS_SHADE = 0.86;

type Rgb = [number, number, number];

function rgb(hex: string): Rgb {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function mix(a: Rgb, b: Rgb, t: number): Rgb {
  return [0, 1, 2].map((i) => a[i]! + (b[i]! - a[i]!) * t) as Rgb;
}

function css([r, g, b]: Rgb, alpha = 1): string {
  return `rgba(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)}, ${alpha})`;
}

function mod(n: number, m: number): number {
  return ((n % m) + m) % m;
}

/** Wavy grain lines along a board (local x from x0 to x1, across y0…y1), in the current transform. */
function grain(ctx: CanvasRenderingContext2D, colour: Rgb, x0: number, x1: number, y0: number, y1: number, seed: number, along: 'x' | 'y', lineWidth: number): void {
  ctx.strokeStyle = css(colour);
  for (let i = 0; i < 4; i++) {
    const across = y0 + (y1 - y0) * (0.15 + 0.7 * tileNoise(seed, i, 41));
    const phase = tileNoise(seed, i, 42) * 6;
    const amplitude = (y1 - y0) * 0.05;
    ctx.globalAlpha = 0.18 + tileNoise(seed, i, 43) * 0.22;
    ctx.lineWidth = lineWidth * (0.6 + tileNoise(seed, i, 44));
    ctx.beginPath();
    const steps = 24;
    for (let s = 0; s <= steps; s++) {
      const a = x0 + ((x1 - x0) * s) / steps;
      const b = across + Math.sin(s * 0.7 + phase) * amplitude;
      if (along === 'x') ctx.lineTo(a, b);
      else ctx.lineTo(b, a);
    }
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
}

export class ParquetFloor {
  private readonly field: Mesh;
  private readonly friezeMaterial: StandardMaterial;

  constructor(private readonly scene: Scene) {
    const fieldMaterial = this.material('parquet', this.herringboneTexture());
    // A slab like the KayKit floors; the sides show a thin slice of the pattern.
    const side = new Vector4(0, 0, 1, (FLOOR_TOP - FLOOR_BOTTOM) / CELL);
    const full = new Vector4(0, 0, 1, 1);
    this.field = MeshBuilder.CreateBox(
      'parquet-tile',
      { width: CELL, height: FLOOR_TOP - FLOOR_BOTTOM, depth: CELL, faceUV: [side, side, side, side, full, full] },
      scene,
    );
    this.field.position.y = (FLOOR_TOP + FLOOR_BOTTOM) / 2;
    this.field.bakeCurrentTransformIntoVertices();
    this.field.material = fieldMaterial;
    this.field.receiveShadows = true;
    // Source stays invisible: its instances render independently.
    this.field.isVisible = false;
    this.field.isPickable = false;

    this.friezeMaterial = this.material('parquet-frieze', this.friezeTexture());
    this.friezeMaterial.backFaceCulling = false;
  }

  /** A parquet tile. Never rotate it: all tiles share one phase of the pattern. */
  tile(name: string): InstancedMesh {
    const inst = this.field.createInstance(name);
    inst.isPickable = false;
    return inst;
  }

  /**
   * The frieze of a tile in tile-local coordinates: a strip along the face of every
   * wall of the tile (mitred where two walls meet) and, at a corner where the room's
   * wall turns outwards, the pieces that carry the neighbours' strips round the corner.
   * Undefined if the tile has none.
   */
  frieze(t: Position, isWall: (p: Position, dir: Direction) => boolean, inArea: ReadonlySet<string>): Mesh | undefined {
    const half = CELL / 2;
    // Distances from the tile centre: the wall face (outer edge) and the inner edge of the frieze.
    const face = half - WALL_INSET;
    const inner = face - FRIEZE;
    const positions: number[] = [];
    const uvs: number[] = [];
    const colors: number[] = [];
    const indices: number[] = [];
    // u runs along the wall in world units (boards break at tile edges), v from the wall face (0) inwards (1).
    const polygon = (points: readonly [number, number][], alongX: boolean, out: { x: number; z: number }) => {
      const first = positions.length / 3;
      const shade = alongX ? 1 : CROSS_SHADE;
      for (const [x, z] of points) {
        positions.push(x, FRIEZE_Y, z);
        const along = alongX ? t.x * CELL + x : t.y * CELL + z;
        uvs.push((along + half) / CELL, (face - (x * out.x + z * out.z)) / FRIEZE);
        colors.push(shade, shade, shade, 1);
      }
      for (let i = 1; i < points.length - 1; i++) indices.push(first, first + i, first + i + 1);
    };

    for (const dir of ['N', 'E', 'S', 'W'] as const) {
      if (!isWall(t, dir)) continue;
      const o = DIRECTION_OFFSETS[dir];
      const out = { x: o.x, z: o.y };
      const alongX = o.x === 0;
      const [before, after]: [Direction, Direction] = alongX ? ['W', 'E'] : ['N', 'S'];
      // Point `s` along the wall at distance `d` from the tile centre towards it.
      const at = (s: number, d: number): [number, number] => (alongX ? [s, out.z * d] : [out.x * d, s]);
      // Next to another wall of this tile the strip ends in a mitre, otherwise it runs on.
      const [startOuter, startInner] = isWall(t, before) ? [face, inner] : [half, half];
      const [endOuter, endInner] = isWall(t, after) ? [face, inner] : [half, half];
      polygon([at(-startOuter, face), at(endOuter, face), at(endInner, inner), at(-startInner, inner)], alongX, out);
    }

    for (const dz of ['N', 'S'] as const) {
      for (const dx of ['E', 'W'] as const) {
        if (isWall(t, dz) || isWall(t, dx)) continue;
        const nz = step(t, dz);
        const nx = step(t, dx);
        if (!inArea.has(posKey(nz)) || !inArea.has(posKey(nx))) continue;
        if (!isWall(nz, dx) || !isWall(nx, dz)) continue;
        const sx = dx === 'E' ? 1 : -1;
        const sz = dz === 'S' ? 1 : -1;
        // The strip of the neighbour along x comes in at the tile edge and meets the one along z in a mitre.
        polygon([[sx * half, sz * face], [sx * face, sz * face], [sx * inner, sz * inner], [sx * half, sz * inner]], true, { x: 0, z: sz });
        polygon([[sx * face, sz * half], [sx * inner, sz * half], [sx * inner, sz * inner], [sx * face, sz * face]], false, { x: sx, z: 0 });
      }
    }

    if (indices.length === 0) return undefined;
    const mesh = new Mesh(`parquet-frieze-${posKey(t)}`, this.scene);
    const data = new VertexData();
    data.positions = positions;
    data.indices = indices;
    data.uvs = uvs;
    data.colors = colors;
    data.normals = positions.map((_, i) => (i % 3 === 1 ? 1 : 0));
    data.applyToMesh(mesh);
    mesh.material = this.friezeMaterial;
    mesh.receiveShadows = true;
    mesh.isPickable = false;
    return mesh;
  }

  private material(name: string, texture: Texture): StandardMaterial {
    const m = new StandardMaterial(name, this.scene);
    m.diffuseTexture = texture;
    m.specularColor = new Color3(0.05, 0.05, 0.05);
    m.maxSimultaneousLights = MAX_LIGHTS;
    return m;
  }

  /** One tile of herringbone (4×4 world units), seamless in both directions. */
  private herringboneTexture(): Texture {
    const size = TEXTURE_SIZE;
    const tex = new DynamicTexture('parquet', { width: size, height: size }, this.scene, true);
    const ctx = tex.getContext() as CanvasRenderingContext2D;
    ctx.fillStyle = JOINT_COLOUR;
    ctx.fillRect(0, 0, size, size);
    // Board frame (u along H boards, v along V boards) → canvas: x = s(u+v), y = s(v−u).
    const s = size / (2 * PERIODS);
    ctx.setTransform(s, -s, s, s, 0, 0);

    const base = rgb(WOOD);
    const light = rgb(WOOD_LIGHT);
    const dark = rgb(WOOD_DARK);
    interface Board {
      x: number;
      y: number;
      w: number;
      h: number;
      seed: number;
    }
    const boards: Board[] = [];
    for (let t = -BANDS - 2; t <= 2; t++) {
      for (let i = -2 * RATIO; i <= PERIODS + RATIO; i++) {
        // Boards one canvas period apart must look alike, so they share a seed.
        const seed = mod(i, PERIODS) * 8 + mod(t, BANDS) * 2;
        boards.push({ x: i + RATIO * t, y: i - RATIO * t, w: RATIO, h: 1, seed });
        boards.push({ x: i + RATIO + RATIO * t, y: i + 1 - RATIO - RATIO * t, w: 1, h: RATIO, seed: seed + 1 });
      }
    }
    for (const b of boards) {
      const r = tileNoise(b.seed, 0, 31) * 2 - 1;
      const colour = r < 0 ? mix(base, dark, -r * 0.6) : mix(base, light, r * 0.7);
      const alongX = b.w > b.h;
      const gradient = alongX ? ctx.createLinearGradient(b.x, 0, b.x + b.w, 0) : ctx.createLinearGradient(0, b.y, 0, b.y + b.h);
      const tilt = (tileNoise(b.seed, 1, 31) - 0.5) * 0.1;
      gradient.addColorStop(0, css(mix(colour, light, Math.max(0, tilt) * 2)));
      gradient.addColorStop(1, css(mix(colour, dark, Math.max(0, -tilt) * 2)));
      ctx.fillStyle = gradient;
      ctx.fillRect(b.x, b.y, b.w, b.h);
      ctx.save();
      ctx.beginPath();
      ctx.rect(b.x, b.y, b.w, b.h);
      ctx.clip();
      const grainColour = mix(colour, dark, 0.9);
      if (alongX) grain(ctx, grainColour, b.x, b.x + b.w, b.y, b.y + b.h, b.seed, 'x', 0.03);
      else grain(ctx, grainColour, b.y, b.y + b.h, b.x, b.x + b.w, b.seed, 'y', 0.03);
      ctx.restore();
    }
    // Joints last, so neighbours never paint over half of them.
    ctx.strokeStyle = JOINT_COLOUR;
    ctx.lineWidth = JOINT;
    for (const b of boards) ctx.strokeRect(b.x, b.y, b.w, b.h);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    tex.update();
    tex.anisotropicFilteringLevel = 8;
    return tex;
  }

  /** One frieze board along a tile edge: u along the wall (4 units), v across (0.25 units). */
  private friezeTexture(): Texture {
    const [w, h] = [512, 64];
    const tex = new DynamicTexture('parquet-frieze', { width: w, height: h }, this.scene, true);
    const ctx = tex.getContext() as CanvasRenderingContext2D;
    const colour = rgb(FRIEZE_WOOD);
    const gradient = ctx.createLinearGradient(0, 0, w, 0);
    gradient.addColorStop(0, css(mix(colour, rgb(WOOD), 0.12)));
    gradient.addColorStop(1, css(mix(colour, rgb(WOOD_DARK), 0.2)));
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, w, h);
    grain(ctx, mix(colour, rgb(JOINT_COLOUR), 0.9), 0, w, 0, h, 5, 'x', 2);
    ctx.fillStyle = JOINT_COLOUR;
    // Butt joints at both ends (they meet across the wrap) and edge joints on both long sides.
    ctx.fillRect(0, 0, 2, h);
    ctx.fillRect(w - 2, 0, 2, h);
    ctx.fillRect(0, 0, w, 3);
    ctx.fillRect(0, h - 3, w, 3);
    tex.update();
    tex.wrapV = Texture.CLAMP_ADDRESSMODE;
    tex.anisotropicFilteringLevel = 8;
    return tex;
  }
}
