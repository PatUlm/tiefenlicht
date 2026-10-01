import {
  Color3,
  DynamicTexture,
  Vector3,
  type GlowLayer,
  MeshBuilder,
  StandardMaterial,
  type InstancedMesh,
  type Mesh,
  type Scene,
} from '@babylonjs/core';
import { posKey, type Position } from '@dungeon/shared';
import { LEVEL_HEIGHT, tileCenter } from './grid.ts';

const TILE_SIZE = 3.6;

/**
 * Board-game style overlays on the floor: reachable tiles, the hovered target,
 * the path preview and an optional grid. All flat, unlit, glowing planes.
 * The grid is drawn on the focus level only; path dots never float above it.
 */
export class BoardOverlay {
  private readonly reachSource: Mesh;
  private readonly gridSource: Mesh;
  private readonly dotSource: Mesh;
  private readonly climbSource: Mesh;
  private readonly hover: Mesh;
  private readonly reachMarkers: InstancedMesh[] = [];
  private readonly dots: InstancedMesh[] = [];
  private readonly gridMarkers = new Map<string, { mesh: InstancedMesh; level: number }>();
  private readonly hoverMat: StandardMaterial;
  private gridVisible = true;
  private focusLevel = 0;
  private time = 0;

  constructor(
    private readonly scene: Scene,
    glow: GlowLayer,
  ) {
    const tileTex = this.roundedRectTexture('overlay-tile', 0.07, 0.9);
    const hoverTex = this.roundedRectTexture('overlay-hover', 0.3, 1);
    const gridTex = this.roundedRectTexture('overlay-grid', 0, 0.55);

    this.reachSource = this.plane('reach', TILE_SIZE, this.material('reach', tileTex, new Color3(0.35, 0.85, 0.78), 0.55));
    this.gridSource = this.plane('grid', 4, this.material('grid', gridTex, new Color3(0.92, 0.92, 0.9), 0.1));
    this.dotSource = MeshBuilder.CreateDisc('path-dot', { radius: 0.32, tessellation: 20 }, scene);
    this.dotSource.rotation.x = Math.PI / 2;
    this.dotSource.bakeCurrentTransformIntoVertices();
    this.dotSource.material = this.material('dot', null, new Color3(1, 0.85, 0.4), 1);
    this.dotSource.isVisible = false;
    this.dotSource.isPickable = false;
    // A path changing storeys gets a gold diamond above the middle of the flight.
    this.climbSource = MeshBuilder.CreatePolyhedron('path-climb', { type: 1, size: 0.42 }, scene);
    this.climbSource.scaling.y = 1.5;
    this.climbSource.bakeCurrentTransformIntoVertices();
    this.climbSource.material = this.material('climb', null, new Color3(1, 0.82, 0.35), 1);
    this.climbSource.isVisible = false;
    this.climbSource.isPickable = false;

    this.hoverMat = this.material('hover', hoverTex, new Color3(1, 0.9, 0.5), 0.95);
    this.hover = this.plane('hover', TILE_SIZE + 0.2, this.hoverMat);
    this.hover.isVisible = false;
    // Overlays must stay crisp: keep them out of the glow layer.
    for (const m of [this.reachSource, this.gridSource, this.dotSource, this.climbSource, this.hover]) glow.addExcludedMesh(m);

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

  /** Dots along the path; `from` (the start tile) lets a flight on the first step be marked too. */
  setPath(path: readonly Position[], from?: Position): void {
    for (const d of this.dots.splice(0)) d.dispose();
    path.forEach((p, i) => {
      const prev = i === 0 ? from : path[i - 1];
      if (prev && prev.level !== p.level && Math.min(prev.level, p.level) <= this.focusLevel) {
        const climb = this.climbSource.createInstance(`climb-${i}`);
        climb.position = Vector3.Center(tileCenter(prev), tileCenter(p)).addInPlaceFromFloats(0, LEVEL_HEIGHT / 4, 0);
        climb.isPickable = false;
        this.dots.push(climb);
      }
      if (i === path.length - 1 || p.level > this.focusLevel) return;
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
      this.gridMarkers.set(key, { mesh: m, level: t.level });
    }
    this.updateGrid();
  }

  toggleGrid(): void {
    this.gridVisible = !this.gridVisible;
    this.updateGrid();
  }

  setFocusLevel(level: number): void {
    this.focusLevel = level;
    this.updateGrid();
  }

  private updateGrid(): void {
    for (const { mesh, level } of this.gridMarkers.values()) mesh.isVisible = this.gridVisible && level === this.focusLevel;
  }

  clear(): void {
    this.setReachable([]);
    this.setPath([]);
    this.setHover(null, false);
    for (const { mesh } of this.gridMarkers.values()) mesh.dispose();
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
