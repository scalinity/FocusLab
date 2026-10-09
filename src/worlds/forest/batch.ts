import { BatchedMesh, type BufferGeometry, type Material, type Matrix4 } from 'three/webgpu'

/**
 * Instances of several geometries in one object, culled per instance against
 * whichever camera renders it (the viewfinder, the bench, each shadow
 * cascade): three issues one draw per visible instance inside a single
 * object. An InstancedMesh spread across the forest has one bounding sphere
 * that every camera sees, so it is drawn whole for every view. Worth it where
 * most instances are out of a given view (trees); not where they are all in it
 * (ferns), since each visible instance is its own draw.
 */
export function batch(geometries: BufferGeometry[], instances: Array<{ geometry: number; matrix: Matrix4 }>, material: Material): BatchedMesh {
  const used = [...new Set(instances.map((i) => i.geometry))]
  const vertices = used.reduce((n, g) => n + geometries[g].getAttribute('position').count, 0)
  const indices = used.reduce((n, g) => n + (geometries[g].index?.count ?? 0), 0)
  const mesh = new BatchedMesh(instances.length, vertices, indices, material)
  const ids = new Map(used.map((g) => [g, mesh.addGeometry(geometries[g])]))
  for (const i of instances) mesh.setMatrixAt(mesh.addInstance(ids.get(i.geometry)!), i.matrix)
  // Opaque, and Apple GPUs remove hidden surfaces themselves: no per-view depth sort.
  mesh.sortObjects = false
  mesh.castShadow = mesh.receiveShadow = true
  return mesh
}
