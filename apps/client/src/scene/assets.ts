import {
  Color3,
  LoadAssetContainerAsync,
  Mesh,
  PBRMaterial,
  StandardMaterial,
  TransformNode,
  type AbstractMesh,
  type AnimationGroup,
  type AssetContainer,
  type InstancedMesh,
  type Material,
  type Scene,
  type Texture,
} from '@babylonjs/core';
import '@babylonjs/loaders/glTF';
import { createDungeonPalettes, STONE_MODELS } from './palette.ts';

/** Static dungeon modules: one mesh each, rendered as instances. */
export const DUNGEON_MODELS = [
  'floor_tile_large',
  'floor_tile_large_rocks',
  'floor_tile_big_grate',
  'floor_dirt_large',
  'floor_wood_large',
  'wall',
  'wall_cracked',
  'wall_arched',
  'wall_broken',
  'barrier',
  'pillar',
  'pillar_decorated',
  'barrel_large',
  'barrel_small_stack',
  'crates_stacked',
  'box_stacked',
  'keg_decorated',
  'table_long_decorated_A',
  'table_medium_decorated_A',
  'candle_triple',
  'candle_lit',
  'candle_melted',
  'torch_mounted',
  'banner_patternA_red',
  'banner_patternB_green',
  'banner_thin_blue',
  'sword_shield',
  'rubble_half',
  'bottle_A_green',
  'bottle_B_brown',
  'bottle_C_green',
  'coin_stack_medium',
  'shelves',
  'column',
] as const;
export type DungeonModel = (typeof DUNGEON_MODELS)[number];

/** Multi-node dungeon models that are cloned as hierarchies (doors, chests). */
export const HIERARCHY_MODELS = ['wall_doorway', 'chest_gold', 'chest'] as const;
export type HierarchyModel = (typeof HIERARCHY_MODELS)[number];

export const CHARACTER_MODELS = [
  'Barbarian',
  'Rogue_Hooded',
  'Knight',
  'Skeleton_Warrior',
  'Skeleton_Minion',
  'Skeleton_Mage',
] as const;
export type CharacterModel = (typeof CHARACTER_MODELS)[number];

export const WEAPON_MODELS = ['Skeleton_Blade', 'Skeleton_Staff', 'Skeleton_Axe', 'Skeleton_Shield_Small_A'] as const;
export type WeaponModel = (typeof WEAPON_MODELS)[number];

export interface CharacterInstance {
  readonly root: TransformNode;
  readonly meshes: AbstractMesh[];
  readonly animations: Map<string, AnimationGroup>;
  findNode(name: string): TransformNode | undefined;
}

/**
 * Maximum lights a material considers. Babylon binds one uniform block per light
 * plus two shared ones, and WebGL2 on ANGLE/D3D11 (Chrome on Windows) allows only
 * 12 blocks per fragment shader: beyond that every lit material fails to compile.
 */
const MAX_LIGHTS = 8;
/** Point lights (torches, candles, magic) on at once: all lights minus ambient and key light. */
export const MAX_POINT_LIGHTS = MAX_LIGHTS - 2;

/**
 * Loads all glTF assets once and hands out cheap copies. Materials are converted
 * from PBR to StandardMaterial: the KayKit palette textures read better with
 * simple diffuse lighting and coloured point lights than with an IBL-less PBR.
 */
export class AssetLibrary {
  private readonly sources = new Map<DungeonModel, Mesh>();
  private readonly hierarchies = new Map<HierarchyModel, AssetContainer>();
  private readonly characters = new Map<CharacterModel, AssetContainer>();
  private readonly weapons = new Map<WeaponModel, Mesh>();
  private readonly materials = new Map<Material, StandardMaterial>();

  constructor(private readonly scene: Scene) {}

  async load(onProgress: (loaded: number, total: number) => void): Promise<void> {
    // Dungeon models get the recoloured palette (see palette.ts); figures keep theirs.
    const palettes = await createDungeonPalettes(this.scene);
    const paletteFor = (name: string) => palettes[STONE_MODELS.has(name) ? 'stone' : 'base'];
    const jobs: (() => Promise<void>)[] = [
      ...DUNGEON_MODELS.map((name) => async () => {
        this.sources.set(name, await this.loadSingleMesh(`/models/dungeon/${name}.glb`, name, paletteFor(name)));
      }),
      ...WEAPON_MODELS.map((name) => async () => {
        this.weapons.set(name, await this.loadSingleMesh(`/models/weapons/${name}.gltf`, name));
      }),
      ...HIERARCHY_MODELS.map((name) => async () => {
        const container = await LoadAssetContainerAsync(`/models/dungeon/${name}.glb`, this.scene);
        this.convertMaterials(container, paletteFor(name));
        this.hierarchies.set(name, container);
      }),
      ...CHARACTER_MODELS.map((name) => async () => {
        const container = await LoadAssetContainerAsync(`/models/characters/${name}.glb`, this.scene);
        this.convertMaterials(container);
        this.characters.set(name, container);
      }),
    ];
    let loaded = 0;
    onProgress(0, jobs.length);
    await Promise.all(
      jobs.map(async (job) => {
        await job();
        onProgress(++loaded, jobs.length);
      }),
    );
  }

  /** A new instance of a static dungeon module. */
  instance(model: DungeonModel, name = model): InstancedMesh {
    const source = this.sources.get(model);
    if (!source) throw new Error(`Model not loaded: ${model}`);
    const inst = source.createInstance(name);
    inst.rotationQuaternion = null;
    inst.isPickable = false;
    return inst;
  }

  /** The shared material of a static module (e.g. to derive tinted variants). */
  sourceMesh(model: DungeonModel): Mesh {
    return this.sources.get(model)!;
  }

  weapon(model: WeaponModel): Mesh {
    const source = this.weapons.get(model)!;
    const clone = source.clone(`${model}-copy`, null)!;
    clone.rotationQuaternion = null;
    clone.isVisible = true;
    clone.isPickable = false;
    return clone;
  }

  /** A cloned node hierarchy (door frame + leaf, chest + lid). */
  hierarchy(model: HierarchyModel): TransformNode {
    const container = this.hierarchies.get(model)!;
    const entries = container.instantiateModelsToScene((n) => `${model}:${n}`, false, { doNotInstantiate: true });
    const root = entries.rootNodes[0] as TransformNode;
    root.rotationQuaternion = null;
    for (const m of root.getChildMeshes()) m.isPickable = false;
    return root;
  }

  character(model: CharacterModel, cloneMaterials = false): CharacterInstance {
    const container = this.characters.get(model)!;
    const entries = container.instantiateModelsToScene((n) => `${model}:${n}`, cloneMaterials, {
      doNotInstantiate: true,
    });
    const root = entries.rootNodes[0] as TransformNode;
    const animations = new Map<string, AnimationGroup>();
    for (const group of entries.animationGroups) {
      group.stop();
      animations.set(group.name.replace(`${model}:`, ''), group);
    }
    const nodes = root.getChildTransformNodes(false);
    return {
      root,
      meshes: root.getChildMeshes(false),
      animations,
      findNode: (name) => nodes.find((n) => n.name === `${model}:${name}`) ?? nodes.find((n) => n.name.endsWith(name)),
    };
  }

  private async loadSingleMesh(url: string, name: string, palette?: Texture): Promise<Mesh> {
    const container = await LoadAssetContainerAsync(url, this.scene);
    this.convertMaterials(container, palette);
    container.addAllToScene();
    const meshes = container.meshes.filter((m): m is Mesh => m instanceof Mesh && m.getTotalVertices() > 0);
    let mesh: Mesh;
    if (meshes.length === 1) {
      mesh = meshes[0]!;
      mesh.setParent(null);
    } else {
      mesh = Mesh.MergeMeshes(meshes, true, true, undefined, false, true)!;
    }
    mesh.name = name;
    mesh.bakeCurrentTransformIntoVertices();
    // glTF nodes carry a rotationQuaternion, which instances would inherit and
    // which would silently override every `rotation` set later.
    mesh.rotationQuaternion = null;
    for (const m of container.meshes) if (m !== mesh && !m.isDisposed()) m.dispose();
    for (const t of container.transformNodes) t.dispose();
    // Source stays enabled but invisible: its instances render independently.
    mesh.isVisible = false;
    mesh.isPickable = false;
    mesh.alwaysSelectAsActiveMesh = false;
    return mesh;
  }

  private convertMaterials(container: AssetContainer, palette?: Texture): void {
    for (const mesh of container.meshes) {
      if (!mesh.material) continue;
      const std = this.toStandard(mesh.material);
      // Every dungeon file has its own material, so swapping the texture is local to it.
      if (palette) std.diffuseTexture = palette;
      mesh.material = std;
    }
  }

  private toStandard(material: Material): StandardMaterial {
    const cached = this.materials.get(material);
    if (cached) return cached;
    const std = new StandardMaterial(`${material.name}-std`, this.scene);
    if (material instanceof PBRMaterial) {
      std.diffuseTexture = material.albedoTexture;
      // The glTF loader flags base colour textures as linear for PBR; the
      // StandardMaterial pipeline expects sRGB textures, otherwise colours darken.
      if (std.diffuseTexture) std.diffuseTexture.gammaSpace = true;
      std.diffuseColor = material.albedoTexture ? Color3.White() : material.albedoColor.clone();
      std.emissiveColor = material.emissiveColor.clone();
      if (material.emissiveTexture) std.emissiveTexture = material.emissiveTexture;
      std.backFaceCulling = material.backFaceCulling;
    }
    std.specularColor = new Color3(0.06, 0.06, 0.06);
    std.specularPower = 32;
    std.maxSimultaneousLights = MAX_LIGHTS;
    this.materials.set(material, std);
    return std;
  }
}

export { MAX_LIGHTS };
