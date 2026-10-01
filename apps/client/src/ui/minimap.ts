import { Board } from '@dungeon/game-core';
import {
  DIRECTIONS,
  DIRECTION_OFFSETS,
  directionTo,
  edgeKey,
  step,
  stairsShaft,
  type Direction,
  type GameView,
  type Position,
} from '@dungeon/shared';
import { button, el } from './dom.ts';

/** Display name of a storey. */
export function levelName(level: number): string {
  if (level === 0) return 'Eingangsebene';
  const kind = level > 0 ? 'Obergeschoss' : 'Untergeschoss';
  return Math.abs(level) === 1 ? kind : `${Math.abs(level)}. ${kind}`;
}

export interface MinimapHandlers {
  onSelectLevel(level: number): void;
}

/** A figure at its live (possibly in-between) position, in tile units. */
export interface MinimapFigure {
  readonly x: number;
  readonly y: number;
  readonly level: number;
  readonly color: string;
  readonly monster: boolean;
}

type Segment = readonly [ax: number, ay: number, bx: number, by: number];

interface LevelShape {
  readonly level: number;
  readonly tiles: readonly Position[];
  readonly walls: readonly Segment[];
  readonly closedDoors: readonly Segment[];
  readonly openDoors: readonly Segment[];
}

interface StairsShape {
  /** Foot, start and end of the flight, landing: x, y in tiles plus level. */
  readonly route: readonly (readonly [number, number, number])[];
  readonly explored: boolean;
}

const WIDTH = 248;
const HEIGHT = 196;
const PADDING = 12;
/** Vertical spacing of storeys in tile units (exaggerated so stacked levels separate). */
const LEVEL_GAP = 4.5;
/** Foreshortening of the ground plane (isometric look). */
const TILT = 0.5;

const COLORS = {
  cage: 'rgba(195, 181, 217, 0.16)',
  floorFocus: 'rgba(255, 255, 255, 0.10)',
  floorOther: 'rgba(255, 255, 255, 0.035)',
  wallFocus: 'rgba(236, 228, 255, 0.95)',
  wallOther: 'rgba(195, 181, 217, 0.38)',
  doorClosed: '#ffcf6b',
  doorOpen: 'rgba(123, 224, 176, 0.8)',
  stairsOpen: 'rgba(255, 207, 107, 0.85)',
  stairsUnknown: 'rgba(255, 207, 107, 0.5)',
  monster: '#ff6b81',
};

/** Edge of a tile towards a direction, in tile units (tile centres are integers). */
function tileEdge(p: Position, dir: Direction): Segment {
  const o = DIRECTION_OFFSETS[dir];
  const cx = p.x + o.x / 2;
  const cy = p.y + o.y / 2;
  return o.x === 0 ? [cx - 0.5, cy, cx + 0.5, cy] : [cx, cy - 0.5, cx, cy + 0.5];
}

/**
 * Wireframe overview of the known dungeon (only what the filtered view contains):
 * every storey as an outline plane stacked in a 3D cage, with doors, stairs and
 * figures. It rotates with the main camera and redraws only when something changed.
 */
export class Minimap {
  readonly root: HTMLDivElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly levelBar: HTMLDivElement;
  private shapes: LevelShape[] = [];
  private stairs: StairsShape[] = [];
  private bounds = { width: 1, height: 1 };
  private focus = 0;
  private signature = '';
  private structure = '';

  constructor(private readonly handlers: MinimapHandlers) {
    this.root = el('div', 'panel minimap');
    this.canvas = el('canvas');
    this.canvas.style.width = `${WIDTH}px`;
    this.canvas.style.height = `${HEIGHT}px`;
    this.ctx = this.canvas.getContext('2d')!;
    this.levelBar = el('div', 'minimap-levels');
    this.root.append(this.canvas, this.levelBar);
  }

  /** Rebuilds the outlines from a new view (cheap; derived like the 3D walls). */
  update(view: GameView, heroes: readonly { level: number; color: string }[]): void {
    const board = new Board(view);
    const byLevel = new Map<number, Position[]>();
    for (const area of view.areas) byLevel.set(area.level, [...(byLevel.get(area.level) ?? []), ...area.tiles]);

    this.shapes = [...byLevel.entries()]
      .sort(([a], [b]) => a - b)
      .map(([level, tiles]) => {
        const walls: Segment[] = [];
        const seen = new Set<string>();
        for (const t of tiles) {
          for (const dir of DIRECTIONS) {
            const n = step(t, dir);
            const key = edgeKey(t, n);
            if (!board.isWall(t, n) || seen.has(key)) continue;
            seen.add(key);
            walls.push(tileEdge(t, dir));
          }
        }
        const onLevel = view.doors.filter((d) => d.edges[0]![0].level === level);
        const doorSegments = (open: boolean) =>
          onLevel.filter((d) => d.open === open).flatMap((d) => d.edges.map(([a, b]) => tileEdge(a, directionTo(a, b))));
        return { level, tiles, walls, closedDoors: doorSegments(false), openDoors: doorSegments(true) };
      });

    this.stairs = view.stairs.map((s) => {
      const o = DIRECTION_OFFSETS[s.direction];
      const shaft = stairsShaft(s);
      return {
        route: [
          [s.bottom.x, s.bottom.y, s.bottom.level],
          [shaft.x - o.x / 2, shaft.y - o.y / 2, s.bottom.level],
          [shaft.x + o.x / 2, shaft.y + o.y / 2, s.top.level],
          [s.top.x, s.top.y, s.top.level],
        ],
        explored: s.explored,
      };
    });
    this.bounds = { width: view.width, height: view.height };
    this.structure = `${view.version}`;
    this.renderLevelBar(heroes);
  }

  setFocusLevel(level: number): void {
    this.focus = level;
    for (const b of this.levelBar.querySelectorAll<HTMLButtonElement>('button')) {
      b.classList.toggle('active', Number(b.dataset['level']) === level);
    }
  }

  /** Called every frame; draws only when the camera angle, the focus or a figure moved. */
  frame(cameraAlpha: number, figures: readonly MinimapFigure[]): void {
    const signature = [
      this.structure,
      this.focus,
      cameraAlpha.toFixed(3),
      ...figures.map((f) => `${f.x.toFixed(2)},${f.y.toFixed(2)},${f.level}`),
    ].join('|');
    if (signature === this.signature) return;
    this.signature = signature;
    this.draw(cameraAlpha, figures);
  }

  private renderLevelBar(heroes: readonly { level: number; color: string }[]): void {
    const levels = this.shapes.map((s) => s.level).reverse();
    this.levelBar.replaceChildren();
    // A single storey needs no switcher.
    if (levels.length < 2) return;
    for (const level of levels) {
      const label = level > 0 ? `+${level}` : level < 0 ? `−${-level}` : '0';
      const b = button(label, 'level-button', () => this.handlers.onSelectLevel(level));
      b.dataset['level'] = String(level);
      b.title = `${levelName(level)} (Bild↑/Bild↓)`;
      for (const hero of heroes.filter((h) => h.level === level)) {
        const dot = el('span', 'hero-dot');
        dot.style.background = hero.color;
        b.appendChild(dot);
      }
      this.levelBar.appendChild(b);
    }
    this.setFocusLevel(this.focus);
  }

  private draw(alpha: number, figures: readonly MinimapFigure[]): void {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    if (this.canvas.width !== WIDTH * dpr) {
      this.canvas.width = WIDTH * dpr;
      this.canvas.height = HEIGHT * dpr;
    }
    const ctx = this.ctx;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, WIDTH, HEIGHT);
    if (this.shapes.length === 0) return;

    // Screen axes of the main camera (see World.pan): right = (sin α, −cos α), towards camera = (cos α, sin α).
    const rx = Math.sin(alpha);
    const rz = -Math.cos(alpha);
    const cx = Math.cos(alpha);
    const cz = Math.sin(alpha);
    const levels = this.shapes.map((s) => s.level);
    const minLevel = Math.min(...levels);
    const maxLevel = Math.max(...levels);
    const midLevel = (minLevel + maxLevel) / 2;
    const midX = (this.bounds.width - 1) / 2;
    const midY = (this.bounds.height - 1) / 2;
    // Scale from the bounding circle, so it stays constant while the view rotates.
    const radius = Math.hypot(this.bounds.width, this.bounds.height) / 2;
    const span = (maxLevel - minLevel) * LEVEL_GAP;
    const scale = Math.min((WIDTH - PADDING * 2) / (2 * radius), (HEIGHT - PADDING * 2) / (2 * radius * TILT + span));
    const project = (x: number, y: number, level: number): [number, number] => {
      const dx = x - midX;
      const dy = y - midY;
      const sx = dx * rx + dy * rz;
      const sy = (dx * cx + dy * cz) * TILT - (level - midLevel) * LEVEL_GAP;
      return [WIDTH / 2 + sx * scale, HEIGHT / 2 + sy * scale];
    };
    const line = (segments: readonly Segment[], level: number, color: string, width: number) => {
      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      ctx.beginPath();
      for (const [ax, ay, bx, by] of segments) {
        ctx.moveTo(...project(ax, ay, level));
        ctx.lineTo(...project(bx, by, level));
      }
      ctx.stroke();
    };

    // Cage: the board outline on every storey plus vertical posts at the corners.
    const x0 = -0.5;
    const y0 = -0.5;
    const x1 = this.bounds.width - 0.5;
    const y1 = this.bounds.height - 0.5;
    const corners: [number, number][] = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
    ctx.setLineDash([2, 3]);
    for (const level of levels) {
      line(corners.map(([ax, ay], i) => [ax, ay, ...corners[(i + 1) % 4]!] as const), level, COLORS.cage, 1);
    }
    if (maxLevel > minLevel) {
      ctx.strokeStyle = COLORS.cage;
      ctx.beginPath();
      for (const [x, y] of corners) {
        ctx.moveTo(...project(x, y, minLevel));
        ctx.lineTo(...project(x, y, maxLevel));
      }
      ctx.stroke();
    }
    ctx.setLineDash([]);

    // Storeys from the bottom up, so higher ones overdraw lower ones.
    for (const shape of this.shapes) {
      const focus = shape.level === this.focus;
      ctx.fillStyle = focus ? COLORS.floorFocus : COLORS.floorOther;
      for (const t of shape.tiles) {
        ctx.beginPath();
        ctx.moveTo(...project(t.x - 0.5, t.y - 0.5, shape.level));
        ctx.lineTo(...project(t.x + 0.5, t.y - 0.5, shape.level));
        ctx.lineTo(...project(t.x + 0.5, t.y + 0.5, shape.level));
        ctx.lineTo(...project(t.x - 0.5, t.y + 0.5, shape.level));
        ctx.closePath();
        ctx.fill();
      }
      line(shape.walls, shape.level, focus ? COLORS.wallFocus : COLORS.wallOther, focus ? 1.4 : 1);
      line(shape.openDoors, shape.level, COLORS.doorOpen, 2);
      line(shape.closedDoors, shape.level, COLORS.doorClosed, 2.4);
    }

    for (const stairs of this.stairs) {
      ctx.strokeStyle = stairs.explored ? COLORS.stairsOpen : COLORS.stairsUnknown;
      ctx.lineWidth = 2;
      ctx.setLineDash(stairs.explored ? [] : [3, 3]);
      ctx.beginPath();
      stairs.route.forEach(([x, y, level], i) => (i === 0 ? ctx.moveTo(...project(x, y, level)) : ctx.lineTo(...project(x, y, level))));
      ctx.stroke();
    }
    ctx.setLineDash([]);

    for (const f of figures) {
      const [x, y] = project(f.x, f.y, f.level);
      ctx.beginPath();
      ctx.arc(x, y, f.monster ? 2.2 : 3.4, 0, Math.PI * 2);
      ctx.fillStyle = f.monster ? COLORS.monster : f.color;
      ctx.globalAlpha = f.level === this.focus ? 1 : 0.55;
      ctx.fill();
      if (!f.monster) {
        ctx.lineWidth = 1;
        ctx.strokeStyle = 'rgba(15, 10, 30, 0.9)';
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }
  }
}
