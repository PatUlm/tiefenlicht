import {
  Color3,
  DynamicTexture,
  type GlowLayer,
  MeshBuilder,
  StandardMaterial,
  type InstancedMesh,
  type Mesh,
  type Scene,
} from '@babylonjs/core';
import { posKey, type Position } from '@dungeon/shared';
import { tileCenter } from './grid.ts';

const TILE_SIZE = 3.6;

/**
 * Board-game style overlays on the floor: reachable tiles, the hovered target,
 * the path preview and an optional grid. All flat, unlit, glowing planes.
 */
export class BoardOverlay {
  private readonly reachSource: Mesh;
  private readonly gridSource: Mesh;
  private readonly dotSource: Mesh;
  private readonly hover: Mesh;
  private readonly reachMarkers: InstancedMesh[] = [];
  private readonly dots: InstancedMesh[] = [];
  private readonly gridMarkers = new Map<string, InstancedMesh>();
  private readonly hoverMat: StandardMaterial;
  private gridVisible = true;
  private time = 0;

  constructor(
    private readonly scene: Scene,
    glow: GlowLayer,
  ) {
    const tileTex = this.roundedRectTexture('overlay-tile', 0.07, 0.9);
    const hoverTex = this.roundedRectTexture('overlay-hover', 0.3, 1);
    const gridTex = this.roundedRectTexture('overlay-grid', 0, 0.55);

    this.reachSource = this.plane('reach', TILE_SIZE, this.material('reach', tileTex, new Color3(0.35, 0.85, 0.78), 0.55));
    this.gridSource = this.plane('grid', 4, this.material('grid', gridTex, new Color3(0.85, 0.78, 1), 0.12));
    this.dotSource = MeshBuilder.CreateDisc('path-dot', { radius: 0.32, tessellation: 20 }, scene);
    this.dotSource.rotation.x = Math.PI / 2;
    this.dotSource.bakeCurrentTransformIntoVertices();
    this.dotSource.material = this.material('dot', null, new Color3(1, 0.85, 0.4), 1);
    this.dotSource.isVisible = false;
    this.dotSource.isPickable = false;

    this.hoverMat = this.material('hover', hoverTex, new Color3(1, 0.9, 0.5), 0.95);
    this.hover = this.plane('hover', TILE_SIZE + 0.2, this.hoverMat);
    this.hover.isVisible = false;
    // Overlays must stay crisp: keep them out of the glow layer.
    for (const m of [this.reachSource, this.gridSource, this.dotSource, this.hover]) glow.addExcludedMesh(m);

    scene.onBeforeRenderObservable.add(() => {
      this.time += scene.getEngine().getDeltaTime() / 1000;
      const pulse = 0.75 + 0.25 * Math.sin(this.time * 3.2);
      for (const m of this.reachMarkers) m.scaling.setAll(0.94 + 0.04 * pulse);
      this.hover.scaling.setAll(1 + 0.05 * Math.sin(this.time * 6));
    });
  }

  setReachable(tiles: readonly Position[]): void {
    for (const m of this.reachMarkers.splice(0)) m.dispose();
    for (const t of tiles) {
      const m = this.reachSource.createInstance(`reach-${posKey(t)}`);
      m.position = tileCenter(t, 0.1);
      m.isPickable = false;
      this.reachMarkers.push(m);
    }
  }

  setHover(tile: Position | null, valid: boolean): void {
    if (!tile) {
      this.hover.isVisible = false;
      return;
    }
    this.hover.isVisible = true;
    this.hover.position = tileCenter(tile, 0.13);
    this.hoverMat.emissiveColor = valid ? new Color3(1, 0.88, 0.45) : new Color3(1, 0.3, 0.38);
  }

  setPath(path: readonly Position[]): void {
    for (const d of this.dots.splice(0)) d.dispose();
    path.forEach((p, i) => {
      if (i === path.length - 1) return;
      const d = this.dotSource.createInstance(`dot-${i}`);
      d.position = tileCenter(p, 0.16);
      d.isPickable = false;
      this.dots.push(d);
    });
  }

  addGridTiles(tiles: readonly Position[]): void {
    for (const t of tiles) {
      const key = posKey(t);
      if (this.gridMarkers.has(key)) continue;
      const m = this.gridSource.createInstance(`grid-${key}`);
      m.position = tileCenter(t, 0.07);
      m.isPickable = false;
      m.isVisible = this.gridVisible;
      this.gridMarkers.set(key, m);
    }
  }

  toggleGrid(): void {
    this.gridVisible = !this.gridVisible;
    for (const m of this.gridMarkers.values()) m.isVisible = this.gridVisible;
  }

  clear(): void {
    this.setReachable([]);
    this.setPath([]);
    this.setHover(null, false);
    for (const m of this.gridMarkers.values()) m.dispose();
    this.gridMarkers.clear();
  }

  private plane(name: string, size: number, material: StandardMaterial): Mesh {
    const mesh = MeshBuilder.CreateGround(name, { width: size, height: size }, this.scene);
    mesh.material = material;
    mesh.isPickable = false;
    mesh.isVisible = false;
    return mesh;
  }

  private material(name: string, texture: DynamicTexture | null, color: Color3, alpha: number): StandardMaterial {
    const m = new StandardMaterial(name, this.scene);
    m.disableLighting = true;
    m.emissiveColor = color;
    m.diffuseColor = Color3.Black();
    if (texture) {
      m.opacityTexture = texture;
    }
    m.alpha = alpha;
    m.backFaceCulling = false;
    m.zOffset = -2;
    return m;
  }

  /** White rounded square: translucent fill plus a crisp border (alpha only). */
  private roundedRectTexture(name: string, fillAlpha: number, borderAlpha: number): DynamicTexture {
    const size = 128;
    const tex = new DynamicTexture(name, { width: size, height: size }, this.scene, true);
    const ctx = tex.getContext() as CanvasRenderingContext2D;
    ctx.clearRect(0, 0, size, size);
    const r = 22;
    const inset = 6;
    const path = () => {
      ctx.beginPath();
      ctx.roundRect(inset, inset, size - inset * 2, size - inset * 2, r);
    };
    path();
    ctx.fillStyle = `rgba(255,255,255,${fillAlpha})`;
    ctx.fill();
    ctx.lineWidth = 7;
    ctx.strokeStyle = `rgba(255,255,255,${borderAlpha})`;
    path();
    ctx.stroke();
    tex.hasAlpha = true;
    tex.update();
    return tex;
  }
}
