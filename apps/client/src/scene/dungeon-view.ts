import {
  Color3,
  Color4,
  Mesh,
  MeshBuilder,
  StandardMaterial,
  TransformNode,
  Vector3,
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
  step,
  type AreaView,
  type Direction,
  type DoorId,
  type DoorView,
  type GameView,
  type Position,
  type ThemeId,
} from '@dungeon/shared';
import type { AssetLibrary, DungeonModel } from './assets.ts';
import type { Effects } from './effects.ts';
import { CELL, OPPOSITE, facingAngle, tileCenter, tileNoise } from './grid.ts';
import { PropFactory, type PropVisual } from './props.ts';
import { ease, tween, wait } from './tween.ts';
import type { World } from './world.ts';

/** Visual style per theme: same geometry, different look (concept §11). */
interface ThemeStyle {
  readonly floors: readonly [DungeonModel, number][];
  readonly walls: readonly [DungeonModel, number][];
  /** How many torches of this area get a real point light (GPU light budget). */
  readonly torchLights: number;
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
    floors: [
      ['floor_wood_large', 0.7],
      ['floor_wood_large_dark', 0.3],
    ],
    walls: [
      ['wall', 0.7],
      ['wall_arched', 0.3],
    ],
    torchLights: 1,
  },
};

const LOW_WALL = 0.2;
const STAGGER_MS = 55;

function pick(options: readonly [DungeonModel, number][], r: number): DungeonModel {
  let acc = 0;
  for (const [model, weight] of options) {
    acc += weight;
    if (r < acc) return model;
  }
  return options[options.length - 1]![0];
}

interface AreaVisual {
  readonly id: string;
  readonly theme: ThemeId;
  readonly tiles: readonly Position[];
  readonly floors: { mesh: AbstractMesh; pos: Position }[];
  readonly props: { visual: PropVisual; pos: Position }[];
  readonly lights: PointLight[];
  readonly particles: ParticleSystem[];
}

interface WallVisual {
  readonly tile: Position;
  readonly neighbour: Position;
  readonly mesh: AbstractMesh;
  readonly decor: PropVisual[];
  low: boolean;
}

interface DoorVisual {
  readonly view: DoorView;
  readonly leaves: TransformNode[];
  readonly materials: StandardMaterial[];
  readonly baseEmissive: Color3;
  readonly pickMeshes: Mesh[];
  mystery: ParticleSystem[];
  open: boolean;
  highlighted: boolean;
}

/**
 * Turns the (filtered) dungeon data into a 3D board: floors, derived walls,
 * doors, props, decoration, lights. Handles the discovery animation and the
 * camera-dependent wall cutaway.
 */
export class DungeonView {
  private readonly areas = new Map<string, AreaVisual>();
  private readonly walls = new Map<string, WallVisual>();
  private readonly doors = new Map<DoorId, DoorVisual>();
  private readonly knownTiles = new Map<string, string>();
  private readonly props: PropFactory;
  private readonly foundation: Mesh;
  private highlightTime = 0;

  constructor(
    private readonly world: World,
    private readonly assets: AssetLibrary,
    private readonly effects: Effects,
  ) {
    this.props = new PropFactory(world.scene, assets, effects);
    this.foundation = MeshBuilder.CreateBox('foundation', { width: CELL, height: 2.6, depth: CELL }, world.scene);
    const mat = new StandardMaterial('foundation', world.scene);
    mat.diffuseColor = new Color3(0.13, 0.1, 0.2);
    mat.specularColor = Color3.Black();
    mat.emissiveColor = new Color3(0.02, 0.01, 0.04);
    this.foundation.material = mat;
    this.foundation.isVisible = false;
    this.foundation.isPickable = false;

    for (const model of ['floor_tile_large', 'floor_tile_big_grate', 'floor_tile_large_rocks', 'floor_dirt_large', 'floor_wood_large', 'floor_wood_large_dark', 'wall', 'wall_arched', 'wall_cracked', 'wall_broken'] as const) {
      assets.sourceMesh(model).receiveShadows = true;
    }

    world.onViewRotated.add(() => this.updateCutaway(true));
    world.scene.onBeforeRenderObservable.add(() => this.animateHighlights());
  }

  hasArea(id: string): boolean {
    return this.areas.has(id);
  }

  clear(): void {
    for (const area of this.areas.values()) {
      for (const f of area.floors) f.mesh.dispose();
      for (const p of area.props) this.disposeProp(p.visual);
      for (const l of area.lights) l.dispose();
      for (const ps of area.particles) ps.dispose();
    }
    for (const wall of this.walls.values()) {
      wall.mesh.dispose();
      for (const d of wall.decor) this.disposeProp(d);
    }
    for (const door of this.doors.values()) this.disposeDoor(door);
    this.areas.clear();
    this.walls.clear();
    this.doors.clear();
    this.knownTiles.clear();
  }

  /**
   * Builds an area. With `revealFrom` the area assembles itself in a wave starting
   * at that tile (discovery moment, concept §19); otherwise it appears instantly.
   */
  async addArea(area: AreaView, view: GameView, revealFrom?: Position): Promise<void> {
    if (this.areas.has(area.id)) return;
    const style = THEMES[area.theme];
    for (const t of area.tiles) this.knownTiles.set(posKey(t), area.id);
    const visual: AreaVisual = { id: area.id, theme: area.theme, tiles: area.tiles, floors: [], props: [], lights: [], particles: [] };
    this.areas.set(area.id, visual);

    // Floors and foundation blocks.
    for (const t of area.tiles) {
      const floor = this.assets.instance(pick(style.floors, tileNoise(t.x, t.y, 1)));
      floor.position = tileCenter(t);
      floor.rotation.y = Math.floor(tileNoise(t.x, t.y, 2) * 4) * (Math.PI / 2);
      const base = this.foundation.createInstance(`foundation-${posKey(t)}`);
      base.parent = floor;
      base.position.y = -1.4;
      visual.floors.push({ mesh: floor, pos: t });
    }

    // Walls on every edge the rules consider a wall (derived, never stored).
    const board = new Board(view);
    const newWalls: WallVisual[] = [];
    for (const t of area.tiles) {
      for (const dir of DIRECTIONS) {
        const n = step(t, dir);
        if (!board.isWall(t, n)) continue;
        const key = edgeKey(t, n);
        if (this.walls.has(key)) continue;
        const wall = this.createWall(t, dir, style);
        this.walls.set(key, wall);
        newWalls.push(wall);
      }
    }

    // Props and wall decoration of this area.
    const inArea = new Set(area.tiles.map(posKey));
    let torchBudget = style.torchLights;
    for (const prop of view.props) {
      if (!propFootprint(prop).every((p) => inArea.has(posKey(p)))) continue;
      const pv = this.props.createProp(prop, area.theme, true);
      pv.casters.forEach((m) => this.world.addShadowCaster(m));
      visual.props.push({ visual: pv, pos: prop.position });
    }
    for (const decor of view.wallDecor) {
      if (!inArea.has(posKey(decor.position))) continue;
      const withLight = decor.kind === 'torch' && torchBudget-- > 0;
      const dv = this.props.createWallDecor(decor, area.theme, withLight);
      const wall = this.walls.get(edgeKey(decor.position, step(decor.position, decor.wall)));
      wall?.decor.push(dv);
      visual.props.push({ visual: dv, pos: decor.position });
    }
    for (const { visual: pv } of visual.props) {
      visual.lights.push(...pv.lights);
      visual.particles.push(...pv.particles);
    }

    // Theme ambience.
    if (area.theme === 'crypt' || area.theme === 'mage') {
      const xs = area.tiles.map((t) => t.x);
      const ys = area.tiles.map((t) => t.y);
      const min = new Vector3(Math.min(...xs) * CELL - 1, 0.2, Math.min(...ys) * CELL - 1);
      const max = new Vector3(Math.max(...xs) * CELL + 1, area.theme === 'crypt' ? 1.2 : 5, Math.max(...ys) * CELL + 1);
      visual.particles.push(
        area.theme === 'crypt'
          ? this.effects.groundFog(min, max, new Color4(0.55, 0.85, 0.65, 0.14))
          : this.effects.sparkles(Vector3.Center(min, max), new Color4(0.7, 0.6, 1, 0.8), new Color4(0.4, 0.8, 1, 0.6), (max.x - min.x) / 2, 14),
      );
    }

    this.ensureDoors(view);
    this.updateCutaway(false);
    if (revealFrom) await this.playReveal(visual, newWalls, revealFrom);
  }

  /** Creates visuals for doors that became known. */
  ensureDoors(view: GameView): void {
    for (const door of view.doors) {
      if (!this.doors.has(door.id)) this.doors.set(door.id, this.createDoor(door));
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

  /** Doors the local player may open right now pulse golden. */
  setOpenableDoors(ids: ReadonlySet<DoorId>): void {
    for (const [id, door] of this.doors) {
      door.highlighted = !door.open && ids.has(id);
      if (!door.highlighted) door.materials.forEach((m) => (m.emissiveColor = door.baseEmissive.clone()));
    }
  }

  doorFromMesh(mesh: AbstractMesh | null | undefined): DoorId | undefined {
    const id = mesh?.metadata?.doorId as DoorId | undefined;
    return id && this.doors.has(id) && !this.doors.get(id)!.open ? id : undefined;
  }

  doorCenter(door: { edges: DoorView['edges'] }): Vector3 {
    const sum = new Vector3();
    for (const [a, b] of door.edges) sum.addInPlace(Vector3.Center(tileCenter(a), tileCenter(b)));
    return sum.scale(1 / door.edges.length);
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
   */
  updateCutaway(animate: boolean): void {
    const c = this.world.viewDirection();
    for (const wall of this.walls.values()) {
      const dx = wall.neighbour.x - wall.tile.x;
      const dz = wall.neighbour.y - wall.tile.y;
      const bothKnown = this.knownTiles.has(posKey(wall.neighbour));
      const low = bothKnown || dx * c.x + dz * c.z > 0;
      if (low === wall.low) continue;
      wall.low = low;
      for (const d of wall.decor) {
        d.root.setEnabled(!low);
        for (const ps of d.particles) (low ? ps.stop() : ps.start());
      }
      const target = low ? LOW_WALL : 1;
      if (animate) {
        const from = wall.mesh.scaling.y;
        void tween(this.world.scene, 320, (t) => (wall.mesh.scaling.y = from + (target - from) * t), ease.inOutCubic);
      } else {
        wall.mesh.scaling.y = target;
      }
    }
  }

  // -------------------------------------------------------------- building

  private createWall(tile: Position, dir: Direction, style: ThemeStyle): WallVisual {
    const neighbour = step(tile, dir);
    const model = pick(style.walls, tileNoise(tile.x * 3 + neighbour.x, tile.y * 3 + neighbour.y, 3));
    const mesh = this.assets.instance(model);
    mesh.position = Vector3.Center(tileCenter(tile), tileCenter(neighbour));
    mesh.rotation.y = facingAngle(OPPOSITE[dir]);
    this.world.addShadowCaster(mesh);
    return { tile, neighbour, mesh, decor: [], low: false };
  }

  private createDoor(view: DoorView): DoorVisual {
    const leaves: TransformNode[] = [];
    const pickMeshes: Mesh[] = [];
    const materials: StandardMaterial[] = [];
    const mystery: ParticleSystem[] = [];
    const tint = { grand: new Color3(1.05, 0.92, 0.8), iron: new Color3(0.55, 0.62, 0.78), arcane: new Color3(0.75, 0.55, 1.15) }[view.style];
    const baseEmissive = view.style === 'arcane' ? new Color3(0.22, 0.08, 0.42) : Color3.Black();
    const centers = view.edges.map(([a, b]) => Vector3.Center(tileCenter(a), tileCenter(b)));
    const doorCenter = this.doorCenter(view);

    view.edges.forEach(([a, b], i) => {
      // Face the frame towards the side that is already known.
      const [inside, outside] = this.knownTiles.has(posKey(a)) ? [a, b] : [b, a];
      const frame = this.assets.hierarchy('wall_doorway');
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

    const visual: DoorVisual = { view, leaves, materials, baseEmissive, pickMeshes, mystery, open: false, highlighted: false };
    if (view.open) {
      visual.open = true;
      leaves.forEach((leaf) => (leaf.rotation.y = 1.8));
      pickMeshes.forEach((m) => (m.isPickable = false));
      mystery.forEach((ps) => ps.stop());
    }
    return visual;
  }

  private animateHighlights(): void {
    this.highlightTime += this.world.engine.getDeltaTime() / 1000;
    const pulse = 0.5 + 0.5 * Math.sin(this.highlightTime * 4);
    for (const door of this.doors.values()) {
      if (!door.highlighted) continue;
      const glow = new Color3(0.55, 0.38, 0.06).scale(0.35 + 0.65 * pulse);
      for (const m of door.materials) m.emissiveColor = door.baseEmissive.add(glow);
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
      mesh.scaling.setAll(0.001);
      mesh.position.y = -2.5;
      jobs.push(
        tween(scene, 450, (t) => {
          mesh.scaling.setAll(Math.max(0.001, t));
          mesh.position.y = -2.5 * (1 - t);
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
    for (const ps of visual.particles) ps.start();
    await Promise.all(jobs);
    this.updateCutaway(false);
  }

  private disposeProp(visual: PropVisual): void {
    for (const p of visual.particles) p.dispose();
    for (const l of visual.lights) l.dispose();
    visual.root.dispose(false, false);
  }

  private disposeDoor(door: DoorVisual): void {
    for (const ps of door.mystery) ps.dispose();
    for (const m of door.pickMeshes) m.dispose();
    for (const leaf of door.leaves) leaf.parent?.parent?.dispose();
    for (const m of door.materials) m.dispose();
  }
}
