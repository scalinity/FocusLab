import type { Node, Object3D } from 'three/webgpu'
import type { Subject } from '../bench/geometry'

/**
 * A world the camera looks at. The optics, the bench and the passes never
 * know which one is active.
 */
export interface WorldSource {
  /** Object-space content, world metres (y up, the camera looks along −z). */
  root: Object3D
  /** Hero subjects in world metres, nearest first. */
  subjects: Subject[]
  /** The far subject whose bundle is always drawn. */
  far: Subject
  /** Foreground, middle and background focus targets (number keys 1–3). */
  presets: Array<{ name: string; distanceM: number }>
  /** Sky or backdrop (TSL node); a default sky when absent. */
  background?: Node
  dispose(): void
}
