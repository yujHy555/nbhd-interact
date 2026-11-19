import * as BABYLON from 'babylonjs';

/**
 * Background sci-fi city — a stylised cluster of the imported building model,
 * placed past the playable strip. Each building is a platform the player can
 * land on, with a collider derived from the REAL mesh bounding box so the
 * collision surface lines up exactly with the visible roof.
 */
export class SciFiCity {
  private scene: BABYLON.Scene;
  private sources: BABYLON.Mesh[] = [];
  private root: BABYLON.TransformNode;

  constructor(scene: BABYLON.Scene) {
    this.scene = scene;
    this.root = new BABYLON.TransformNode('sciFiCity', scene);
  }

  public async load(onCollider: (c: { x: number; y: number; z: number; w: number; h: number; d: number }) => void) {
    const res = await BABYLON.SceneLoader.ImportMeshAsync('', '/models/sci_fi_city/', 'sci_fi_building_01.glb', this.scene);
    const meshes = res.meshes.filter((m) => m instanceof BABYLON.Mesh && m.getTotalVertices() > 0) as BABYLON.Mesh[];
    if (!meshes.length) return;

    // Normalised local bounds across all sub-meshes.
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const m of meshes) {
      m.computeWorldMatrix(true);
      const bb = m.getBoundingInfo().boundingBox;
      minX = Math.min(minX, bb.minimumWorld.x); maxX = Math.max(maxX, bb.maximumWorld.x);
      minY = Math.min(minY, bb.minimumWorld.y); maxY = Math.max(maxY, bb.maximumWorld.y);
      minZ = Math.min(minZ, bb.minimumWorld.z); maxZ = Math.max(maxZ, bb.maximumWorld.z);
    }
    const W = maxX - minX, H = maxY - minY, D = maxZ - minZ;
    const cx = (minX + maxX) / 2, cz = (minZ + maxZ) / 2;

    // Bake each sub-mesh into local space centred on the building, base at y=0.
    for (const m of meshes) {
      const pos = m.getVerticesData(BABYLON.VertexBuffer.PositionKind)!;
      const uv = m.getVerticesData(BABYLON.VertexBuffer.UVKind);
      const nor = m.getVerticesData(BABYLON.VertexBuffer.NormalKind);
      const idx = m.getIndices()!;
      const wm = m.getWorldMatrix();
      const baked: number[] = [], uvs: number[] = [], norms: number[] = [];
      const v = new BABYLON.Vector3(), nv = new BABYLON.Vector3();
      for (let i = 0; i < pos.length; i += 3) {
        BABYLON.Vector3.TransformCoordinatesToRef(new BABYLON.Vector3(pos[i], pos[i + 1], pos[i + 2]), wm, v);
        baked.push(v.x - cx, v.y - minY, v.z - cz);
        if (uv) uvs.push(uv[(i / 3) * 2], uv[(i / 3) * 2 + 1]);
        if (nor) { BABYLON.Vector3.TransformNormalToRef(new BABYLON.Vector3(nor[i], nor[i + 1], nor[i + 2]), wm, nv); norms.push(nv.x, nv.y, nv.z); }
      }
      if (!nor) { const n: number[] = []; BABYLON.VertexData.ComputeNormals(baked, idx, n); norms.push(...n); }
      const vd = new BABYLON.VertexData();
      vd.positions = baked; vd.indices = idx; vd.normals = norms;
      if (uv) vd.uvs = uvs;
      const bakedMesh = new BABYLON.Mesh('sciFiBuildingSrc', this.scene);
      vd.applyToMesh(bakedMesh);
      bakedMesh.material = m.material;
      bakedMesh.receiveShadows = true;
      bakedMesh.setEnabled(false);
      this.sources.push(bakedMesh);
    }

    // Building placements — deep background (large +Z), along the level.
    // Deep background — pushed well back in +Z so they never crowd the
    // travelators/road in the foreground play strip (z ≈ 0).
    const spots = [
      { x: 60, z: 46, s: 1.0 }, { x: 90, z: 56, s: 1.4 }, { x: 130, z: 48, s: 1.1 },
      { x: 180, z: 60, s: 1.6 }, { x: 240, z: 50, s: 1.2 }, { x: 310, z: 62, s: 1.5 },
      { x: 390, z: 52, s: 1.3 }, { x: 470, z: 64, s: 1.7 }, { x: 560, z: 54, s: 1.4 },
      { x: 660, z: 66, s: 1.8 }, { x: 760, z: 56, s: 1.5 },
    ];
    for (let i = 0; i < spots.length; i++) {
      const s = spots[i];
      const bRoot = new BABYLON.TransformNode(`sciFiBuilding${i}`, this.scene);
      bRoot.parent = this.root;
      bRoot.position.set(s.x, 0, s.z);
      bRoot.scaling.setAll(s.s);

      for (const src of this.sources) {
        const inst = src.createInstance(`sciFiBuilding${i}_part`);
        inst.parent = bRoot;
        inst.isPickable = false;
        inst.receiveShadows = true;
      }
      // Collider matching the visible bounding box (top = roof). Use the
      // widest part's footprint: a generous slab the player can land on.
      onCollider({
        x: s.x, y: (H * s.s) / 2, z: s.z,
        w: W * s.s * 0.92, h: H * s.s, d: D * s.s * 0.92,
      });
    }
  }

  public dispose() {
    this.root.dispose(false, true);
    for (const s of this.sources) s.dispose();
  }
}
