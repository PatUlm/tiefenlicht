import {
  Color3,
  Color4,
  Matrix,
  MeshBuilder,
  StandardMaterial,
  TransformNode,
  Vector3,
  type AnimationGroup,
  type Mesh,
  type Scene,
} from '@babylonjs/core';
import type { CharacterId, Direction, HeroKind, MonsterKind, Position } from '@dungeon/shared';
import type { AssetLibrary, CharacterInstance, CharacterModel, WeaponModel } from './assets.ts';
import type { Effects } from './effects.ts';
import { CELL, angleDelta, facingAngle, tileCenter, yawTowards } from './grid.ts';
import { ease, tween } from './tween.ts';
import type { World } from './world.ts';

interface CharacterStyle {
  readonly model: CharacterModel;
  readonly scale: Vector3;
  readonly hide: readonly string[];
  readonly weapons: readonly [WeaponModel, 'handslot.r' | 'handslot.l'][];
  readonly tint?: Color3;
  readonly baseColor: Color3;
  readonly idle: string;
  readonly walk?: string;
  readonly awaken?: string;
  readonly labelHeight: number;
}

export const HERO_COLORS: Record<HeroKind, string> = { dwarf: '#ff9d3c', darkelf: '#b38cff' };

const STYLES: Record<HeroKind | MonsterKind, CharacterStyle> = {
  dwarf: {
    model: 'Barbarian',
    scale: new Vector3(1.85, 1.46, 1.85),
    hide: ['2H_Axe', 'Mug', '1H_Axe_Offhand'],
    weapons: [],
    baseColor: Color3.FromHexString(HERO_COLORS.dwarf),
    idle: 'Idle',
    walk: 'Walking_A',
    labelHeight: 4.3,
  },
  darkelf: {
    model: 'Rogue_Hooded',
    scale: new Vector3(1.5, 1.75, 1.5),
    hide: ['1H_Crossbow', '2H_Crossbow', 'Throwable'],
    weapons: [],
    tint: new Color3(0.72, 0.58, 1.0),
    baseColor: Color3.FromHexString(HERO_COLORS.darkelf),
    idle: 'Idle',
    walk: 'Walking_A',
    labelHeight: 4.7,
  },
  skeletonWarrior: {
    model: 'Skeleton_Warrior',
    scale: new Vector3(1.65, 1.65, 1.65),
    hide: [],
    weapons: [
      ['Skeleton_Blade', 'handslot.r'],
      ['Skeleton_Shield_Small_A', 'handslot.l'],
    ],
    baseColor: new Color3(0.32, 0.36, 0.3),
    idle: 'Idle_Combat',
    awaken: 'Skeletons_Awaken_Floor_Long',
    labelHeight: 4.3,
  },
  skeletonMinion: {
    model: 'Skeleton_Minion',
    scale: new Vector3(1.55, 1.55, 1.55),
    hide: [],
    weapons: [['Skeleton_Axe', 'handslot.r']],
    baseColor: new Color3(0.32, 0.36, 0.3),
    idle: 'Idle_Combat',
    awaken: 'Skeletons_Awaken_Floor',
    labelHeight: 4,
  },
  skeletonMage: {
    model: 'Skeleton_Mage',
    scale: new Vector3(1.7, 1.7, 1.7),
    hide: [],
    weapons: [['Skeleton_Staff', 'handslot.r']],
    baseColor: new Color3(0.3, 0.28, 0.42),
    idle: 'Idle_B',
    awaken: 'Spawn_Air',
    labelHeight: 4.6,
  },
};

const STEP_MS = 330;
const BASE_HEIGHT = 0.18;

export interface CharacterSpec {
  readonly id: CharacterId;
  readonly kind: HeroKind | MonsterKind;
  readonly name: string;
  readonly position: Position;
  readonly facing: Direction;
  readonly monster: boolean;
}

/** An animated figure on the board, standing on a coloured base like a miniature. */
export class CharacterView {
  readonly root: TransformNode;
  readonly pickMesh: Mesh;
  readonly label: HTMLDivElement;
  private readonly model: CharacterInstance;
  private readonly style: CharacterStyle;
  private readonly ring: Mesh;
  private current: AnimationGroup | undefined;
  private ringTime = 0;
  tile: Position;
  /** Tile the figure is currently walking onto (equals `tile` when standing). */
  private heading: Position | undefined;
  moving = false;

  constructor(
    private readonly world: World,
    assets: AssetLibrary,
    private readonly effects: Effects,
    readonly spec: CharacterSpec,
    labelLayer: HTMLElement,
  ) {
    const scene = world.scene;
    this.style = STYLES[spec.kind];
    this.tile = spec.position;
    this.root = new TransformNode(`char:${spec.id}`, scene);
    this.root.position = tileCenter(spec.position);
    this.root.rotation.y = facingAngle(spec.facing);

    // Miniature base.
    const base = MeshBuilder.CreateCylinder(`base:${spec.id}`, { diameter: 2.9, height: BASE_HEIGHT, tessellation: 40 }, scene);
    const baseMat = new StandardMaterial(`base:${spec.id}`, scene);
    baseMat.diffuseColor = this.style.baseColor;
    baseMat.emissiveColor = this.style.baseColor.scale(spec.monster ? 0.1 : 0.35);
    baseMat.specularColor = new Color3(0.3, 0.3, 0.3);
    base.material = baseMat;
    base.position.y = BASE_HEIGHT / 2 + 0.05;
    base.parent = this.root;
    base.isPickable = false;
    base.receiveShadows = true;

    this.ring = MeshBuilder.CreateTorus(`ring:${spec.id}`, { diameter: 3.4, thickness: 0.16, tessellation: 48 }, scene);
    const ringMat = new StandardMaterial(`ring:${spec.id}`, scene);
    ringMat.emissiveColor = this.style.baseColor;
    ringMat.diffuseColor = Color3.Black();
    ringMat.disableLighting = true;
    this.ring.material = ringMat;
    this.ring.parent = this.root;
    this.ring.position.y = 0.2;
    this.ring.isPickable = false;
    this.ring.setEnabled(false);

    this.model = assets.character(this.style.model, !!this.style.tint);
    this.model.root.parent = this.root;
    this.model.root.position.y = BASE_HEIGHT + 0.05;
    this.model.root.scaling = this.style.scale.clone();
    for (const mesh of this.model.meshes) {
      mesh.isPickable = false;
      if (this.style.hide.some((h) => mesh.name.endsWith(`:${h}`))) mesh.setEnabled(false);
      if (this.style.tint && mesh.material instanceof StandardMaterial) {
        mesh.material.diffuseColor = this.style.tint;
        mesh.material.emissiveColor = new Color3(0.05, 0.0, 0.1);
      }
      world.addShadowCaster(mesh);
    }
    for (const [weapon, slot] of this.style.weapons) {
      const node = this.model.findNode(slot);
      if (!node) continue;
      const mesh = assets.weapon(weapon);
      mesh.parent = node;
      world.addShadowCaster(mesh);
    }
    for (const group of this.model.animations.values()) {
      group.enableBlending = true;
      group.blendingSpeed = 0.08;
    }

    this.pickMesh = MeshBuilder.CreateCylinder(`pick:${spec.id}`, { diameter: 2.6, height: 4.4 }, scene);
    this.pickMesh.parent = this.root;
    this.pickMesh.position.y = 2.2;
    this.pickMesh.isVisible = false;
    this.pickMesh.metadata = { characterId: spec.id, pick: true };

    this.label = document.createElement('div');
    this.label.className = `world-label${spec.monster ? ' monster' : ''}`;
    this.label.textContent = spec.name;
    if (!spec.monster) this.label.style.setProperty('--label-color', this.style.baseColor.toHexString());
    labelLayer.appendChild(this.label);

    this.play(this.style.idle, true);
    scene.onBeforeRenderObservable.add(this.onFrame);
  }

  /** Storey the camera should show for this figure: while taking stairs, the upper one. */
  get viewLevel(): number {
    return Math.max(this.tile.level, this.heading?.level ?? this.tile.level);
  }

  get heightForLabel(): number {
    return this.style.labelHeight;
  }

  setActive(active: boolean): void {
    this.ring.setEnabled(active);
  }

  /** Snap to a tile (snapshot sync). */
  place(position: Position, facing: Direction): void {
    this.tile = position;
    this.root.position = tileCenter(position);
    this.root.rotation.y = facingAngle(facing);
  }

  play(name: string, loop: boolean, speed = 1): AnimationGroup | undefined {
    const next = this.model.animations.get(name);
    if (!next || next === this.current) return next;
    this.current?.stop();
    next.start(loop, speed, next.from, next.to);
    this.current = next;
    return next;
  }

  playOnce(name: string, speed = 1): Promise<void> {
    const group = this.play(name, false, speed);
    // Background tabs render no frames, so the end event would never fire.
    if (!group || document.hidden) {
      this.current = undefined;
      this.play(this.style.idle, true);
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      group.onAnimationGroupEndObservable.addOnce(() => {
        this.current = undefined;
        this.play(this.style.idle, true);
        resolve();
      });
    });
  }

  async walk(path: readonly Position[]): Promise<void> {
    if (path.length === 0) return;
    this.moving = true;
    this.play(this.style.walk ?? this.style.idle, true, 1.35);
    for (const p of path) {
      this.heading = p;
      const from = this.root.position.clone();
      const to = tileCenter(p);
      const startYaw = this.root.rotation.y;
      const delta = angleDelta(startYaw, yawTowards(from, to));
      // A flight of stairs: level to its foot, up (or down) the steps, level onto the landing.
      const points = p.level === this.tile.level ? [from, to] : stairsRoute(from, to);
      await tween(
        this.world.scene,
        STEP_MS * (points.length - 1),
        (t) => {
          this.root.position = alongPolyline(points, t);
          this.root.rotation.y = startYaw + delta * Math.min(1, t * 3);
        },
        ease.linear,
      );
      this.tile = p;
      this.heading = undefined;
    }
    this.moving = false;
    this.play(this.style.idle, true);
  }

  async turnTo(facing: Direction): Promise<void> {
    const start = this.root.rotation.y;
    const delta = angleDelta(start, facingAngle(facing));
    await tween(this.world.scene, 200, (t) => (this.root.rotation.y = start + delta * t));
  }

  async interact(): Promise<void> {
    await this.playOnce('Interact', 1.3);
  }

  cheer(): void {
    void this.playOnce('Cheer');
  }

  /** Monster lies dormant until its room is discovered. */
  sleep(): void {
    this.play('Skeletons_Inactive_Floor_Pose', true);
    this.label.classList.add('hidden');
  }

  async awaken(): Promise<void> {
    const pos = this.root.position.add(new Vector3(0, 0.5, 0));
    this.effects.burst(pos, new Color4(0.55, 1, 0.65, 1), new Color4(0.5, 0.3, 1, 1), 110, 6, 0.8);
    this.label.classList.remove('hidden');
    await this.playOnce(this.style.awaken ?? this.style.idle, 1.15);
  }

  dispose(): void {
    this.world.scene.onBeforeRenderObservable.removeCallback(this.onFrame);
    for (const group of this.model.animations.values()) group.dispose();
    this.label.remove();
    this.root.dispose(false, true);
  }

  private readonly onFrame = () => {
    const scene = this.world.scene;
    // Figures above the focus level are hidden with their storey; only the focus level is labelled.
    const level = this.tile.level;
    const focus = this.world.focusLevel;
    if (this.root.isEnabled(false) !== level <= focus) this.root.setEnabled(level <= focus);
    if (this.ring.isEnabled()) {
      this.ringTime += scene.getEngine().getDeltaTime() / 1000;
      const s = 1 + Math.sin(this.ringTime * 4) * 0.06;
      this.ring.scaling.set(s, 1, s);
    }
    // Project the label anchor into screen space.
    const engine = scene.getEngine();
    const anchor = this.root.position.add(new Vector3(0, this.style.labelHeight, 0));
    const camera = scene.activeCamera!;
    const projected = Vector3.Project(
      anchor,
      Matrix.Identity(),
      scene.getTransformMatrix(),
      camera.viewport.toGlobal(engine.getRenderWidth(), engine.getRenderHeight()),
    );
    const scale = engine.getHardwareScalingLevel();
    const visible = level === focus && projected.z > 0 && projected.z < 1;
    this.label.style.display = visible ? '' : 'none';
    this.label.style.transform = `translate(${projected.x * scale}px, ${projected.y * scale}px) translate(-50%, -100%)`;
  };
}

/** Waypoints between the foot and the landing of a flight (one tile apart from both). */
function stairsRoute(from: Vector3, to: Vector3): Vector3[] {
  const along = new Vector3(to.x - from.x, 0, to.z - from.z).normalize().scale(CELL / 2);
  return [from, new Vector3(from.x + along.x, from.y, from.z + along.z), new Vector3(to.x - along.x, to.y, to.z - along.z), to];
}

/** Point at fraction t of a polyline, with equal time per segment. */
function alongPolyline(points: readonly Vector3[], t: number): Vector3 {
  const segments = points.length - 1;
  const i = Math.min(segments - 1, Math.floor(t * segments));
  return Vector3.Lerp(points[i]!, points[i + 1]!, t * segments - i);
}
