import {
  Color3,
  Color4,
  DynamicTexture,
  Mesh,
  MeshBuilder,
  Quaternion,
  StandardMaterial,
  TransformNode,
  Vector3,
  VertexBuffer,
  VertexData,
  type AbstractMesh,
  type ParticleSystem,
  type PointLight,
} from '@babylonjs/core';
import { Board, propFootprint } from '@dungeon/game-core';
import {
  DIRECTIONS,
  directionTo,
  edgeKey,
  posKey,
  stairsShaft,
  step,
  type AreaView,
  type Direction,
  type DoorId,
  type DoorView,
  type GameView,
  type Position,
  type StairsId,
  type StairsView,
  type ThemeId,
} from '@dungeon/shared';
import { MAX_LIGHTS, MAX_POINT_LIGHTS, type AssetLibrary, type DungeonModel } from './assets.ts';
import { disposeParticles, type Effects } from './effects.ts';
import { CELL, LADDER_RUN, LEVEL_HEIGHT, OPPOSITE, facingAngle, levelY, tileCenter, tileNoise } from './grid.ts';
import { ParquetFloor } from './parquet.ts';
import { PropFactory, type PropVisual } from './props.ts';
import { ease, tween, wait } from './tween.ts';
import type { World } from './world.ts';

/** Visual style per theme: same geometry, different look (concept §11). */
interface ThemeStyle {
  readonly floors: readonly [DungeonModel, number][];
  readonly walls: readonly [DungeonModel, number][];
  /** How many torches of this area get a real point light (GPU light budget). */
  readonly torchLights: number;
  /** Wooden floors laid as herringbone parquet with a frieze instead of random tiles (see parquet.ts). */
  readonly parquet?: boolean;
}

const THEMES: Record<ThemeId, ThemeStyle> = {
  hall: {
    floors: [
      ['floor_tile_large', 0.86],
      ['floor_tile_big_grate', 0.08],
      ['floor_tile_large_rocks', 0.06],
    ],
    walls: [
      ['wall', 0.7],
      ['wall_arched', 0.15],
      ['wall_cracked', 0.15],
    ],
    torchLights: 2,
  },
  corridor: {
    floors: [
      ['floor_tile_large', 0.6],
      ['floor_dirt_large', 0.4],
    ],
    walls: [
      ['wall', 0.55],
      ['wall_cracked', 0.35],
      ['wall_broken', 0.1],
    ],
    torchLights: 2,
  },
  crypt: {
    floors: [
      ['floor_tile_large', 0.45],
      ['floor_dirt_large', 0.35],
      ['floor_tile_large_rocks', 0.2],
    ],
    walls: [
      ['wall_cracked', 0.5],
      ['wall', 0.3],
      ['wall_broken', 0.2],
    ],
    torchLights: 1,
  },
  mage: {
    floors: [['floor_wood_large', 1]],
    walls: [
      ['wall', 0.7],
      ['wall_arched', 0.3],
    ],
    torchLights: 1,
    parquet: true,
  },
};

const LOW_WALL = 0.2;
/** Height of the rail around a stairwell (fraction of a wall). */
const PARAPET = 0.3;
const STAGGER_MS = 55;
const STAIR_STEPS = 12;
/** Wooden ladder (outer width, rail section, rung spacing, rails reaching above the upper floor). */
const LADDER_WIDTH = 2;
const LADDER_RAIL = { width: 0.18, depth: 0.22 } as const;
const LADDER_RUNG_SPACING = 0.44;
const LADDER_GRIP = 0.8;
const STAIRS_EMISSIVE = new Color3(0.07, 0.07, 0.08);
/** The veil over lower levels sits just below the floor tiles of the focus level. */
const VEIL_DEPTH = 0.12;
/** Re-pick the active lights once the camera target moved this far (world units). */
const LIGHT_REPICK_DISTANCE = 3;

function pick(options: readonly [DungeonModel, number][], r: number): DungeonModel {
  let acc = 0;
  for (const [model, weight] of options) {
    acc += weight;
    if (r < acc) return model;
  }
  return options[options.length - 1]![0];
}

/** Starts or stops a particle system without restarting a running one. */
function run(ps: ParticleSystem, on: boolean): void {
  if (on && !ps.isStarted()) ps.start();
  else if (!on && ps.isStarted()) ps.stop();
}

function enableLight(light: PointLight, on: boolean): void {
  if (light.isEnabled(false) !== on) light.setEnabled(on);
}

/** World position of a light that hangs on a prop (its transformed position lags a frame). */
function lightWorldPosition(light: PointLight): Vector3 {
  const parent = light.parent as TransformNode | null;
  return parent ? Vector3.TransformCoordinates(light.position, parent.computeWorldMatrix(true)) : light.position;
}

interface AreaVisual {
  readonly id: string;
  readonly theme: ThemeId;
  readonly level: number;
  readonly tiles: readonly Position[];
  readonly floors: { mesh: AbstractMesh; pos: Position }[];
  /** Props and wall decoration; decoration additionally follows its wall's cutaway. */
  readonly props: { visual: PropVisual; pos: Position; decor: boolean }[];
  readonly lights: PointLight[];
  readonly particles: ParticleSystem[];
  /** Theme ambience (fog, sparkles). */
  readonly ambience: ParticleSystem[];
}

interface WallVisual {
  readonly tile: Position;
  readonly neighbour: Position;
  readonly mesh: AbstractMesh;
  readonly decor: PropVisual[];
  /** Low rail around a stairwell: never full height, ignores the cutaway. */
  readonly parapet: boolean;
  low: boolean;
}

interface DoorVisual {
  readonly view: DoorView;
  readonly level: number;
  readonly frames: TransformNode[];
  readonly leaves: TransformNode[];
  readonly materials: StandardMaterial[];
  readonly baseEmissive: Color3;
  readonly pickMeshes: Mesh[];
  mystery: ParticleSystem[];
  open: boolean;
  highlighted: boolean;
}

interface StairsVisual {
  readonly view: StairsView;
  readonly root: TransformNode;
  readonly material: StandardMaterial;
  readonly pickMesh: Mesh;
  /** Omen while unexplored: cold breath for stairs leading down, star sparks for stairs leading up. */
  readonly omen: ParticleSystem[];
  /** Storey the omen is emitted on (the known end's level). */
  readonly omenLevel: number;
  /** Floor markers on the known ends (foot and landing), keyed by tile. */
  readonly markers: Map<string, Mesh>;
  explored: boolean;
  highlighted: boolean;
}

/**
 * Turns the (filtered) dungeon data into a 3D board: floors, derived walls,
 * doors, stairs, props, decoration, lights. Handles the discovery animation,
 * the camera-dependent wall cutaway and the storeys: levels above the focus
 * level are hidden, levels below it are shown dimmed with their walls lowered.
 */
export class DungeonView {
  private readonly areas = new Map<string, AreaVisual>();
  private readonly walls = new Map<string, WallVisual>();
  private readonly doors = new Map<DoorId, DoorVisual>();
  private readonly stairs = new Map<StairsId, StairsVisual>();
  private readonly knownTiles = new Map<string, string>();
  private readonly levelNodes = new Map<number, TransformNode>();
  private readonly props: PropFactory;
  private readonly parquet: ParquetFloor;
  private readonly foundation: Mesh;
  private readonly stairsMaterial: StandardMaterial;
  private readonly ladderMaterial: StandardMaterial;
  private stairsMarkerMaterial: StandardMaterial | undefined;
  private readonly veil: Mesh;
  private veilKey = '';
  private veilSize = { width: 0, height: 0 };
  /** Point lights that may be on (on the focus level, their wall not lowered). */
  private lightCandidates: PointLight[] = [];
  private readonly lastLightTarget = new Vector3(Infinity, 0, 0);
  /** Props of lower storeys whose meshes are kept out of the glow layer. */
  private readonly glowMuted = new Set<PropVisual>();
  private highlightTime = 0;

  constructor(
    private readonly world: World,
    private readonly assets: AssetLibrary,
    private readonly effects: Effects,
  ) {
    this.props = new PropFactory(world.scene, assets, effects);
    this.parquet = new ParquetFloor(world.scene);
    this.foundation = MeshBuilder.CreateBox('foundation', { width: CELL, height: 2.6, depth: CELL }, world.scene);
    const mat = new StandardMaterial('foundation', world.scene);
    // Dark neutral stone slab under the board (shows through floor grates).
    mat.diffuseColor = new Color3(0.2, 0.195, 0.2);
    mat.specularColor = Color3.Black();
    mat.emissiveColor = new Color3(0.015, 0.015, 0.02);
    this.foundation.material = mat;
    this.foundation.isVisible = false;
    this.foundation.isPickable = false;

    // Slate steps, matching the floor slabs of the palette. A faint glow keeps a
    // flight readable down in its stairwell.
    this.stairsMaterial = new StandardMaterial('stairs', world.scene);
    this.stairsMaterial.diffuseColor = Color3.FromHexString('#7d8185');
    this.stairsMaterial.specularColor = new Color3(0.08, 0.08, 0.08);
    this.stairsMaterial.maxSimultaneousLights = MAX_LIGHTS;
    this.stairsMaterial.emissiveColor = STAIRS_EMISSIVE.clone();
    // Ladders are painted per part (vertex colours: wood, dark wood, iron).
    this.ladderMaterial = new StandardMaterial('ladder', world.scene);
    this.ladderMaterial.diffuseColor = Color3.White();
    this.ladderMaterial.specularColor = new Color3(0.05, 0.05, 0.05);
    this.ladderMaterial.maxSimultaneousLights = MAX_LIGHTS;
    this.ladderMaterial.emissiveColor = STAIRS_EMISSIVE.clone();

    this.veil = new Mesh('level-veil', world.scene);
    const veilMat = new StandardMaterial('level-veil', world.scene);
    veilMat.disableLighting = true;
    veilMat.diffuseColor = Color3.Black();
    // Close to the background colour, so lower storeys fade into the dark.
    veilMat.emissiveColor = new Color3(0.05, 0.055, 0.08);
    veilMat.alpha = 0.86;
    veilMat.backFaceCulling = false;
    this.veil.material = veilMat;
    this.veil.isPickable = false;
    this.veil.setEnabled(false);
    world.glow.addExcludedMesh(this.veil);

    for (const model of ['floor_tile_large', 'floor_tile_big_grate', 'floor_tile_large_rocks', 'floor_dirt_large', 'floor_wood_large', 'wall', 'wall_arched', 'wall_cracked', 'wall_broken'] as const) {
      assets.sourceMesh(model).receiveShadows = true;
    }

    world.onViewRotated.add(() => this.updateCutaway(true));
    world.onLevelChanged.add(() => this.updateCutaway(true));
    world.scene.onBeforeRenderObservable.add(() => {
      this.animateHighlights();
      if (Vector3.Distance(world.camera.target, this.lastLightTarget) > LIGHT_REPICK_DISTANCE) this.applyLightBudget();
    });
  }

  hasArea(id: string): boolean {
    return this.areas.has(id);
  }

  /** Levels with at least one known area, lowest first. */
  knownLevels(): number[] {
    return [...new Set([...this.areas.values()].map((a) => a.level))].sort((a, b) => a - b);
  }

  clear(): void {
    for (const area of this.areas.values()) {
      for (const f of area.floors) f.mesh.dispose();
      for (const p of area.props) this.disposeProp(p.visual);
      for (const ps of area.ambience) disposeParticles(ps);
    }
    for (const wall of this.walls.values()) wall.mesh.dispose();
    for (const door of this.doors.values()) this.disposeDoor(door);
    for (const stairs of this.stairs.values()) this.disposeStairs(stairs);
    this.areas.clear();
    this.walls.clear();
    this.doors.clear();
    this.stairs.clear();
    this.knownTiles.clear();
    this.veil.setEnabled(false);
    this.lightCandidates = [];
  }

  /**
   * Builds an area. With `revealFrom` the area assembles itself in a wave starting
   * at that tile (discovery moment, concept §19); otherwise it appears instantly.
   */
  async addArea(area: AreaView, view: GameView, revealFrom?: Position): Promise<void> {
    if (this.areas.has(area.id)) return;
    const style = THEMES[area.theme];
    const levelNode = this.levelNode(area.level);
    for (const t of area.tiles) this.knownTiles.set(posKey(t), area.id);
    const visual: AreaVisual = {
      id: area.id,
      theme: area.theme,
      level: area.level,
      tiles: area.tiles,
      floors: [],
      props: [],
      lights: [],
      particles: [],
      ambience: [],
    };
    this.areas.set(area.id, visual);
    this.fitVeil(view);

    // Floors (parquet with its frieze along the walls, or random tiles) and foundation blocks.
    const board = new Board(view);
    const inArea = new Set(area.tiles.map(posKey));
    const isWall = (p: Position, dir: Direction) => board.isWall(p, step(p, dir));
    for (const t of area.tiles) {
      let floor: AbstractMesh;
      if (style.parquet) {
        floor = this.parquet.tile(`parquet-${posKey(t)}`);
        const frieze = this.parquet.frieze(t, isWall, inArea);
        if (frieze) frieze.parent = floor;
      } else {
        floor = this.assets.instance(pick(style.floors, tileNoise(t.x, t.y, 1)));
        floor.rotation.y = Math.floor(tileNoise(t.x, t.y, 2) * 4) * (Math.PI / 2);
      }
      floor.parent = levelNode;
      floor.position = tileCenter(t);
      const base = this.foundation.createInstance(`foundation-${posKey(t)}`);
      base.parent = floor;
      base.position.y = -1.4;
      visual.floors.push({ mesh: floor, pos: t });
    }

    // Walls on every edge the rules consider a wall (derived, never stored). Edges
    // towards a flight or the hole of its stairwell get a low rail instead, so stairs
    // stay visible from every side.
    const stairCells = new Set(
      view.stairs.flatMap((s) => {
        const shaft = stairsShaft(s);
        return [posKey(shaft), posKey({ ...shaft, level: s.top.level })];
      }),
    );
    const newWalls: WallVisual[] = [];
    for (const t of area.tiles) {
      for (const dir of DIRECTIONS) {
        const n = step(t, dir);
        if (!board.isWall(t, n)) continue;
        const key = edgeKey(t, n);
        if (this.walls.has(key)) continue;
        const wall = this.createWall(t, dir, style, stairCells.has(posKey(n)));
        wall.mesh.parent = levelNode;
        this.walls.set(key, wall);
        newWalls.push(wall);
      }
    }

    // Props and wall decoration of this area.
    let torchBudget = style.torchLights;
    for (const prop of view.props) {
      if (!propFootprint(prop).every((p) => inArea.has(posKey(p)))) continue;
      const pv = this.props.createProp(prop, area.theme, true);
      pv.root.parent = levelNode;
      pv.casters.forEach((m) => this.world.addShadowCaster(m));
      visual.props.push({ visual: pv, pos: prop.position, decor: false });
    }
    for (const decor of view.wallDecor) {
      if (!inArea.has(posKey(decor.position))) continue;
      const withLight = decor.kind === 'torch' && torchBudget-- > 0;
      const dv = this.props.createWallDecor(decor, area.theme, withLight);
      dv.root.parent = levelNode;
      const wall = this.walls.get(edgeKey(decor.position, step(decor.position, decor.wall)));
      wall?.decor.push(dv);
      visual.props.push({ visual: dv, pos: decor.position, decor: true });
    }
    for (const { visual: pv } of visual.props) {
      visual.lights.push(...pv.lights);
      visual.particles.push(...pv.particles);
    }

    // Theme ambience.
    if (area.theme === 'crypt' || area.theme === 'mage') {
      const xs = area.tiles.map((t) => t.x);
      const ys = area.tiles.map((t) => t.y);
      const floorY = levelY(area.level);
      const min = new Vector3(Math.min(...xs) * CELL - 1, floorY + 0.2, Math.min(...ys) * CELL - 1);
      const max = new Vector3(Math.max(...xs) * CELL + 1, floorY + (area.theme === 'crypt' ? 1.2 : 5), Math.max(...ys) * CELL + 1);
      visual.ambience.push(
        area.theme === 'crypt'
          ? this.effects.groundFog(min, max, new Color4(0.5, 0.78, 0.62, 0.2))
          : this.effects.sparkles(Vector3.Center(min, max), new Color4(0.7, 0.6, 1, 0.8), new Color4(0.4, 0.8, 1, 0.6), (max.x - min.x) / 2, 14),
      );
      visual.particles.push(...visual.ambience);
    }

    this.ensureDoors(view);
    this.ensureStairs(view);
    this.updateCutaway(false);
    if (revealFrom) await this.playReveal(visual, newWalls, revealFrom);
  }

  /** Creates visuals for doors that became known. */
  ensureDoors(view: GameView): void {
    for (const door of view.doors) {
      if (!this.doors.has(door.id)) this.doors.set(door.id, this.createDoor(door));
    }
  }

  /** Creates visuals for stairs that became known. */
  ensureStairs(view: GameView): void {
    // Judge from the whole view, not knownTiles: a snapshot rebuild adds areas one by one.
    const viewTiles = new Set(view.areas.flatMap((a) => a.tiles.map(posKey)));
    for (const stairs of view.stairs) {
      let visual = this.stairs.get(stairs.id);
      if (!visual) {
        visual = this.createStairs(stairs, viewTiles.has(posKey(stairs.bottom)));
        this.stairs.set(stairs.id, visual);
      }
      this.ensureStairsMarkers(visual);
    }
    this.refreshVisibility();
  }

  /** Lets the omen of unexplored stairs swell for a moment (first approach). */
  swellOmen(id: StairsId): void {
    for (const ps of this.stairs.get(id)?.omen ?? []) {
      const base = ps.emitRate;
      void tween(this.world.scene, 2200, (t) => (ps.emitRate = base * (6 - 5 * t)), ease.inQuad);
    }
  }

  async setDoorOpen(id: DoorId, animate: boolean): Promise<void> {
    const door = this.doors.get(id);
    if (!door || door.open) return;
    door.open = true;
    door.highlighted = false;
    for (const ps of door.mystery) ps.stop();
    const center = this.doorCenter(door.view);
    if (animate) {
      if (door.view.style === 'arcane') {
        this.effects.burst(center.add(new Vector3(0, 1.5, 0)), new Color4(0.8, 0.6, 1, 1), new Color4(0.3, 0.4, 1, 1), 70, 4, 0.5);
      }
      this.effects.dust(center);
      await tween(this.world.scene, 950, (t) => door.leaves.forEach((leaf) => (leaf.rotation.y = 1.8 * t)), ease.outBack);
    } else {
      door.leaves.forEach((leaf) => (leaf.rotation.y = 1.8));
    }
    for (const m of door.pickMeshes) m.isPickable = false;
  }

  /** Explored stairs lose their mystery wisps; the far level is revealed separately. */
  async setStairsExplored(id: StairsId, animate: boolean): Promise<void> {
    const stairs = this.stairs.get(id);
    if (!stairs || stairs.explored) return;
    stairs.explored = true;
    stairs.highlighted = false;
    stairs.material.emissiveColor = STAIRS_EMISSIVE.clone();
    this.refreshVisibility();
    if (animate) {
      const center = this.stairsCenter(stairs.view);
      this.effects.dust(center);
      this.effects.burst(center, new Color4(1, 0.85, 0.5, 1), new Color4(0.6, 0.45, 0.3, 1), 50, 3, 0.4);
      await wait(this.world.scene, 500);
    }
  }

  /** Doors the local player may open right now pulse golden. */
  setOpenableDoors(ids: ReadonlySet<DoorId>): void {
    for (const [id, door] of this.doors) {
      door.highlighted = !door.open && ids.has(id);
      if (!door.highlighted) door.materials.forEach((m) => (m.emissiveColor = door.baseEmissive.clone()));
    }
  }

  /** Stairs the local player may explore right now pulse golden as well. */
  setExplorableStairs(ids: ReadonlySet<StairsId>): void {
    for (const [id, stairs] of this.stairs) {
      stairs.highlighted = !stairs.explored && ids.has(id);
      if (!stairs.highlighted) stairs.material.emissiveColor = STAIRS_EMISSIVE.clone();
    }
  }

  doorFromMesh(mesh: AbstractMesh | null | undefined): DoorId | undefined {
    const id = mesh?.metadata?.doorId as DoorId | undefined;
    return id && this.doors.has(id) && !this.doors.get(id)!.open ? id : undefined;
  }

  stairsFromMesh(mesh: AbstractMesh | null | undefined): StairsId | undefined {
    const id = mesh?.metadata?.stairsId as StairsId | undefined;
    return id && this.stairs.has(id) ? id : undefined;
  }

  doorCenter(door: { edges: DoorView['edges'] }): Vector3 {
    const sum = new Vector3();
    for (const [a, b] of door.edges) sum.addInPlace(Vector3.Center(tileCenter(a), tileCenter(b)));
    return sum.scale(1 / door.edges.length);
  }

  /** Middle of the flight, half way between the two floors. */
  stairsCenter(stairs: Pick<StairsView, 'bottom' | 'direction'>): Vector3 {
    return tileCenter(stairsShaft(stairs), LEVEL_HEIGHT / 2);
  }

  areaCenter(id: string): Vector3 | undefined {
    const area = this.areas.get(id);
    if (!area) return undefined;
    const sum = new Vector3();
    for (const t of area.tiles) sum.addInPlace(tileCenter(t));
    return sum.scale(1 / area.tiles.length);
  }

  /**
   * Walls between the camera and a known tile are lowered so the board stays
   * visible; walls with unknown space behind them stay tall as a backdrop.
   * All walls below the focus level are lowered, so that level reads like a plan.
   */
  updateCutaway(animate: boolean): void {
    const c = this.world.viewDirection();
    const focus = this.world.focusLevel;
    for (const wall of this.walls.values()) {
      if (wall.parapet) continue;
      const dx = wall.neighbour.x - wall.tile.x;
      const dz = wall.neighbour.y - wall.tile.y;
      const bothKnown = this.knownTiles.has(posKey(wall.neighbour));
      const low = wall.tile.level < focus || bothKnown || dx * c.x + dz * c.z > 0;
      if (low === wall.low) continue;
      wall.low = low;
      const target = low ? LOW_WALL : 1;
      if (animate) {
        const from = wall.mesh.scaling.y;
        void tween(this.world.scene, 320, (t) => (wall.mesh.scaling.y = from + (target - from) * t), ease.inOutCubic);
      } else {
        wall.mesh.scaling.y = target;
      }
    }
    this.refreshVisibility();
  }

  // -------------------------------------------------------------- storeys

  private levelNode(level: number): TransformNode {
    let node = this.levelNodes.get(level);
    if (!node) {
      node = new TransformNode(`level:${level}`, this.world.scene);
      this.levelNodes.set(level, node);
    }
    return node;
  }

  private isLevelShown(level: number): boolean {
    return level <= this.world.focusLevel;
  }

  /**
   * Single source of truth for what renders: level nodes, lights and particles
   * (both live outside the node hierarchy's enabled state) and the veil. Storeys
   * below the focus level stay visible under the veil, but without flames, particles
   * or lights, so nothing glows through and the eye stays on the focus level.
   */
  private refreshVisibility(): void {
    const focus = this.world.focusLevel;
    for (const [level, node] of this.levelNodes) node.setEnabled(this.isLevelShown(level));
    const decorShown = new Map<PropVisual, boolean>();
    for (const wall of this.walls.values()) {
      for (const d of wall.decor) decorShown.set(d, this.isLevelShown(wall.tile.level) && !wall.low);
    }
    this.lightCandidates = [];
    for (const area of this.areas.values()) {
      const shown = this.isLevelShown(area.level);
      const active = area.level === focus;
      for (const { visual, decor } of area.props) {
        const on = decor ? (decorShown.get(visual) ?? shown) : shown;
        if (decor) visual.root.setEnabled(on);
        for (const light of visual.lights) {
          if (on && active) this.lightCandidates.push(light);
          else enableLight(light, false);
        }
        for (const ps of visual.particles) run(ps, on && active);
        for (const flame of visual.flames) flame.setEnabled(active);
        this.muteGlow(visual, area.level < focus);
      }
      for (const ps of area.ambience) run(ps, active);
    }
    this.applyLightBudget();
    for (const door of this.doors.values()) {
      for (const ps of door.mystery) run(ps, !door.open && door.level === focus);
    }
    for (const stairs of this.stairs.values()) {
      for (const ps of stairs.omen) run(ps, !stairs.explored && stairs.omenLevel === focus);
    }
    this.veil.setEnabled([...this.areas.values()].some((a) => a.level < focus));
    this.veil.position.y = levelY(focus) - VEIL_DEPTH;
    this.rebuildVeil(focus);
  }

  /**
   * Keeps only the point lights nearest to the camera target on. Their number stays
   * constant, so swapping them never compiles new shaders.
   */
  private applyLightBudget(): void {
    const target = this.world.camera.target;
    this.lastLightTarget.copyFrom(target);
    const ranked = this.lightCandidates
      .map((light) => ({ light, distance: Vector3.Distance(lightWorldPosition(light), target) }))
      .sort((a, b) => a.distance - b.distance);
    ranked.forEach(({ light }, i) => enableLight(light, i < MAX_POINT_LIGHTS));
  }

  /** The glow layer is drawn after the veil, so glowing props below the focus level are excluded from it. */
  private muteGlow(visual: PropVisual, mute: boolean): void {
    if (mute === this.glowMuted.has(visual)) return;
    for (const mesh of visual.root.getChildMeshes(false)) {
      if (mute) this.world.glow.addExcludedMesh(mesh as Mesh);
      else this.world.glow.removeExcludedMesh(mesh as Mesh);
    }
    if (mute) this.glowMuted.add(visual);
    else this.glowMuted.delete(visual);
  }

  private fitVeil(view: GameView): void {
    this.veilSize = { width: view.width, height: view.height };
    this.veilKey = '';
  }

  /**
   * The veil dims the storeys below the focus level. It covers the board plus a
   * margin, leaving out the stairwells of the focus level so flights going down stay
   * fully visible. Built from a few rectangles: full-width bands between hole rows and
   * runs within them, so its size depends on the number of holes, not the board area.
   */
  private rebuildVeil(focus: number): void {
    if (!this.veil.isEnabled(false)) return;
    const holes = [...this.stairs.values()].filter((s) => s.view.top.level === focus).map((s) => stairsShaft(s.view));
    const key = `${this.veilSize.width}x${this.veilSize.height}:${holes.map((h) => `${h.x},${h.y}`).join(';')}`;
    if (key === this.veilKey) return;
    this.veilKey = key;

    const margin = 3;
    const [x0, x1, y0, y1] = [-margin, this.veilSize.width + margin, -margin, this.veilSize.height + margin];
    const positions: number[] = [];
    const indices: number[] = [];
    // Rectangle over the cells [xa, xb) × [ya, yb).
    const rect = (xa: number, xb: number, ya: number, yb: number) => {
      if (xa >= xb || ya >= yb) return;
      const i = positions.length / 3;
      const [l, r, t, b] = [(xa - 0.5) * CELL, (xb - 0.5) * CELL, (ya - 0.5) * CELL, (yb - 0.5) * CELL];
      positions.push(l, 0, t, r, 0, t, r, 0, b, l, 0, b);
      indices.push(i, i + 1, i + 2, i, i + 2, i + 3);
    };
    const rows = new Map<number, number[]>();
    for (const h of holes) rows.set(h.y, [...(rows.get(h.y) ?? []), h.x]);
    let y = y0;
    for (const row of [...rows.keys()].filter((r) => r >= y0 && r < y1).sort((a, b) => a - b)) {
      rect(x0, x1, y, row);
      let x = x0;
      for (const hole of rows.get(row)!.sort((a, b) => a - b)) {
        rect(x, hole, row, row + 1);
        x = Math.max(x, hole + 1);
      }
      rect(x, x1, row, row + 1);
      y = row + 1;
    }
    rect(x0, x1, y, y1);

    const data = new VertexData();
    data.positions = positions;
    data.indices = indices;
    data.normals = positions.map((_, i) => (i % 3 === 1 ? 1 : 0));
    data.applyToMesh(this.veil, true);
  }

  // -------------------------------------------------------------- building

  private createWall(tile: Position, dir: Direction, style: ThemeStyle, parapet: boolean): WallVisual {
    const neighbour = step(tile, dir);
    const model = pick(style.walls, tileNoise(tile.x * 3 + neighbour.x, tile.y * 3 + neighbour.y, 3));
    const mesh = this.assets.instance(model);
    mesh.position = Vector3.Center(tileCenter(tile), tileCenter(neighbour));
    mesh.rotation.y = facingAngle(OPPOSITE[dir]);
    if (parapet) mesh.scaling.y = PARAPET;
    this.world.addShadowCaster(mesh);
    return { tile, neighbour, mesh, decor: [], parapet, low: parapet };
  }

  private createDoor(view: DoorView): DoorVisual {
    const frames: TransformNode[] = [];
    const leaves: TransformNode[] = [];
    const pickMeshes: Mesh[] = [];
    const materials: StandardMaterial[] = [];
    const mystery: ParticleSystem[] = [];
    const level = view.edges[0]![0].level;
    const levelNode = this.levelNode(level);
    const tint = { grand: new Color3(1, 0.95, 0.9), iron: new Color3(0.6, 0.61, 0.64), arcane: new Color3(0.75, 0.55, 1.15) }[view.style];
    const baseEmissive = view.style === 'arcane' ? new Color3(0.22, 0.08, 0.42) : Color3.Black();
    const centers = view.edges.map(([a, b]) => Vector3.Center(tileCenter(a), tileCenter(b)));
    const doorCenter = this.doorCenter(view);

    view.edges.forEach(([a, b], i) => {
      // Face the frame towards the side that is already known.
      const [inside, outside] = this.knownTiles.has(posKey(a)) ? [a, b] : [b, a];
      const frame = this.assets.hierarchy('wall_doorway');
      frame.parent = levelNode;
      frames.push(frame);
      frame.position = centers[i]!;
      frame.rotation.y = facingAngle(directionTo(outside, inside));
      if (view.edges.length > 1) frame.scaling.y = 1.12;
      const leafMesh = frame.getChildMeshes(false).find((m) => m.name.includes('wall_doorway_door'));
      const frameMesh = frame.getChildMeshes(false).find((m) => !m.name.includes('wall_doorway_door'));
      if (frameMesh) {
        frameMesh.receiveShadows = true;
        this.world.addShadowCaster(frameMesh);
      }
      if (leafMesh) {
        leafMesh.rotationQuaternion = null;
        const mat = (leafMesh.material as StandardMaterial).clone(`door-${view.id}-${i}`);
        mat.diffuseColor = tint;
        mat.emissiveColor = baseEmissive.clone();
        leafMesh.material = mat;
        materials.push(mat);
        leaves.push(leafMesh);
        this.world.addShadowCaster(leafMesh);
        // Double doors: hinges belong on the outer sides.
        if (view.edges.length > 1) {
          frame.computeWorldMatrix(true);
          leafMesh.computeWorldMatrix(true);
          const hinge = leafMesh.getAbsolutePosition();
          if (Vector3.Distance(hinge, doorCenter) < Vector3.Distance(centers[i]!, doorCenter)) frame.scaling.x = -1;
        }
      }
      const pickBox = MeshBuilder.CreateBox(`door-pick-${view.id}-${i}`, { width: 3.4, height: 3.6, depth: 1.2 }, this.world.scene);
      pickBox.parent = levelNode;
      pickBox.position = centers[i]!.add(new Vector3(0, 1.8, 0));
      pickBox.rotation.y = frame.rotation.y;
      pickBox.isVisible = false;
      pickBox.metadata = { doorId: view.id, pick: true };
      pickMeshes.push(pickBox);

      if (!view.open) {
        const toward = tileCenter(inside).subtract(tileCenter(outside)).normalize();
        const origin = centers[i]!.add(toward.scale(0.7));
        mystery.push(this.effects.doorWisps(origin, toward));
      }
    });

    const visual: DoorVisual = { view, level, frames, leaves, materials, baseEmissive, pickMeshes, mystery, open: false, highlighted: false };
    if (view.open) {
      visual.open = true;
      leaves.forEach((leaf) => (leaf.rotation.y = 1.8));
      pickMeshes.forEach((m) => (m.isPickable = false));
      mystery.forEach((ps) => ps.stop());
    }
    return visual;
  }

  /**
   * The connection on the shaft tile, from the floor of the lower level to the floor
   * of the upper one: a solid stone flight or a wooden ladder.
   * `fromBelow`: the foot is the known end (the stairs lead up into the unknown).
   */
  private createStairs(view: StairsView, fromBelow: boolean): StairsVisual {
    const scene = this.world.scene;
    const root = new TransformNode(`stairs:${view.id}`, scene);
    root.parent = this.levelNode(view.bottom.level);
    root.position = tileCenter(stairsShaft(view));
    root.rotation.y = facingAngle(view.direction); // local +Z points up the flight

    const ladder = view.style === 'ladder';
    const flight = ladder ? this.buildLadder(view, root) : this.buildFlight(view);
    flight.name = `stairs-flight-${view.id}`;
    const material = (ladder ? this.ladderMaterial : this.stairsMaterial).clone(`stairs-${view.id}`);
    flight.material = material;
    flight.parent = root;
    flight.isPickable = false;
    // Down in a stairwell the flight would sit in the floor's shadow and vanish.
    flight.receiveShadows = false;
    this.world.addShadowCaster(flight);

    const pickMesh = MeshBuilder.CreateBox(`stairs-pick-${view.id}`, { width: CELL, height: LEVEL_HEIGHT, depth: CELL }, scene);
    pickMesh.parent = root;
    pickMesh.position.y = LEVEL_HEIGHT / 2;
    pickMesh.isVisible = false;
    pickMesh.metadata = { stairsId: view.id, pick: true };

    const omen: ParticleSystem[] = [];
    if (!view.explored) {
      const shaft = stairsShaft(view);
      omen.push(
        fromBelow
          ? this.effects.starfall(tileCenter(shaft, LEVEL_HEIGHT * 0.9))
          : this.effects.coldBreath(tileCenter({ ...shaft, level: view.top.level }, -1.6)),
      );
    }
    const omenLevel = fromBelow ? view.bottom.level : view.top.level;
    return { view, root, material, pickMesh, omen, omenLevel, markers: new Map(), explored: view.explored, highlighted: false };
  }

  /** Solid stone steps filling the shaft tile (≈56°, one tile long). */
  private buildFlight(view: StairsView): Mesh {
    const tread = CELL / STAIR_STEPS;
    const rise = LEVEL_HEIGHT / STAIR_STEPS;
    const blocks: Mesh[] = [];
    for (let i = 0; i < STAIR_STEPS; i++) {
      const height = (i + 1) * rise;
      const block = MeshBuilder.CreateBox(`stairs-step-${view.id}-${i}`, { width: CELL - 0.7, height, depth: tread }, this.world.scene);
      block.position.set(0, height / 2, -CELL / 2 + tread * (i + 0.5));
      blocks.push(block);
    }
    return Mesh.MergeMeshes(blocks, true)!;
  }

  /**
   * A wooden ladder leaning against the rim of the landing at 75° (see LADDER_RUN), its rails
   * reaching above the upper floor as grips. Unlike a flight it leaves the shaft tile
   * open, so that tile gets a floor of its own on the lower level.
   */
  private buildLadder(view: StairsView, root: TransformNode): Mesh {
    const scene = this.world.scene;
    const floor = this.assets.instance('floor_tile_large');
    floor.parent = root;
    const base = this.foundation.createInstance(`foundation-ladder-${view.id}`);
    base.parent = floor;
    base.position.y = -1.4;

    // Axis of the ladder (local +Z towards the landing), its back resting on the rim.
    const axis = new Vector3(0, LEVEL_HEIGHT, LADDER_RUN).normalize();
    const tilt = Quaternion.FromUnitVectorsToRef(Vector3.Up(), axis, new Quaternion());
    const foot = new Vector3(0, 0, CELL / 2 - LADDER_RUN - LADDER_RAIL.depth / 2);
    const at = (height: number) => foot.add(axis.scale(height / axis.y));
    const paint = (mesh: Mesh, hex: string) => {
      const c = Color3.FromHexString(hex);
      const colors: number[] = [];
      for (let i = 0; i < mesh.getTotalVertices(); i++) colors.push(c.r, c.g, c.b, 1);
      mesh.setVerticesData(VertexBuffer.ColorKind, colors);
      return mesh;
    };

    const parts: Mesh[] = [];
    const railTop = LEVEL_HEIGHT + LADDER_GRIP;
    const railX = LADDER_WIDTH / 2 - LADDER_RAIL.width / 2;
    for (const side of [-1, 1]) {
      const rail = MeshBuilder.CreateBox(
        `ladder-rail-${view.id}`,
        { width: LADDER_RAIL.width, height: railTop / axis.y, depth: LADDER_RAIL.depth },
        scene,
      );
      rail.rotationQuaternion = tilt.clone();
      rail.position = at(railTop / 2).add(new Vector3(side * railX, 0, 0));
      parts.push(paint(rail, '#6d5440'));
      // Iron strap holding the rail at the rim.
      const strap = MeshBuilder.CreateBox(`ladder-strap-${view.id}`, { width: LADDER_RAIL.width + 0.08, height: 0.1, depth: LADDER_RAIL.depth + 0.08 }, scene);
      strap.rotationQuaternion = tilt.clone();
      strap.position = at(LEVEL_HEIGHT - 0.15).add(new Vector3(side * railX, 0, 0));
      parts.push(paint(strap, '#34353a'));
    }
    const rungLength = LADDER_WIDTH - LADDER_RAIL.width;
    for (let height = LADDER_RUNG_SPACING; height < LEVEL_HEIGHT - 0.2; height += LADDER_RUNG_SPACING) {
      const rung = MeshBuilder.CreateCylinder(`ladder-rung-${view.id}`, { height: rungLength, diameter: 0.14, tessellation: 8 }, scene);
      rung.rotation.z = Math.PI / 2;
      rung.position = at(height);
      parts.push(paint(rung, '#9c7452'));
    }
    return Mesh.MergeMeshes(parts, true)!;
  }

  /** Foot and landing get a floor marker pointing at the flight once their tile is known. */
  private ensureStairsMarkers(visual: StairsVisual): void {
    const { view } = visual;
    for (const [end, toward] of [
      [view.bottom, view.direction],
      [view.top, OPPOSITE[view.direction]],
    ] as const) {
      const key = posKey(end);
      if (visual.markers.has(key) || !this.knownTiles.has(key)) continue;
      const marker = MeshBuilder.CreateGround(`stairs-marker-${view.id}-${key}`, { width: CELL * 0.8, height: CELL * 0.8 }, this.world.scene);
      marker.material = this.markerMaterial();
      marker.parent = this.levelNode(end.level);
      marker.position = tileCenter(end, 0.04);
      marker.rotation.y = facingAngle(toward);
      marker.isPickable = false;
      this.world.glow.addExcludedMesh(marker);
      visual.markers.set(key, marker);
    }
  }

  /** Two chevrons pointing along local +Z inside a soft frame (unlit, translucent). */
  private markerMaterial(): StandardMaterial {
    if (this.stairsMarkerMaterial) return this.stairsMarkerMaterial;
    const size = 128;
    const tex = new DynamicTexture('stairs-marker', { width: size, height: size }, this.world.scene, true);
    const ctx = tex.getContext() as CanvasRenderingContext2D;
    ctx.clearRect(0, 0, size, size);
    ctx.strokeStyle = 'rgba(255,255,255,0.55)';
    ctx.lineWidth = 5;
    ctx.beginPath();
    ctx.roundRect(10, 10, size - 20, size - 20, 20);
    ctx.stroke();
    ctx.strokeStyle = 'rgba(255,255,255,1)';
    ctx.lineWidth = 10;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (const y of [46, 78]) {
      ctx.beginPath();
      ctx.moveTo(36, y + 14);
      ctx.lineTo(64, y - 10);
      ctx.lineTo(92, y + 14);
      ctx.stroke();
    }
    tex.hasAlpha = true;
    tex.update();
    const mat = new StandardMaterial('stairs-marker', this.world.scene);
    mat.disableLighting = true;
    mat.diffuseColor = Color3.Black();
    mat.emissiveColor = new Color3(1, 0.82, 0.42);
    mat.opacityTexture = tex;
    mat.alpha = 0.75;
    mat.zOffset = -1;
    this.stairsMarkerMaterial = mat;
    return mat;
  }

  private animateHighlights(): void {
    this.highlightTime += this.world.engine.getDeltaTime() / 1000;
    const pulse = 0.5 + 0.5 * Math.sin(this.highlightTime * 4);
    const glow = new Color3(0.55, 0.38, 0.06).scale(0.35 + 0.65 * pulse);
    for (const door of this.doors.values()) {
      if (!door.highlighted) continue;
      for (const m of door.materials) m.emissiveColor = door.baseEmissive.add(glow);
    }
    for (const stairs of this.stairs.values()) {
      if (stairs.highlighted) stairs.material.emissiveColor = STAIRS_EMISSIVE.add(glow);
    }
  }

  private async playReveal(visual: AreaVisual, walls: WallVisual[], origin: Position): Promise<void> {
    const scene = this.world.scene;
    const dist = (p: Position) => Math.abs(p.x - origin.x) + Math.abs(p.y - origin.y);
    const jobs: Promise<void>[] = [];
    let maxDelay = 0;

    for (const ps of visual.particles) ps.stop();
    for (const l of visual.lights) l.metadata = { fade: 0 };
    for (const l of visual.lights) l.intensity = 0;

    for (const { mesh, pos } of visual.floors) {
      const delay = dist(pos) * STAGGER_MS;
      maxDelay = Math.max(maxDelay, delay);
      const baseY = mesh.position.y;
      mesh.scaling.setAll(0.001);
      mesh.position.y = baseY - 2.5;
      jobs.push(
        tween(scene, 450, (t) => {
          mesh.scaling.setAll(Math.max(0.001, t));
          mesh.position.y = baseY - 2.5 * (1 - t);
        }, ease.outBack, delay),
      );
    }
    for (const wall of walls) {
      const target = wall.mesh.scaling.y;
      const delay = 160 + Math.min(dist(wall.tile), dist(wall.neighbour)) * STAGGER_MS;
      wall.mesh.scaling.y = 0.001;
      jobs.push(tween(scene, 420, (t) => (wall.mesh.scaling.y = Math.max(0.001, target * t)), ease.outBack, delay));
    }
    for (const { visual: pv, pos } of visual.props) {
      const root = pv.root;
      const delay = 380 + dist(pos) * STAGGER_MS;
      const baseY = root.position.y;
      const scale = root.scaling.clone();
      root.position.y = baseY + 7;
      root.scaling = scale.scale(0.001);
      jobs.push(
        tween(scene, 650, (t) => {
          root.position.y = baseY + 7 * (1 - t);
          root.scaling = scale.scale(Math.max(0.001, Math.min(1, t * 1.6)));
        }, ease.outBounce, delay),
      );
    }
    const lightDelay = 450 + maxDelay * 0.6;
    jobs.push(
      tween(scene, 1100, (t) => {
        for (const l of visual.lights) l.metadata = { fade: t };
      }, ease.inOutCubic, lightDelay),
    );
    await wait(scene, lightDelay);
    this.refreshVisibility();
    await Promise.all(jobs);
    this.updateCutaway(false);
  }

  private disposeProp(visual: PropVisual): void {
    this.muteGlow(visual, false); // the glow layer does not forget excluded meshes on dispose
    for (const p of visual.particles) disposeParticles(p);
    for (const l of visual.lights) l.dispose();
    visual.root.dispose(false, false);
  }

  private disposeDoor(door: DoorVisual): void {
    for (const ps of door.mystery) disposeParticles(ps);
    for (const m of door.pickMeshes) m.dispose();
    for (const frame of door.frames) frame.dispose();
    for (const m of door.materials) m.dispose();
  }

  private disposeStairs(stairs: StairsVisual): void {
    for (const ps of stairs.omen) disposeParticles(ps);
    for (const m of stairs.markers.values()) m.dispose();
    stairs.root.dispose(false, false);
    stairs.material.dispose();
  }
}
