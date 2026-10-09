import type { Node, Object3D, Texture } from 'three/webgpu'
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
  /** Equirectangular HDR environment for image-based lighting and the sky. */
  environment?: Texture
  /** Rotation of the environment about the vertical axis, radians. */
  environmentRotation?: number
  /** Atmosphere (TSL fog node) applied by every world material. */
  fog?: Node
  /**
   * Advances wind and particles to `time` (s). While the exact exposure is
   * accumulating the renderer stops calling it: scene time freezes.
   */
  update?(time: number): void
  /** Freezes shadow maps (true while exposing) or lets them follow the scene. */
  freeze?(frozen: boolean): void
  dispose(): void
}
