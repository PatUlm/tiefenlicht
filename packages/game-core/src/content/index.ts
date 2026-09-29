// Server-only content: it contains the hidden rooms (M6). The package export is
// restricted to the `node` condition, so a browser bundle cannot resolve it.
import type { DungeonDefinition } from '@dungeon/shared';
import prototypeDungeon from './prototype-dungeon.json' with { type: 'json' };

// JSON imports widen literal types, so TypeScript cannot check this cast.
// validateDungeon checks shape, enums and invariants at runtime instead
// (unit test on this map + server start-up check).
export const PROTOTYPE_DUNGEON = prototypeDungeon as unknown as DungeonDefinition;
