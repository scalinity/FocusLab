import { Group, Mesh, MeshBasicNodeMaterial, SphereGeometry } from 'three/webgpu'
import { vec3 } from 'three/tsl'
import { LENS_WORLD, type Subject } from '../bench/geometry'
import type { WorldSource } from './WorldSource'

/**
 * Acceptance target for the exact path: small emissive beads on black, so a
 * render is the point-spread function. Each bead spans about 3.5 px at 1920
 * px: big enough that every aperture sample lights several pixels (a
 * sub-pixel bead only lands on pixel centres by chance and the disc comes out
 * as speckle), small enough to leave the blur disc a flat interior. The disc
 * is measured by energy (total / interior level), which is exact for any
 * emitter size that leaves that interior.
 * The 6 m bead sits on the axis; the 1.5 m bead (near field when focused at
 * 3 m) and the 3 m bead (in focus) sit to either side so their discs never
 * overlap.
 */
const BEADS: Array<{ name: string; d: number; tx: number }> = [
  { name: '1.5 m bead', d: 1.5, tx: -0.14 },
  { name: '3 m bead', d: 3, tx: 0.14 },
  { name: '6 m bead', d: 6, tx: 0 },
]
/** Bead radius per metre of distance: constant angular size, ~3.5 px at 1920 px for 50 mm. */
const BEAD_RADIUS_PER_M = 0.00065
const RADIANCE = 4000

export function createPointTargets(): WorldSource {
  const root = new Group()
  root.name = 'point targets'
  const material = new MeshBasicNodeMaterial()
  material.colorNode = vec3(RADIANCE)
  const subjects: Subject[] = []
  for (const b of BEADS) {
    const position = { x: LENS_WORLD.x + b.tx * b.d, y: LENS_WORLD.y, z: LENS_WORLD.z - b.d }
    const bead = new Mesh(new SphereGeometry(BEAD_RADIUS_PER_M * b.d, 16, 12), material)
    bead.position.set(position.x, position.y, position.z)
    root.add(bead)
    subjects.push({ name: b.name, position })
  }
  return {
    root,
    subjects,
    far: subjects[2],
    presets: [
      { name: 'Foreground', distanceM: 1.5 },
      { name: 'Middle', distanceM: 3 },
      { name: 'Background', distanceM: 6 },
    ],
    background: vec3(0),
    dispose() {
      root.traverse((o) => {
        if (o instanceof Mesh) o.geometry.dispose()
      })
      material.dispose()
    },
  }
}

/** Screen-space tangent offsets of the beads, for the harness's measurements. */
export const POINT_TARGETS = BEADS
