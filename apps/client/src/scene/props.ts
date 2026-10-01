import {
  Color3,
  Color4,
  DynamicTexture,
  Mesh,
  MeshBuilder,
  StandardMaterial,
  TransformNode,
  Vector3,
  type AbstractMesh,
  type ParticleSystem,
  type PointLight,
  type Scene,
} from '@babylonjs/core';
import type { PropDefinition, ThemeId, WallDecorDefinition } from '@dungeon/shared';
import { MAX_LIGHTS, type AssetLibrary, type DungeonModel } from './assets.ts';
import { disposeParticles, type Effects, type FlameTint } from './effects.ts';
import { CELL, OPPOSITE, facingAngle, tileCenter, tileNoise } from './grid.ts';

export interface PropVisual {
  readonly root: TransformNode;
  readonly lights: PointLight[];
  readonly particles: ParticleSystem[];
  /** Meshes that should cast shadows. */
  readonly casters: AbstractMesh[];
  /** Animated flames, switched off on storeys below the focus level. */
  readonly flames: TransformNode[];
}

/**
 * Where a flame sits on the single-candle models (unscaled): `candle_lit` has a small
 * modelled flame from 0.8 to its top at 1.05, `candle_melted` none (top at 0.7).
 */
const WICK = { candle_lit: 0.8, candle_melted: 0.66 } as const;

const THEME_FLAME: Record<ThemeId, FlameTint> = {
  hall: 'fire',
  corridor: 'fire',
  crypt: 'green',
  mage: 'arcane',
};

const THEME_BANNER: Record<ThemeId, DungeonModel> = {
  hall: 'banner_patternA_red',
  corridor: 'banner_patternA_red',
  crypt: 'banner_patternB_green',
  mage: 'banner_thin_blue',
};

/** Builds visuals for props and wall decorations (data → 3D, concept §9/§11). */
export class PropFactory {
  private readonly materials = new Map<string, StandardMaterial>();

  constructor(
    private readonly scene: Scene,
    private readonly assets: AssetLibrary,
    private readonly effects: Effects,
  ) {}

  createProp(prop: PropDefinition, theme: ThemeId, withLight: boolean): PropVisual {
    const w = prop.size?.w ?? 1;
    const h = prop.size?.h ?? 1;
    const root = new TransformNode(`prop:${prop.id}`, this.scene);
    root.position = tileCenter({ x: prop.position.x + (w - 1) / 2, y: prop.position.y + (h - 1) / 2, level: prop.position.level });
    root.rotation.y = facingAngle(prop.facing);
    const visual: PropVisual = { root, lights: [], particles: [], casters: [], flames: [] };
    const add = (mesh: AbstractMesh, cast = true) => {
      mesh.parent = root;
      if (cast) visual.casters.push(mesh);
      return mesh;
    };
    const noise = tileNoise(prop.position.x, prop.position.y, 7);

    switch (prop.kind) {
      case 'pillar':
        add(this.assets.instance(theme === 'hall' ? 'pillar_decorated' : 'pillar'));
        break;
      case 'barrel': {
        const barrel = add(this.assets.instance(noise < 0.5 ? 'barrel_large' : 'barrel_small_stack'));
        barrel.rotation.y = noise * Math.PI;
        break;
      }
      case 'crates':
        add(this.assets.instance(noise < 0.5 ? 'crates_stacked' : 'box_stacked')).scaling.setAll(noise < 0.5 ? 1.2 : 1);
        break;
      case 'keg':
        add(this.assets.instance('keg_decorated')).rotation.y = Math.PI / 2;
        break;
      case 'rubble': {
        const rubble = add(this.assets.instance('rubble_half'));
        rubble.position.x = -1.2;
        rubble.scaling.setAll(0.6);
        break;
      }
      case 'table': {
        // Long table spans the footprint: model length is along Z, footprint is along local X.
        const table = add(this.assets.instance('table_long_decorated_A'));
        table.rotation.y = Math.PI / 2;
        table.scaling = new Vector3(1.4, 1, 1.6);
        const bottles: DungeonModel[] = ['bottle_A_green', 'bottle_B_brown', 'bottle_C_green'];
        bottles.forEach((b, i) => {
          const bottle = add(this.assets.instance(b), false);
          bottle.position = new Vector3(-2.6 + i * 0.7, 1.9, 0.5 - (i % 2) * 0.8);
        });
        const candle = add(this.assets.instance('candle_lit'), false);
        candle.position = new Vector3(2.4, 1.9, -0.3);
        break;
      }
      case 'candles':
        this.buildCandles(visual, theme, withLight);
        break;
      case 'chest': {
        const chest = this.assets.hierarchy('chest_gold');
        chest.parent = root;
        chest.scaling.setAll(1.3);
        chest.position.z = -0.4;
        const lid = chest.getChildTransformNodes(false).find((n) => n.name.includes('chest_lid'));
        if (lid) lid.rotation.x = -0.5;
        visual.casters.push(...chest.getChildMeshes());
        const coins = add(this.assets.instance('coin_stack_medium'), false);
        coins.position = new Vector3(1.3, 0, 0.9);
        visual.particles.push(this.effects.sparkles(new Vector3(0, 1.2, -0.4), new Color4(1, 0.9, 0.4, 1), new Color4(1, 0.6, 0.2, 1), 0.6, 8));
        break;
      }
      case 'sarcophagus':
        this.buildSarcophagus(visual, h);
        break;
      case 'bookshelf':
        this.buildBookshelf(visual, prop.position.x * 31 + prop.position.y);
        break;
      case 'cauldron':
        this.buildCauldron(visual, withLight);
        break;
      case 'crystal':
        this.buildCrystal(visual, withLight);
        break;
      case 'statue':
        this.buildStatue(visual);
        break;
      case 'telescope':
        this.buildTelescope(visual);
        break;
      case 'starChart':
        this.buildStarChart(visual, w, h, withLight);
        break;
      case 'bonePile':
        this.buildBonePile(visual, noise);
        break;
    }
    for (const p of visual.particles) p.emitter = this.worldEmitter(root, p.emitter as Vector3);
    return visual;
  }

  createWallDecor(decor: WallDecorDefinition, theme: ThemeId, withLight: boolean): PropVisual {
    const root = new TransformNode(`decor:${decor.id}`, this.scene);
    const inward = OPPOSITE[decor.wall];
    root.rotation.y = facingAngle(inward);
    const center = tileCenter(decor.position);
    const dirVec = { N: [0, -1], S: [0, 1], E: [1, 0], W: [-1, 0] }[decor.wall];
    // Wall surface: half a cell towards the wall, minus half the wall thickness.
    root.position = center.add(new Vector3(dirVec[0]! * (CELL / 2 - 0.5), 0, dirVec[1]! * (CELL / 2 - 0.5)));
    const visual: PropVisual = { root, lights: [], particles: [], casters: [], flames: [] };

    switch (decor.kind) {
      case 'torch': {
        const torch = this.assets.instance('torch_mounted');
        torch.parent = root;
        torch.position.y = 2.4;
        const tint = THEME_FLAME[theme];
        const flameLocal = new Vector3(0, 3.15, 0.45);
        visual.flames.push(this.effects.flame(root, flameLocal, tint));
        if (withLight) {
          const light = this.effects.pointLight(
            `torch:${decor.id}`,
            flameLocal.add(new Vector3(0, 0.2, 0.9)),
            this.effects.flameLightColor(tint),
            tint === 'fire' ? 1.3 : 1.5,
            21,
          );
          light.parent = root;
          visual.lights.push(light);
        }
        break;
      }
      case 'banner': {
        const banner = this.assets.instance(THEME_BANNER[theme]);
        banner.parent = root;
        banner.position.z = -0.25;
        break;
      }
      case 'shield': {
        const shield = this.assets.instance('sword_shield');
        shield.parent = root;
        shield.position = new Vector3(0, 2.6, 0.05);
        break;
      }
      case 'skullNiche':
        this.buildSkullNiche(visual);
        break;
    }
    for (const p of visual.particles) p.emitter = this.worldEmitter(root, p.emitter as Vector3);
    return visual;
  }

  // ------------------------------------------------------------ procedural

  private material(key: string, make: () => StandardMaterial): StandardMaterial {
    let m = this.materials.get(key);
    if (!m) {
      m = make();
      m.maxSimultaneousLights = MAX_LIGHTS;
      this.materials.set(key, m);
    }
    return m;
  }

  private flat(key: string, color: Color3, emissive = Color3.Black(), specular = 0.08): StandardMaterial {
    return this.material(key, () => {
      const m = new StandardMaterial(key, this.scene);
      m.diffuseColor = color;
      m.emissiveColor = emissive;
      m.specularColor = new Color3(specular, specular, specular);
      return m;
    });
  }

  private buildCandles(visual: PropVisual, theme: ThemeId, withLight: boolean): void {
    const spots: [DungeonModel, number, number][] = [
      ['candle_triple', -0.6, -0.4],
      ['candle_lit', 0.7, 0.3],
      ['candle_melted', -0.2, 0.8],
      ['candle_lit', 0.3, -0.9],
    ];
    const tint: FlameTint = theme === 'crypt' ? 'fire' : THEME_FLAME[theme];
    const scale = 1.6;
    for (const [model, x, z] of spots) {
      const candle = this.assets.instance(model);
      candle.parent = visual.root;
      candle.position = new Vector3(x, 0, z);
      candle.scaling.setAll(scale);
      if (model === 'candle_lit') visual.flames.push(this.effects.flame(visual.root, new Vector3(x, WICK.candle_lit * scale, z), tint, 0.45));
    }
    if (withLight) {
      const light = this.effects.pointLight('candles', new Vector3(0, 2.2, 0), new Color3(1, 0.7, 0.35), 0.9, 14);
      light.parent = visual.root;
      visual.lights.push(light);
    }
  }

  private buildSarcophagus(visual: PropVisual, lengthTiles: number): void {
    const stone = this.flat('sarcophagus-stone', new Color3(0.42, 0.42, 0.41));
    const lidMat = this.flat('sarcophagus-lid', new Color3(0.5, 0.5, 0.48));
    const trim = this.flat('sarcophagus-trim', new Color3(0.8, 0.62, 0.3));
    const length = lengthTiles * CELL - 1.2;
    const base = MeshBuilder.CreateBox('sarc-base', { width: 2.4, height: 1.4, depth: length }, this.scene);
    base.material = stone;
    base.position.y = 0.7;
    const plinth = MeshBuilder.CreateBox('sarc-plinth', { width: 2.8, height: 0.3, depth: length + 0.4 }, this.scene);
    plinth.material = stone;
    plinth.position.y = 0.15;
    const lid = MeshBuilder.CreateBox('sarc-lid', { width: 2.7, height: 0.45, depth: length + 0.3 }, this.scene);
    lid.material = lidMat;
    lid.position = new Vector3(0.12, 1.62, 0.1);
    lid.rotation.y = 0.05;
    const band = MeshBuilder.CreateBox('sarc-band', { width: 2.75, height: 0.14, depth: 0.25 }, this.scene);
    band.material = trim;
    band.position = new Vector3(0.12, 1.4, length / 2 + 0.2);
    band.rotation.y = 0.05;
    const crossV = MeshBuilder.CreateBox('sarc-cross-v', { width: 0.3, height: 0.12, depth: 2.2 }, this.scene);
    const crossH = MeshBuilder.CreateBox('sarc-cross-h', { width: 1.3, height: 0.12, depth: 0.3 }, this.scene);
    crossV.material = trim;
    crossH.material = trim;
    crossV.position = new Vector3(0.12, 1.95, -0.6);
    crossH.position = new Vector3(0.12, 1.95, -1.1);
    for (const m of [base, plinth, lid, band, crossV, crossH]) {
      m.parent = visual.root;
      m.isPickable = false;
      visual.casters.push(m);
    }
    const candle = this.assets.instance('candle_melted');
    candle.parent = visual.root;
    candle.position = new Vector3(-0.7, 1.84, length / 2 - 0.5);
    visual.flames.push(this.effects.flame(visual.root, new Vector3(-0.7, 1.84 + WICK.candle_melted, length / 2 - 0.5), 'fire', 0.35));
  }

  private buildBookshelf(visual: PropVisual, seed: number): void {
    // Grain runs up the side panels and along the boards; the back panel is darker wood.
    const sides = this.wood('shelf-wood-v', '#6a472d', '#432c1a', true);
    const wood = this.wood('shelf-wood-h', '#6a472d', '#432c1a', false);
    const woodDark = this.wood('shelf-wood-back', '#4a3020', '#2e1d12', true);
    // Muted leather bindings (oxblood, forest, navy, tan, ochre, umber).
    const bookColors = ['#6e2a24', '#2f4a32', '#2b3550', '#7a5a3c', '#7a6332', '#4a3226'].map((hex, i) =>
      this.flat(`book-${i}`, Color3.FromHexString(hex), Color3.Black(), 0.12),
    );
    const parts: Mesh[] = [];
    const width = 3.4;
    const height = 3.9;
    const depth = 1.1;
    const z = -CELL / 2 + depth / 2 + 0.55; // against the wall behind (local -Z)
    const box = (name: string, w: number, hh: number, d: number, pos: Vector3, mat: StandardMaterial) => {
      const m = MeshBuilder.CreateBox(name, { width: w, height: hh, depth: d }, this.scene);
      m.position = pos;
      m.material = mat;
      parts.push(m);
      return m;
    };
    box('shelf-back', width, height, 0.12, new Vector3(0, height / 2, z - depth / 2 + 0.06), woodDark);
    box('shelf-left', 0.18, height, depth, new Vector3(-width / 2, height / 2, z), sides);
    box('shelf-right', 0.18, height, depth, new Vector3(width / 2, height / 2, z), sides);
    box('shelf-top', width + 0.3, 0.22, depth + 0.15, new Vector3(0, height, z), wood);
    const levels = [0.25, 1.35, 2.45];
    let n = seed;
    const rand = () => {
      n = (n * 16807 + 11) % 2147483647;
      return (n % 1000) / 1000;
    };
    for (const y of levels) {
      box('shelf-board', width, 0.14, depth, new Vector3(0, y, z), wood);
      let x = -width / 2 + 0.2;
      while (x < width / 2 - 0.35) {
        const bw = 0.16 + rand() * 0.14;
        const bh = 0.62 + rand() * 0.3;
        const tilt = rand() < 0.1 ? 0.25 : 0;
        const book = box('book', bw, bh, depth * 0.72, new Vector3(x + bw / 2, y + 0.07 + bh / 2, z + 0.05), bookColors[Math.floor(rand() * bookColors.length)]!);
        book.rotation.z = tilt;
        x += bw + 0.03 + (tilt ? 0.12 : 0);
        if (rand() < 0.08) x += 0.35;
      }
    }
    const merged = Mesh.MergeMeshes(parts, true, true, undefined, false, true)!;
    merged.name = 'bookshelf';
    merged.parent = visual.root;
    merged.isPickable = false;
    visual.casters.push(merged);
  }

  private buildCauldron(visual: PropVisual, withLight: boolean): void {
    const iron = this.flat('cauldron-iron', new Color3(0.2, 0.2, 0.26), Color3.Black(), 0.4);
    const brew = this.flat('cauldron-brew', new Color3(0.2, 0.9, 0.35), new Color3(0.25, 1, 0.4));
    const bowl = MeshBuilder.CreateSphere('cauldron', { diameter: 2.6, slice: 0.62, segments: 20, sideOrientation: Mesh.DOUBLESIDE }, this.scene);
    bowl.rotation.x = Math.PI;
    bowl.position.y = 1.85;
    bowl.material = iron;
    const rim = MeshBuilder.CreateTorus('cauldron-rim', { diameter: 2.3, thickness: 0.22, tessellation: 32 }, this.scene);
    rim.position.y = 1.95;
    rim.material = iron;
    const liquid = MeshBuilder.CreateDisc('brew', { radius: 1.08, tessellation: 32 }, this.scene);
    liquid.rotation.x = Math.PI / 2;
    liquid.position.y = 1.78;
    liquid.material = brew;
    const meshes: AbstractMesh[] = [bowl, rim, liquid];
    for (let i = 0; i < 3; i++) {
      const leg = MeshBuilder.CreateCylinder('leg', { height: 0.9, diameterTop: 0.25, diameterBottom: 0.15 }, this.scene);
      const a = (i / 3) * Math.PI * 2;
      leg.position = new Vector3(Math.cos(a) * 0.8, 0.45, Math.sin(a) * 0.8);
      leg.material = iron;
      meshes.push(leg);
    }
    for (const m of meshes) {
      m.parent = visual.root;
      m.isPickable = false;
    }
    visual.casters.push(bowl, rim);
    visual.particles.push(this.effects.sparkles(new Vector3(0, 1.8, 0), new Color4(0.5, 1, 0.5, 1), new Color4(0.2, 0.9, 0.4, 1), 0.7, 22));
    // Fire under the pot, between the legs, so it peeks out from below the bowl.
    for (let i = 0; i < 3; i++) {
      const a = ((i + 0.5) / 3) * Math.PI * 2;
      visual.flames.push(this.effects.flame(visual.root, new Vector3(Math.cos(a) * 0.75, 0.02, Math.sin(a) * 0.75), 'fire', 0.6));
    }
    if (withLight) {
      const light = this.effects.pointLight('cauldron', new Vector3(0, 3, 0), new Color3(0.5, 1, 0.55), 0.9, 16);
      light.parent = visual.root;
      visual.lights.push(light);
    }
  }

  private buildCrystal(visual: PropVisual, withLight: boolean): void {
    const rock = this.flat('crystal-rock', new Color3(0.3, 0.26, 0.38));
    const glass = this.material('crystal-glass', () => {
      const m = new StandardMaterial('crystal-glass', this.scene);
      m.diffuseColor = new Color3(0.4, 0.9, 1);
      m.emissiveColor = new Color3(0.25, 0.75, 1);
      m.specularColor = new Color3(1, 1, 1);
      m.specularPower = 64;
      m.alpha = 0.92;
      return m;
    });
    const base = MeshBuilder.CreateCylinder('crystal-base', { height: 0.9, diameterTop: 1.8, diameterBottom: 2.6, tessellation: 7 }, this.scene);
    base.position.y = 0.45;
    base.material = rock;
    const spin = new TransformNode('crystal-spin', this.scene);
    spin.parent = visual.root;
    spin.position.y = 2.7;
    const core = MeshBuilder.CreatePolyhedron('crystal', { type: 1, size: 0.8 }, this.scene);
    core.scaling = new Vector3(0.9, 2, 0.9);
    core.material = glass;
    core.parent = spin;
    const shards: AbstractMesh[] = [];
    for (let i = 0; i < 3; i++) {
      const shard = MeshBuilder.CreatePolyhedron('shard', { type: 1, size: 0.22 }, this.scene);
      shard.scaling.y = 1.8;
      const a = (i / 3) * Math.PI * 2;
      shard.position = new Vector3(Math.cos(a) * 1.3, Math.sin(a * 2) * 0.3, Math.sin(a) * 1.3);
      shard.material = glass;
      shard.parent = spin;
      shards.push(shard);
    }
    base.parent = visual.root;
    for (const m of [base, core, ...shards]) m.isPickable = false;
    visual.casters.push(base);
    let t = Math.random() * 10;
    const hover = this.scene.onBeforeRenderObservable.add(() => {
      t += this.scene.getEngine().getDeltaTime() / 1000;
      spin.rotation.y = t * 0.6;
      spin.position.y = 2.7 + Math.sin(t * 1.4) * 0.2;
    });
    visual.root.onDisposeObservable.addOnce(() => this.scene.onBeforeRenderObservable.remove(hover));
    visual.particles.push(this.effects.sparkles(new Vector3(0, 1.4, 0), new Color4(0.6, 0.95, 1, 1), new Color4(0.75, 0.5, 1, 1), 1.1, 35));
    if (withLight) {
      const light = this.effects.pointLight('crystal', new Vector3(0, 3.2, 0), new Color3(0.55, 0.82, 1), 1.3, 22);
      light.parent = visual.root;
      visual.lights.push(light);
    }
  }

  /** Wood with a procedural grain (vertical or horizontal), shared per key. */
  private wood(key: string, base: string, grain: string, vertical: boolean): StandardMaterial {
    return this.material(key, () => {
      const size = 128;
      const tex = new DynamicTexture(key, { width: size, height: size }, this.scene, true);
      const ctx = tex.getContext() as CanvasRenderingContext2D;
      ctx.fillStyle = base;
      ctx.fillRect(0, 0, size, size);
      ctx.strokeStyle = grain;
      for (let i = 0; i < 22; i++) {
        const y = tileNoise(i, 3, 61) * size;
        ctx.globalAlpha = 0.25 + tileNoise(i, 4, 61) * 0.45;
        ctx.lineWidth = 0.6 + tileNoise(i, 5, 61) * 1.6;
        ctx.beginPath();
        for (let x = 0; x <= size; x += 8) {
          const wave = Math.sin(x * 0.05 + i) * 1.5 + Math.sin(x * 0.13 + i * 2) * 0.8;
          if (x === 0) ctx.moveTo(x, y + wave);
          else ctx.lineTo(x, y + wave);
        }
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
      tex.update();
      if (vertical) tex.wAng = Math.PI / 2;
      const m = new StandardMaterial(key, this.scene);
      m.diffuseTexture = tex;
      m.specularColor = new Color3(0.05, 0.05, 0.05);
      return m;
    });
  }

  /** Brass telescope on a wooden tripod, aimed up past the prop's facing. */
  private buildTelescope(visual: PropVisual): void {
    const wood = this.flat('telescope-wood', new Color3(0.36, 0.23, 0.14));
    const brass = this.flat('telescope-brass', new Color3(0.8, 0.6, 0.27), new Color3(0.08, 0.05, 0.01), 0.5);
    const meshes: Mesh[] = [];
    for (let i = 0; i < 3; i++) {
      const a = (i / 3) * Math.PI * 2;
      const leg = MeshBuilder.CreateCylinder('telescope-leg', { height: 2.3, diameter: 0.12 }, this.scene);
      leg.material = wood;
      leg.position = new Vector3(Math.cos(a) * 0.45, 1.1, Math.sin(a) * 0.45);
      leg.rotation = new Vector3(Math.sin(a) * 0.38, 0, -Math.cos(a) * 0.38);
      meshes.push(leg);
    }
    const mount = MeshBuilder.CreateSphere('telescope-mount', { diameter: 0.38, segments: 10 }, this.scene);
    mount.material = brass;
    mount.position.y = 2.2;
    const tube = new TransformNode('telescope-tube', this.scene);
    tube.parent = visual.root;
    tube.position.y = 2.2;
    tube.rotation.x = 0.85; // tilt the barrel from straight up towards local +Z
    const barrel = MeshBuilder.CreateCylinder('telescope-barrel', { height: 2.6, diameterTop: 0.5, diameterBottom: 0.3, tessellation: 16 }, this.scene);
    barrel.material = brass;
    barrel.parent = tube;
    barrel.position.y = 0.5;
    const lens = MeshBuilder.CreateCylinder('telescope-lens', { height: 0.05, diameter: 0.42, tessellation: 16 }, this.scene);
    lens.material = this.flat('telescope-lens', new Color3(0.4, 0.75, 1), new Color3(0.3, 0.6, 1));
    lens.parent = tube;
    lens.position.y = 1.81;
    for (const y of [-0.4, 0.6, 1.6]) {
      const band = MeshBuilder.CreateTorus('telescope-band', { diameter: 0.38 + (y + 0.8) * 0.06, thickness: 0.06, tessellation: 16 }, this.scene);
      band.material = wood;
      band.parent = tube;
      band.position.y = y;
    }
    for (const m of [...meshes, mount]) m.parent = visual.root;
    for (const m of [...meshes, mount, barrel]) {
      m.isPickable = false;
      visual.casters.push(m);
    }
  }

  /** Glowing star chart inlaid in the floor (non-blocking by map data). */
  private buildStarChart(visual: PropVisual, w: number, h: number, withLight: boolean): void {
    // One shared material: every chart shows the same deterministic sky.
    const mat = this.material('star-chart', () => {
      const size = 256;
      const tex = new DynamicTexture('star-chart', { width: size, height: size }, this.scene, true);
      const ctx = tex.getContext() as CanvasRenderingContext2D;
      const c = size / 2;
      const glow = ctx.createRadialGradient(c, c, 10, c, c, c);
      glow.addColorStop(0, '#26306e');
      glow.addColorStop(1, '#0b0f2a');
      ctx.fillStyle = glow;
      ctx.beginPath();
      ctx.arc(c, c, c - 6, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = '#e9c46a';
      ctx.lineWidth = 5;
      ctx.stroke();
      for (let i = 0; i < 24; i++) {
        const a = (i / 24) * Math.PI * 2;
        ctx.beginPath();
        ctx.moveTo(c + Math.cos(a) * (c - 10), c + Math.sin(a) * (c - 10));
        ctx.lineTo(c + Math.cos(a) * (c - (i % 2 ? 18 : 26)), c + Math.sin(a) * (c - (i % 2 ? 18 : 26)));
        ctx.stroke();
      }
      const stars: [number, number][] = [];
      for (let i = 0; i < 60; i++) {
        const r = Math.sqrt(tileNoise(i, 1, 41)) * (c - 34);
        const a = tileNoise(i, 2, 41) * Math.PI * 2;
        stars.push([c + Math.cos(a) * r, c + Math.sin(a) * r]);
      }
      ctx.strokeStyle = 'rgba(160, 200, 255, 0.55)';
      ctx.lineWidth = 2;
      for (const group of [stars.slice(0, 5), stars.slice(5, 9), stars.slice(9, 14)]) {
        ctx.beginPath();
        group.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
        ctx.stroke();
      }
      stars.forEach(([x, y], i) => {
        ctx.fillStyle = i < 14 ? '#fff6d8' : '#b9d4ff';
        ctx.beginPath();
        ctx.arc(x, y, i < 14 ? 3.5 : 1.8, 0, Math.PI * 2);
        ctx.fill();
      });
      tex.hasAlpha = true;
      tex.update();
      const m = new StandardMaterial('star-chart', this.scene);
      m.diffuseColor = Color3.Black();
      m.emissiveTexture = tex;
      m.opacityTexture = tex;
      m.specularColor = Color3.Black();
      m.zOffset = -1;
      return m;
    });
    const chart = MeshBuilder.CreateGround('star-chart', { width: Math.min(w, h) * CELL - 0.6, height: Math.min(w, h) * CELL - 0.6 }, this.scene);
    chart.material = mat;
    chart.parent = visual.root;
    chart.position.y = 0.06;
    chart.isPickable = false;
    if (withLight) {
      const light = this.effects.pointLight('star-chart', new Vector3(0, 1.5, 0), new Color3(0.5, 0.62, 1), 0.7, 12);
      light.parent = visual.root;
      visual.lights.push(light);
    }
  }

  /** Heap of bones with two skulls. */
  private buildBonePile(visual: PropVisual, seed: number): void {
    const bone = this.flat('bone', new Color3(0.86, 0.82, 0.7));
    const parts: Mesh[] = [];
    for (let i = 0; i < 9; i++) {
      const n = (k: number) => tileNoise(i, Math.floor(seed * 1000), k);
      const shaft = MeshBuilder.CreateCylinder('bone-shaft', { height: 1, diameter: 0.13, tessellation: 8 }, this.scene);
      const knobs = [-0.5, 0.5].map((y) => {
        const knob = MeshBuilder.CreateSphere('bone-knob', { diameter: 0.24, segments: 6 }, this.scene);
        knob.position.y = y;
        return knob;
      });
      const piece = Mesh.MergeMeshes([shaft, ...knobs], true)!;
      piece.position = new Vector3((n(1) - 0.5) * 1.6, 0.12 + (i % 3) * 0.14, (n(2) - 0.5) * 1.6);
      piece.rotation = new Vector3(Math.PI / 2 + (n(3) - 0.5) * 0.6, n(4) * Math.PI, 0);
      parts.push(piece);
    }
    const skulls = [this.skull(new Vector3(-0.3, 0.55, 0.2), 0.3), this.skull(new Vector3(0.45, 0.32, -0.35), -0.5)];
    const pile = Mesh.MergeMeshes([...parts, ...skulls.map((k) => k.bone)], true)!;
    pile.material = bone;
    const eyes = Mesh.MergeMeshes(skulls.map((k) => k.eyes), true)!;
    eyes.material = this.flat('niche-dark', new Color3(0.06, 0.06, 0.07));
    for (const m of [pile, eyes]) {
      m.parent = visual.root;
      m.isPickable = false;
    }
    visual.casters.push(pile);
  }

  /** Recess in the wall with three skulls (wall decoration). */
  private buildSkullNiche(visual: PropVisual): void {
    const stone = this.flat('niche-stone', new Color3(0.42, 0.41, 0.4));
    const dark = this.flat('niche-dark', new Color3(0.06, 0.06, 0.07));
    const back = MeshBuilder.CreateBox('niche-back', { width: 1.9, height: 1.3, depth: 0.1 }, this.scene);
    back.material = dark;
    back.position = new Vector3(0, 1.75, 0.05);
    const frame = [
      MeshBuilder.CreateBox('niche-top', { width: 2.3, height: 0.25, depth: 0.45 }, this.scene),
      MeshBuilder.CreateBox('niche-sill', { width: 2.3, height: 0.2, depth: 0.5 }, this.scene),
      MeshBuilder.CreateBox('niche-left', { width: 0.2, height: 1.3, depth: 0.45 }, this.scene),
      MeshBuilder.CreateBox('niche-right', { width: 0.2, height: 1.3, depth: 0.45 }, this.scene),
    ];
    frame[0]!.position = new Vector3(0, 2.52, 0.2);
    frame[1]!.position = new Vector3(0, 1.0, 0.22);
    frame[2]!.position = new Vector3(-1.05, 1.75, 0.2);
    frame[3]!.position = new Vector3(1.05, 1.75, 0.2);
    const stoneMesh = Mesh.MergeMeshes(frame, true)!;
    stoneMesh.material = stone;
    const parts = [-0.55, 0, 0.55].map((x, i) => this.skull(new Vector3(x, 1.32, 0.25), (i - 1) * 0.25));
    const skulls = Mesh.MergeMeshes(parts.map((k) => k.bone), true)!;
    skulls.material = this.flat('bone', new Color3(0.86, 0.82, 0.7));
    const eyes = Mesh.MergeMeshes(parts.map((k) => k.eyes), true)!;
    eyes.material = dark;
    for (const m of [back, stoneMesh, skulls, eyes]) {
      m.parent = visual.root;
      m.isPickable = false;
    }
  }

  /** Simple skull facing local +Z, baked at `at`: bone (cranium and jaw) and the dark eye sockets. */
  private skull(at: Vector3, yaw: number): { bone: Mesh; eyes: Mesh } {
    const cranium = MeshBuilder.CreateSphere('skull', { diameter: 0.5, segments: 8 }, this.scene);
    cranium.scaling = new Vector3(1, 0.9, 1.1);
    const jaw = MeshBuilder.CreateBox('skull-jaw', { width: 0.3, height: 0.16, depth: 0.25 }, this.scene);
    jaw.position = new Vector3(0, -0.22, 0.1);
    const bone = Mesh.MergeMeshes([cranium, jaw], true)!;
    const sockets = [-0.1, 0.1].map((x) => {
      const eye = MeshBuilder.CreateSphere('skull-eye', { diameter: 0.13, segments: 6 }, this.scene);
      eye.position = new Vector3(x, 0.02, 0.23);
      return eye;
    });
    const eyes = Mesh.MergeMeshes(sockets, true)!;
    for (const m of [bone, eyes]) {
      m.position.copyFrom(at);
      m.rotation.y = yaw;
      m.bakeCurrentTransformIntoVertices();
    }
    return { bone, eyes };
  }

  private buildStatue(visual: PropVisual): void {
    const stone = this.flat('statue-stone', new Color3(0.54, 0.54, 0.53));
    const pedestalMat = this.flat('statue-pedestal', new Color3(0.36, 0.36, 0.35));
    const pedestal = MeshBuilder.CreateBox('pedestal', { width: 2.8, height: 1, depth: 2.8 }, this.scene);
    pedestal.position.y = 0.5;
    pedestal.material = pedestalMat;
    pedestal.parent = visual.root;
    visual.casters.push(pedestal);

    const knight = this.assets.character('Knight');
    knight.root.parent = visual.root;
    knight.root.position.y = 1;
    knight.root.scaling.setAll(1.55);
    const keep = new Set(['Knight:2H_Sword', 'Knight:Knight_Helmet', 'Knight:Knight_Cape', 'Knight:Knight_ArmLeft', 'Knight:Knight_ArmRight', 'Knight:Knight_Body', 'Knight:Knight_Head', 'Knight:Knight_LegLeft', 'Knight:Knight_LegRight']);
    for (const m of knight.meshes) {
      if (!keep.has(m.name)) m.setEnabled(false);
      m.material = stone;
      m.isPickable = false;
      visual.casters.push(m);
    }
    const pose = knight.animations.get('2H_Melee_Idle') ?? knight.animations.get('Idle');
    if (pose) {
      pose.start(false, 1, pose.from, pose.from);
      pose.goToFrame(pose.from);
      pose.pause();
    }
  }

  private worldEmitter(root: TransformNode, local: Vector3): Vector3 {
    root.computeWorldMatrix(true);
    return Vector3.TransformCoordinates(local, root.getWorldMatrix());
  }
}

export function disposePropVisual(visual: PropVisual): void {
  for (const p of visual.particles) disposeParticles(p);
  for (const l of visual.lights) l.dispose();
  visual.root.dispose(false, false);
}
