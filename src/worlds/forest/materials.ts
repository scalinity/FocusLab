import { Mesh, MeshSSSNodeMaterial, MeshStandardMaterial, MeshStandardNodeMaterial, type Object3D } from 'three/webgpu'
import { color, texture } from 'three/tsl'
import { focusContour } from '../../render/focusContour'
import { makeTranslucent } from './translucency'

/**
 * glTF models arrive with MeshStandardMaterial. Each is replaced by a node
 * material with the same maps that also carries the plane-of-focus cut line,
 * and the meshes cast and receive shadows. A non-zero `translucent` lets
 * thin foliage glow in its own colour when backlit.
 */
export function adoptGltf(root: Object3D, translucent = 0): void {
  const converted = new Map<MeshStandardMaterial, MeshStandardNodeMaterial>()
  root.traverse((o) => {
    if (!(o instanceof Mesh)) return
    o.castShadow = true
    o.receiveShadow = true
    const src = o.material as MeshStandardMaterial
    let m = converted.get(src)
    if (m === undefined) {
      const params = {
        map: src.map,
        normalMap: src.normalMap,
        normalScale: src.normalScale,
        roughnessMap: src.roughnessMap,
        metalnessMap: src.metalnessMap,
        aoMap: src.aoMap,
        roughness: src.roughness,
        metalness: src.metalness,
        color: src.color,
        alphaTest: src.alphaTest,
        side: src.side,
        transparent: false,
      }
      if (translucent > 0 && src.map) {
        const sss = new MeshSSSNodeMaterial(params)
        makeTranslucent(sss, texture(src.map).rgb.mul(color(src.color)), translucent)
        m = sss
      } else {
        m = new MeshStandardNodeMaterial(params)
      }
      m.emissiveNode = focusContour()
      converted.set(src, m)
    }
    o.material = m
  })
}
