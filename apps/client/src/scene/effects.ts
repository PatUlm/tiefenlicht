import {
  Color3,
  Color4,
  Constants,
  DynamicTexture,
  MeshBuilder,
  ParticleSystem,
  PointLight,
  StandardMaterial,
  TransformNode,
  Vector3,
  type Mesh,
  type Scene,
  type Texture,
} from '@babylonjs/core';

export type FlameTint = 'fire' | 'green' | 'arcane';

const FLAME_COLORS: Record<FlameTint, [Color4, Color4, Color3]> = {
  // [flame core, flame edge, light colour]; lights are softer than the flames so
  // they form warm pools instead of tinting whole rooms.
  fire: [new Color4(1, 0.8, 0.35, 1), new Color4(1, 0.42, 0.08, 1), new Color3(1, 0.74, 0.48)],
  green: [new Color4(0.6, 1, 0.55, 1), new Color4(0.15, 0.85, 0.35, 1), new Color3(0.6, 0.95, 0.66)],
  arcane: [new Color4(0.75, 0.6, 1, 1), new Color4(0.35, 0.45, 1, 1), new Color3(0.66, 0.68, 1)],
};

/**
 * Disposes a particle system but keeps its texture. All systems share one texture,
 * and Babylon's `dispose()` would otherwise free it for every other flame and fog.
 */
export function disposeParticles(ps: ParticleSystem): void {
  ps.dispose(false);
}

/** Teardrop profile of a flame (radius, height) for a lathe around the Y axis. */
const FLAME_PROFILE: readonly [number, number][] = [
  [0, 0],
  [0.15, 0.07],
  [0.21, 0.22],
  [0.17, 0.44],
  [0.09, 0.68],
  [0, 0.95],
];

interface Flame {
  readonly node: TransformNode;
  readonly scale: number;
  readonly seed: number;
}

/**
 * Procedural effects (no texture files needed): animated low-poly flames,
 * flickering lights and particle effects for fog, wisps, sparkles and bursts.
 */
export class Effects {
  private readonly softTexture: Texture;
  private readonly flickering = new Set<{ light: PointLight; base: number; seed: number }>();
  private readonly flames = new Set<Flame>();
  /** Shared flame geometry per tint: [additive outer shell, opaque hot core]. */
  private readonly flameSources = new Map<FlameTint, [Mesh, Mesh]>();
  private time = 0;

  constructor(private readonly scene: Scene) {
    this.softTexture = this.radialTexture('soft', 64);
    scene.onBeforeRenderObservable.add(() => {
      this.time += scene.getEngine().getDeltaTime() / 1000;
      for (const f of this.flickering) {
        const t = this.time * 9 + f.seed;
        const n = Math.sin(t) * 0.5 + Math.sin(t * 2.3 + 1.7) * 0.3 + Math.sin(t * 5.1) * 0.2;
        f.light.intensity = f.base * (0.88 + 0.12 * n) * (f.light.metadata?.fade ?? 1);
      }
      for (const f of this.flames) if (f.node.isEnabled()) this.animateFlame(f);
    });
  }

  /**
   * An animated flame made of two nested low-poly teardrops, attached to `parent`
   * at a local position. It flickers in height, sways and turns its facets; it is
   * hidden and disposed together with its parent.
   */
  flame(parent: TransformNode, local: Vector3, tint: FlameTint, scale = 1): TransformNode {
    const [outerSource, coreSource] = this.flameSource(tint);
    const node = new TransformNode('flame', this.scene);
    node.parent = parent;
    node.position = local.clone();
    node.scaling.setAll(scale);
    const outer = outerSource.createInstance('flame-outer');
    const core = coreSource.createInstance('flame-core');
    core.scaling.set(0.55, 0.6, 0.55);
    core.position.y = 0.02;
    for (const m of [outer, core]) {
      m.parent = node;
      m.isPickable = false;
    }
    const flame: Flame = { node, scale, seed: Math.random() * 100 };
    this.flames.add(flame);
    node.onDisposeObservable.addOnce(() => this.flames.delete(flame));
    return node;
  }

  pointLight(name: string, position: Vector3, color: Color3, intensity: number, range: number, flicker = true): PointLight {
    const light = new PointLight(name, position, this.scene);
    light.diffuse = color;
    light.specular = color.scale(0.3);
    light.intensity = intensity;
    light.range = range;
    light.metadata = { fade: 1 };
    if (flicker) {
      const entry = { light, base: intensity, seed: Math.random() * 100 };
      this.flickering.add(entry);
      light.onDisposeObservable.addOnce(() => this.flickering.delete(entry));
    }
    return light;
  }

  flameLightColor(tint: FlameTint): Color3 {
    return FLAME_COLORS[tint][2];
  }

  private animateFlame(f: Flame): void {
    const t = this.time + f.seed;
    const flicker = Math.sin(t * 7.3) * 0.5 + Math.sin(t * 13.1 + 1.3) * 0.3 + Math.sin(t * 23.7 + 2.1) * 0.2;
    const width = f.scale * (1 - 0.08 * flicker);
    f.node.scaling.set(width, f.scale * (1 + 0.2 * flicker), width);
    f.node.rotation.set(0.1 * Math.sin(t * 5.1 + 0.7), t * 1.9, 0.1 * Math.sin(t * 6.3 + 0.4));
  }

  private flameSource(tint: FlameTint): [Mesh, Mesh] {
    let sources = this.flameSources.get(tint);
    if (!sources) {
      const [core, edge] = FLAME_COLORS[tint];
      const shape = FLAME_PROFILE.map(([r, y]) => new Vector3(r, y, 0));
      const make = (name: string, color: Color4, additive: boolean) => {
        const mesh = MeshBuilder.CreateLathe(`${name}-${tint}`, { shape, tessellation: 7 }, this.scene);
        const mat = new StandardMaterial(`${name}-${tint}`, this.scene);
        mat.disableLighting = true;
        mat.emissiveColor = new Color3(color.r, color.g, color.b);
        if (additive) {
          // Additive shell: overlapping flames add up and never need depth sorting.
          mat.alpha = 0.9;
          mat.alphaMode = Constants.ALPHA_ADD;
          mat.disableDepthWrite = true;
        }
        mesh.material = mat;
        mesh.isPickable = false;
        mesh.isVisible = false;
        return mesh;
      };
      sources = [make('flame-outer', edge, true), make('flame-core', core, false)];
      this.flameSources.set(tint, sources);
    }
    return sources;
  }

  /** Low drifting fog inside an area (crypt). */
  groundFog(min: Vector3, max: Vector3, color: Color4): ParticleSystem {
    const ps = new ParticleSystem('fog', 220, this.scene);
    ps.particleTexture = this.softTexture;
    ps.emitter = Vector3.Zero();
    ps.minEmitBox = min;
    ps.maxEmitBox = max;
    ps.color1 = color;
    ps.color2 = new Color4(color.r * 0.8, color.g * 0.9, color.b, color.a * 0.8);
    ps.colorDead = new Color4(color.r, color.g, color.b, 0);
    ps.minSize = 3.5;
    ps.maxSize = 7;
    ps.minLifeTime = 5;
    ps.maxLifeTime = 9;
    ps.emitRate = 22;
    ps.blendMode = ParticleSystem.BLENDMODE_STANDARD;
    ps.gravity = Vector3.Zero();
    ps.direction1 = new Vector3(-0.3, 0.02, -0.3);
    ps.direction2 = new Vector3(0.3, 0.06, 0.3);
    ps.minEmitPower = 0.2;
    ps.maxEmitPower = 0.5;
    ps.minAngularSpeed = -0.2;
    ps.maxAngularSpeed = 0.2;
    ps.addColorGradient(0, new Color4(color.r, color.g, color.b, 0));
    ps.addColorGradient(0.3, color);
    ps.addColorGradient(1, new Color4(color.r, color.g, color.b, 0));
    ps.preWarmCycles = 200;
    ps.preWarmStepOffset = 5;
    ps.start();
    return ps;
  }

  /** Faint violet wisps seeping under a closed door into the unknown. */
  doorWisps(origin: Vector3, toward: Vector3): ParticleSystem {
    const ps = new ParticleSystem('wisps', 40, this.scene);
    ps.particleTexture = this.softTexture;
    ps.emitter = origin.clone();
    ps.minEmitBox = new Vector3(-1.1, 0.05, -1.1);
    ps.maxEmitBox = new Vector3(1.1, 0.3, 1.1);
    ps.color1 = new Color4(0.55, 0.35, 0.95, 0.22);
    ps.color2 = new Color4(0.35, 0.25, 0.8, 0.16);
    ps.colorDead = new Color4(0.3, 0.2, 0.6, 0);
    ps.minSize = 0.8;
    ps.maxSize = 1.8;
    ps.minLifeTime = 1.2;
    ps.maxLifeTime = 2.4;
    ps.emitRate = 9;
    ps.blendMode = ParticleSystem.BLENDMODE_ADD;
    ps.gravity = new Vector3(0, 0.15, 0);
    ps.direction1 = toward.scale(0.4).add(new Vector3(-0.1, 0.05, -0.1));
    ps.direction2 = toward.scale(0.9).add(new Vector3(0.1, 0.15, 0.1));
    ps.minEmitPower = 0.3;
    ps.maxEmitPower = 0.6;
    ps.start();
    return ps;
  }

  /** Omen of stairs leading down: a cold, grey-blue breath rising out of the stairwell. */
  coldBreath(origin: Vector3): ParticleSystem {
    const ps = new ParticleSystem('cold-breath', 60, this.scene);
    ps.particleTexture = this.softTexture;
    ps.emitter = origin.clone();
    ps.minEmitBox = new Vector3(-1.3, 0, -1.3);
    ps.maxEmitBox = new Vector3(1.3, 0.4, 1.3);
    ps.color1 = new Color4(0.62, 0.72, 0.86, 0.3);
    ps.color2 = new Color4(0.45, 0.55, 0.72, 0.22);
    ps.colorDead = new Color4(0.5, 0.6, 0.75, 0);
    ps.minSize = 1;
    ps.maxSize = 2.2;
    ps.minLifeTime = 1.8;
    ps.maxLifeTime = 3;
    ps.emitRate = 10;
    ps.blendMode = ParticleSystem.BLENDMODE_STANDARD;
    ps.gravity = new Vector3(0, 0.5, 0);
    ps.direction1 = new Vector3(-0.15, 0.6, -0.15);
    ps.direction2 = new Vector3(0.15, 1, 0.15);
    ps.minEmitPower = 0.3;
    ps.maxEmitPower = 0.7;
    ps.start();
    return ps;
  }

  /** Omen of stairs leading up: single star sparks drifting down the flight. */
  starfall(origin: Vector3): ParticleSystem {
    const ps = new ParticleSystem('starfall', 60, this.scene);
    ps.particleTexture = this.softTexture;
    ps.emitter = origin.clone();
    ps.minEmitBox = new Vector3(-1.4, -0.2, -1.4);
    ps.maxEmitBox = new Vector3(1.4, 0.2, 1.4);
    ps.color1 = new Color4(1, 0.95, 0.75, 1);
    ps.color2 = new Color4(0.7, 0.8, 1, 0.9);
    ps.colorDead = new Color4(0.6, 0.7, 1, 0);
    ps.minSize = 0.1;
    ps.maxSize = 0.26;
    ps.minLifeTime = 1.6;
    ps.maxLifeTime = 2.6;
    ps.emitRate = 12;
    ps.blendMode = ParticleSystem.BLENDMODE_ADD;
    ps.gravity = new Vector3(0, -1.1, 0);
    ps.direction1 = new Vector3(-0.2, -0.1, -0.2);
    ps.direction2 = new Vector3(0.2, 0, 0.2);
    ps.minEmitPower = 0.1;
    ps.maxEmitPower = 0.3;
    ps.start();
    return ps;
  }

  /** Rising sparkles (crystal, cauldron, victory). */
  sparkles(position: Vector3, c1: Color4, c2: Color4, radius = 0.8, rate = 30): ParticleSystem {
    const ps = new ParticleSystem('sparkles', 200, this.scene);
    ps.particleTexture = this.softTexture;
    ps.emitter = position.clone();
    ps.minEmitBox = new Vector3(-radius, 0, -radius);
    ps.maxEmitBox = new Vector3(radius, radius * 1.5, radius);
    ps.color1 = c1;
    ps.color2 = c2;
    ps.colorDead = new Color4(c2.r, c2.g, c2.b, 0);
    ps.minSize = 0.08;
    ps.maxSize = 0.28;
    ps.minLifeTime = 0.8;
    ps.maxLifeTime = 1.8;
    ps.emitRate = rate;
    ps.blendMode = ParticleSystem.BLENDMODE_ADD;
    ps.gravity = new Vector3(0, 0.8, 0);
    ps.direction1 = new Vector3(-0.4, 0.6, -0.4);
    ps.direction2 = new Vector3(0.4, 1.2, 0.4);
    ps.minEmitPower = 0.2;
    ps.maxEmitPower = 0.7;
    ps.start();
    return ps;
  }

  /** One-shot burst, e.g. a monster awakening or a door bursting open. */
  burst(position: Vector3, c1: Color4, c2: Color4, count = 90, power = 5, size = 0.6): void {
    const ps = new ParticleSystem('burst', count, this.scene);
    ps.particleTexture = this.softTexture;
    ps.emitter = position.clone();
    ps.minEmitBox = new Vector3(-0.4, 0, -0.4);
    ps.maxEmitBox = new Vector3(0.4, 0.8, 0.4);
    ps.color1 = c1;
    ps.color2 = c2;
    ps.colorDead = new Color4(c2.r, c2.g, c2.b, 0);
    ps.minSize = size * 0.4;
    ps.maxSize = size;
    ps.minLifeTime = 0.5;
    ps.maxLifeTime = 1.2;
    ps.manualEmitCount = count;
    ps.blendMode = ParticleSystem.BLENDMODE_ADD;
    ps.gravity = new Vector3(0, -2, 0);
    ps.direction1 = new Vector3(-1, 0.6, -1);
    ps.direction2 = new Vector3(1, 1.6, 1);
    ps.minEmitPower = power * 0.4;
    ps.maxEmitPower = power;
    ps.targetStopDuration = 1.5;
    this.disposeWhenDone(ps);
    ps.start();
  }

  dust(position: Vector3): void {
    const ps = new ParticleSystem('dust', 60, this.scene);
    ps.particleTexture = this.softTexture;
    ps.emitter = position.clone();
    ps.minEmitBox = new Vector3(-1.5, 0, -0.3);
    ps.maxEmitBox = new Vector3(1.5, 0.4, 0.3);
    ps.color1 = new Color4(0.75, 0.65, 0.55, 0.45);
    ps.color2 = new Color4(0.6, 0.52, 0.45, 0.3);
    ps.colorDead = new Color4(0.5, 0.45, 0.4, 0);
    ps.minSize = 0.8;
    ps.maxSize = 1.8;
    ps.minLifeTime = 0.8;
    ps.maxLifeTime = 1.6;
    ps.manualEmitCount = 50;
    ps.blendMode = ParticleSystem.BLENDMODE_STANDARD;
    ps.gravity = new Vector3(0, 0.3, 0);
    ps.direction1 = new Vector3(-1, 0.2, -1);
    ps.direction2 = new Vector3(1, 0.6, 1);
    ps.minEmitPower = 0.5;
    ps.maxEmitPower = 1.5;
    ps.targetStopDuration = 1.5;
    this.disposeWhenDone(ps);
    ps.start();
  }

  /** One-shot cleanup; `disposeOnStop` would also dispose the shared texture. */
  private disposeWhenDone(ps: ParticleSystem): void {
    ps.onAnimationEnd = () => this.scene.onAfterRenderObservable.addOnce(() => disposeParticles(ps));
  }

  private radialTexture(name: string, size: number): DynamicTexture {
    const tex = new DynamicTexture(name, { width: size, height: size }, this.scene, false);
    const ctx = tex.getContext() as CanvasRenderingContext2D;
    const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.35, 'rgba(255,255,255,0.65)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, size, size);
    tex.hasAlpha = true;
    tex.update();
    return tex;
  }
}
