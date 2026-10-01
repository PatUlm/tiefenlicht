import { Vector3 } from '@babylonjs/core';
import type { Direction, Position } from '@dungeon/shared';

export { OPPOSITE } from '@dungeon/shared';

/** World units per grid tile (KayKit dungeon modules are 4×4). */
export const CELL = 4;
export const WALL_HEIGHT = 4;
/** Storeys are stacked one wall height apart, so a flight rises 45° over one tile. */
export const LEVEL_HEIGHT = WALL_HEIGHT;

/** World height of the floor of a level. */
export function levelY(level: number): number {
  return level * LEVEL_HEIGHT;
}

// Right-handed scene: +X = east, +Z = south, +Y = up.
export function tileCenter(p: Position, y = 0): Vector3 {
  return new Vector3(p.x * CELL, levelY(p.level) + y, p.y * CELL);
}

/** Tile under a world point on the floor of the given level. */
export function worldToTile(point: Vector3, level: number): Position {
  return { x: Math.round(point.x / CELL), y: Math.round(point.z / CELL), level };
}

/** Yaw that turns a glTF model (facing +Z) towards the given grid direction. */
export function facingAngle(dir: Direction): number {
  switch (dir) {
    case 'S':
      return 0;
    case 'E':
      return Math.PI / 2;
    case 'N':
      return Math.PI;
    case 'W':
      return -Math.PI / 2;
  }
}

export function yawTowards(from: Vector3, to: Vector3): number {
  return Math.atan2(to.x - from.x, to.z - from.z);
}

/** Deterministic pseudo-random value in [0,1) for a tile (stable visual variation). */
export function tileNoise(x: number, y: number, salt = 0): number {
  let h = (x * 374761393 + y * 668265263 + salt * 2147483647) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** Shortest signed angle difference a→b. */
export function angleDelta(a: number, b: number): number {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}
