import {
  ArcRotateCamera,
  Color3,
  Color4,
  DefaultRenderingPipeline,
  DirectionalLight,
  Engine,
  GlowLayer,
  HemisphericLight,
  ImageProcessingConfiguration,
  Observable,
  Scene,
  ShadowGenerator,
  Vector3,
  type AbstractMesh,
} from '@babylonjs/core';
import { CELL } from './grid.ts';
import { lerp } from './tween.ts';

const BETA = 0.93;
const MIN_RADIUS = 26;
const MAX_RADIUS = 110;

/**
 * Engine, scene, isometric-style camera, global lighting and post-processing.
 * The camera snaps between four 90° views (Q/E) so the board stays readable.
 */
export class World {
  readonly engine: Engine;
  readonly scene: Scene;
  readonly camera: ArcRotateCamera;
  readonly glow: GlowLayer;
  readonly shadows: ShadowGenerator;
  readonly hemi: HemisphericLight;
  readonly onViewRotated = new Observable<void>();

  private viewIndex = 0;
  private desiredAlpha: number;
  private desiredRadius = 56;
  private readonly desiredTarget = new Vector3();

  constructor(readonly canvas: HTMLCanvasElement) {
    this.engine = new Engine(canvas, true, { stencil: true, antialias: true }, false);
    this.engine.setHardwareScalingLevel(1 / Math.min(window.devicePixelRatio || 1, 2));
    const scene = new Scene(this.engine);
    this.scene = scene;
    scene.useRightHandedSystem = true;
    scene.clearColor = new Color4(0.07, 0.045, 0.13, 1);
    scene.ambientColor = new Color3(0.1, 0.08, 0.14);

    this.desiredAlpha = this.alphaForView(0);
    const camera = new ArcRotateCamera('camera', this.desiredAlpha, BETA, this.desiredRadius, Vector3.Zero(), scene);
    camera.fov = 0.6;
    camera.minZ = 1;
    camera.maxZ = 600;
    camera.inputs.clear();
    this.camera = camera;

    this.hemi = new HemisphericLight('ambient', new Vector3(0.2, 1, 0.1), scene);
    this.hemi.intensity = 1.05;
    this.hemi.diffuse = new Color3(0.86, 0.82, 1);
    this.hemi.groundColor = new Color3(0.52, 0.44, 0.66);
    this.hemi.specular = Color3.Black();

    // Key light from the default camera side, so the tall back walls are lit
    // and shadows fall away from the viewer.
    const key = new DirectionalLight('key', new Vector3(-0.4, -1, -0.55).normalize(), scene);
    key.position = new Vector3(80, 80, 110);
    key.intensity = 0.95;
    key.diffuse = new Color3(1, 0.93, 0.85);
    key.specular = new Color3(0.2, 0.2, 0.2);
    key.autoCalcShadowZBounds = true;
    this.shadows = new ShadowGenerator(2048, key);
    this.shadows.usePercentageCloserFiltering = true;
    this.shadows.filteringQuality = ShadowGenerator.QUALITY_MEDIUM;
    this.shadows.bias = 0.004;
    this.shadows.normalBias = 0.03;
    this.shadows.darkness = 0.45;

    this.glow = new GlowLayer('glow', scene, { mainTextureSamples: 2, blurKernelSize: 48 });
    this.glow.intensity = 0.85;

    const pipeline = new DefaultRenderingPipeline('pipeline', true, scene, [camera]);
    pipeline.samples = 4;
    pipeline.bloomEnabled = true;
    pipeline.bloomThreshold = 0.85;
    pipeline.bloomWeight = 0.28;
    pipeline.bloomKernel = 64;
    pipeline.bloomScale = 0.5;
    pipeline.imageProcessingEnabled = true;
    const ip = pipeline.imageProcessing;
    ip.toneMappingEnabled = true;
    ip.toneMappingType = ImageProcessingConfiguration.TONEMAPPING_KHR_PBR_NEUTRAL;
    ip.exposure = 1.1;
    ip.contrast = 1.08;
    ip.vignetteEnabled = true;
    ip.vignetteWeight = 1.6;
    ip.vignetteColor = new Color4(0.08, 0.02, 0.15, 0);
    ip.vignetteBlendMode = ImageProcessingConfiguration.VIGNETTEMODE_MULTIPLY;
    ip.colorCurvesEnabled = true;
    ip.colorCurves!.globalSaturation = 25;

    scene.onBeforeRenderObservable.add(() => this.updateCamera());
    window.addEventListener('resize', () => this.engine.resize());
  }

  start(): void {
    this.engine.runRenderLoop(() => this.scene.render());
  }

  addShadowCaster(mesh: AbstractMesh): void {
    this.shadows.addShadowCaster(mesh, true);
  }

  // ---------------------------------------------------------------- camera

  /** Horizontal unit vector (x, z) from the camera target towards the camera. */
  viewDirection(): { x: number; z: number } {
    const a = this.alphaForView(this.viewIndex);
    return { x: Math.cos(a), z: Math.sin(a) };
  }

  rotateView(step: 1 | -1): void {
    this.viewIndex = (this.viewIndex + step + 4) % 4;
    this.desiredAlpha += (step * Math.PI) / 2;
    this.onViewRotated.notifyObservers();
  }

  focus(target: Vector3, instant = false): void {
    this.desiredTarget.copyFrom(target);
    this.desiredTarget.y = 0;
    if (instant) this.camera.target.copyFrom(this.desiredTarget);
  }

  zoom(delta: number): void {
    this.desiredRadius = Math.min(MAX_RADIUS, Math.max(MIN_RADIUS, this.desiredRadius * (1 + delta)));
  }

  /** Pans in screen space (pixels). */
  pan(dxPixels: number, dyPixels: number): void {
    const scale = (this.camera.radius / this.engine.getRenderHeight()) * 0.9;
    const c = this.viewDirection();
    const right = { x: c.z, z: -c.x };
    const forward = { x: -c.x, z: -c.z };
    this.desiredTarget.x += (-right.x * dxPixels + forward.x * dyPixels * 1.4) * scale;
    this.desiredTarget.z += (-right.z * dxPixels + forward.z * dyPixels * 1.4) * scale;
  }

  /** Keeps the camera target within the dungeon bounds (in tiles). */
  clampTarget(width: number, height: number): void {
    this.desiredTarget.x = Math.min(width * CELL, Math.max(-CELL, this.desiredTarget.x));
    this.desiredTarget.z = Math.min(height * CELL, Math.max(-CELL, this.desiredTarget.z));
  }

  private alphaForView(index: number): number {
    return Math.PI / 4 + (index * Math.PI) / 2;
  }

  private updateCamera(): void {
    const dt = Math.min(0.1, this.engine.getDeltaTime() / 1000);
    const k = 1 - Math.exp(-dt * 6);
    const cam = this.camera;
    cam.alpha = lerp(cam.alpha, this.desiredAlpha, k);
    cam.radius = lerp(cam.radius, this.desiredRadius, k);
    cam.target.x = lerp(cam.target.x, this.desiredTarget.x, k);
    cam.target.z = lerp(cam.target.z, this.desiredTarget.z, k);
    cam.target.y = 0;
  }
}
