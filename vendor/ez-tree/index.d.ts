// Type surface of the vendored ez-tree library used by Focus Lab.
import type { BufferGeometry, Group } from 'three'

export interface LodDetail {
  sectionStride?: number
  segmentFactor?: number
  leafStride?: number
  leafScale?: number
  billboard?: 'single' | 'double'
}

export class Tree extends Group {
  options: {
    seed: number
    leaves: { count: number; size: number; sizeVariance: number; billboard: 'single' | 'double' }
    [key: string]: unknown
  }
  loadPreset(name: string): void
  generate(): void
  createGeometry(detail?: LodDetail): { branches: BufferGeometry; leaves: BufferGeometry }
}
