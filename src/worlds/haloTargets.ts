import { Group, Mesh, MeshBasicNodeMaterial, PlaneGeometry } from 'three/webgpu'
import { float, floor, mix, uv, vec3 } from 'three/tsl'
import { LENS_WORLD, type Subject } from '../bench/geometry'
import type { WorldSource } from './WorldSource'

/**
 * Acceptance target for the live path's edge cases, on black, unlit so both
 * paths see identical radiance. Rectangles are given in tangents of the
 * viewing angle (x/d, y/d) so they land at fixed places in the frame.
 *
 * Left — sharp in front of blur: a dark card in focus at 3 m against a bright
 * wall at 20 m. A halo would show as wall colour bleeding over the card or
 * the card darkening the wall around it.
 * Right — blur in front of sharp: a dark card at 1 m over an in-focus checker
 * wall at 3 m. Its blurred edge must be soft and see-through, not hard.
 */
export interface Rect {
  d: number
  /** [left, right] and [bottom, top] in tangents. */
  tx: [number, number]
  ty: [number, number]
}

export const HALO = {
  wall: { d: 20, tx: [-0.34, -0.05], ty: [-0.2, 0.2] } as Rect,
  sharpCard: { d: 3, tx: [-0.25, -0.15], ty: [-0.08, 0.08] } as Rect,
  checker: { d: 3, tx: [0.02, 0.34], ty: [-0.2, 0.2] } as Rect,
  nearCard: { d: 1, tx: [-0.02, 0.18], ty: [-0.15, 0.15] } as Rect,
}

function panel(r: Rect, material: MeshBasicNodeMaterial): Mesh {
  const w = (r.tx[1] - r.tx[0]) * r.d
  const h = (r.ty[1] - r.ty[0]) * r.d
  const m = new Mesh(new PlaneGeometry(w, h), material)
  m.position.set(
    LENS_WORLD.x + ((r.tx[0] + r.tx[1]) / 2) * r.d,
    LENS_WORLD.y + ((r.ty[0] + r.ty[1]) / 2) * r.d,
    LENS_WORLD.z - r.d,
  )
  return m
}

const basic = (value: number): MeshBasicNodeMaterial => {
  const m = new MeshBasicNodeMaterial()
  m.colorNode = vec3(value)
  return m
}

export function createHaloTargets(): WorldSource {
  const root = new Group()
  root.name = 'halo targets'
  const checker = new MeshBasicNodeMaterial()
  const cells = floor(uv().mul(vec3(24, 30, 0).xy))
  checker.colorNode = vec3(mix(float(0.08), float(1.5), cells.x.add(cells.y).mod(2)))
  const materials = [basic(2), basic(0.1), checker, basic(0.05)]
  root.add(
    panel(HALO.wall, materials[0]),
    panel(HALO.sharpCard, materials[1]),
    panel(HALO.checker, materials[2]),
    panel(HALO.nearCard, materials[3]),
  )
  const centre = (r: Rect): Subject['position'] => ({
    x: LENS_WORLD.x + ((r.tx[0] + r.tx[1]) / 2) * r.d,
    y: LENS_WORLD.y + ((r.ty[0] + r.ty[1]) / 2) * r.d,
    z: LENS_WORLD.z - r.d,
  })
  const subjects: Subject[] = [
    { name: '1 m card', position: centre(HALO.nearCard) },
    { name: '3 m card', position: centre(HALO.sharpCard) },
    { name: '20 m wall', position: centre(HALO.wall) },
  ]
  return {
    root,
    subjects,
    far: subjects[2],
    presets: [
      { name: 'Foreground', distanceM: 1 },
      { name: 'Middle', distanceM: 3 },
      { name: 'Background', distanceM: 20 },
    ],
    background: vec3(0),
    dispose() {
      root.traverse((o) => {
        if (o instanceof Mesh) o.geometry.dispose()
      })
      for (const m of materials) m.dispose()
    },
  }
}
