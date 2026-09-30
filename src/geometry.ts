import { Mesh, MeshBuilder, Vector3, VertexData, TransformNode, Material, Scene } from '@babylonjs/core';

export type Parent = TransformNode | undefined;
export class Shapes {
  constructor(public scene: Scene) {}
  finish(m: Mesh, mat: Material, parent?: Parent) { m.material = mat; m.parent = parent ?? null; m.receiveShadows = true; return m; }
  box(name: string, x: number, y: number, z: number, w: number, h: number, d: number, mat: Material, parent?: Parent, bevel = .06) {
    const r = Math.min(bevel, w / 4, h / 4, d / 4);
    const positions: number[] = [], indices: number[] = [], uvs: number[] = [];
    const outline = (inset: number) => {
      const result: [number, number][] = []; const a = w / 2 - inset, b = d / 2 - inset, rad = Math.max(.002, r - inset * .5);
      for (let c = 0; c < 4; c++) {
        const cx = c === 0 || c === 3 ? a - rad : -a + rad;
        const cz = c < 2 ? b - rad : -b + rad;
        for (let i = 0; i <= 4; i++) { const t = c * Math.PI / 2 + i / 4 * Math.PI / 2; result.push([cx + Math.cos(t) * rad, cz + Math.sin(t) * rad]); }
      } return result;
    };
    const rings = [[-h / 2, r * .55], [-h / 2 + r, 0], [h / 2 - r, 0], [h / 2, r * .55]];
    const n = 20;
    rings.forEach(([yy, inset]) => outline(inset).forEach(([xx, zz]) => { positions.push(xx, yy, zz); uvs.push((xx / w + .5) * w / 3, (zz / d + .5) * d / 3); }));
    for (let j = 0; j < 3; j++) for (let i = 0; i < n; i++) { const a = j * n + i, b = j * n + (i + 1) % n; indices.push(a, a + n, b, b, a + n, b + n); }
    positions.push(0, -h / 2, 0, 0, h / 2, 0); uvs.push(.5, .5, .5, .5);
    for (let i = 0; i < n; i++) { const j = (i + 1) % n; indices.push(80, i, j, 81, 60 + j, 60 + i); }
    const m = this.mesh(name, positions, indices, mat, parent, uvs); m.position.set(x, y, z); return m;
  }
  mesh(name: string, positions: number[], indices: number[], mat: Material, parent?: Parent, uv?: number[]) {
    for(let i=0;i<indices.length;i+=3){const temp=indices[i+1];indices[i+1]=indices[i+2];indices[i+2]=temp;}
    const m = new Mesh(name, this.scene); const data = new VertexData(); data.positions = positions; data.indices = indices;
    const normals: number[] = []; VertexData.ComputeNormals(positions, indices, normals); data.normals = normals;
    data.uvs = uv ?? positions.flatMap((_, i) => i % 3 === 0 ? [positions[i] / 3, positions[i + 2] / 3] : []); data.applyToMesh(m); return this.finish(m, mat, parent);
  }
  cylinder(name: string, x: number, y: number, z: number, radius: number, height: number, mat: Material, parent?: Parent, top?: number) {
    const m = MeshBuilder.CreateCylinder(name, { height, diameterBottom: radius * 2, diameterTop: (top ?? radius) * 2, tessellation: 20 }, this.scene);
    m.position.set(x, y, z); return this.finish(m, mat, parent);
  }
  beam(name: string, a: Vector3, b: Vector3, radius: number, mat: Material, parent?: Parent) {
    const m = MeshBuilder.CreateTube(name, { path: [a, b], radius, tessellation: 8, cap: Mesh.CAP_ALL }, this.scene); return this.finish(m, mat, parent);
  }
  sphere(name: string, x: number, y: number, z: number, sx: number, sy: number, sz: number, mat: Material, parent?: Parent) {
    const m = MeshBuilder.CreateSphere(name, { diameter: 2, segments: 8 }, this.scene); m.position.set(x, y, z); m.scaling.set(sx, sy, sz); return this.finish(m, mat, parent);
  }
  torus(name: string, x: number, y: number, z: number, diameter: number, thickness: number, mat: Material, parent?: Parent) {
    const m = MeshBuilder.CreateTorus(name, { diameter, thickness, tessellation: 20 }, this.scene); m.position.set(x, y, z); return this.finish(m, mat, parent);
  }
}

export function batch(root: TransformNode, name: string) {
  const groups = new Map<Material, Mesh[]>();
  for (const item of root.getChildMeshes()) if (item instanceof Mesh && item.material && !item.metadata?.noMerge) {
    const list = groups.get(item.material) ?? []; list.push(item); groups.set(item.material, list);
  }
  for (const [mat, list] of groups) {
    if (list.length < 2) continue;
    const merged = Mesh.MergeMeshes(list, true, true, undefined, false, false);
    if (merged) { merged.name = name + '-' + mat.name; merged.parent = root; merged.receiveShadows = true; }
  }
}

export function seedRandom(seed: number) { return () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; }; }
