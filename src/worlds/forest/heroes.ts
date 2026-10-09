import {
  BufferAttribute,
  CylinderGeometry,
  Group,
  InstancedMesh,
  LatheGeometry,
  Matrix4,
  Mesh,
  MeshSSSNodeMaterial,
  MeshStandardNodeMaterial,
  Quaternion,
  SphereGeometry,
  Vector2,
  Vector3,
  type BufferGeometry,
  type Object3D,
} from 'three/webgpu'
import { mix, normalLocal, normalMap, smoothstep, texture, uv, vec2, vec3, vertexColor } from 'three/tsl'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { LENS_WORLD, type Subject } from '../../bench/geometry'
import { focusContour } from '../../render/focusContour'
import type { PbrSet } from './assets'
import { fbm, rng } from './noise'
import { groundHeight } from './terrain'
import { makeTranslucent } from './translucency'
import { barkMaterial } from './trees'

/**
 * The composed foreground, placed for the low tripod (lens 0.45 m above the
 * ground, looking along −z with a 50 mm lens) at roughly log-spaced depths:
 * mushrooms on a mossy log edge at 0.35 m, a dewy fern frond at 0.8 m,
 * wood anemones around 1.5 m, a mossy trunk at 3 m, a fallen log at 7 m.
 */

const L = LENS_WORLD

export interface Heroes {
  group: Group
  subjects: Subject[]
}

/** A fallen log with bark on its flanks and moss over its top. */
function mossyLog(bark: PbrSet, moss: PbrSet, length: number, radius: number): Mesh {
  const geo = new CylinderGeometry(radius, radius * 0.93, length, 64, 48, true)
  const pos = geo.getAttribute('position') as BufferAttribute
  const v = new Vector3()
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i)
    // Irregular bark ridges and moss cushions. Noise is sampled from position,
    // not angle, so it stays continuous all the way round.
    const bump = 1 + 0.06 * fbm(v.x * 6 + v.y * 2.5, v.z * 6 - v.y * 2.5, 4, 7) + 0.03 * fbm(v.x * 24, v.z * 24 + v.y * 10, 3, 9)
    pos.setXYZ(i, v.x * bump, v.y, v.z * bump)
  }
  geo.computeVertexNormals()
  const m = new MeshStandardNodeMaterial()
  const t = uv().mul(vec2(3, length * 1.2))
  // Cylinder axis is local y; "up" after it is laid down is local −z... use the
  // radial normal's component that ends up pointing at the sky (local x here).
  const mossy = smoothstep(-0.15, 0.45, normalLocal.x).mul(0.95)
  m.colorNode = mix(texture(bark.color, t).rgb, texture(moss.color, t.mul(1.4)).rgb.mul(vec3(0.85, 1, 0.75)), mossy)
  m.normalNode = normalMap(mix(texture(bark.normal, t), texture(moss.normal, t.mul(1.4)), mossy), vec2(1.3))
  m.roughnessNode = mix(texture(bark.roughness, t).r, texture(moss.roughness, t.mul(1.4)).r, mossy)
  m.emissiveNode = focusContour()
  const mesh = new Mesh(geo, m)
  mesh.castShadow = mesh.receiveShadow = true
  return mesh
}

/**
 * A standing trunk that rises out of frame: flared roots at the base, uneven
 * girth, uv in metres so the bark keeps its scale (barkMaterial samples
 * uv × (1, 0.35): twice round, every 0.8 m up).
 */
function trunkGeometry(radius: number, height: number): BufferGeometry {
  const geo = new CylinderGeometry(radius * 0.6, radius, height, 48, 96, true)
  geo.translate(0, height / 2, 0)
  const pos = geo.getAttribute('position') as BufferAttribute
  const uvs = geo.getAttribute('uv') as BufferAttribute
  const v = new Vector3()
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i)
    const a = Math.atan2(v.z, v.x)
    const flare = 1 + 0.55 * Math.exp(-v.y / 0.35) * (0.7 + 0.3 * Math.cos(a * 5))
    const bump = 1 + 0.05 * fbm(v.x * 4 + v.y * 0.6, v.z * 4 + v.y * 1.5, 4, 5)
    pos.setXYZ(i, v.x * flare * bump, v.y, v.z * flare * bump)
    uvs.setXY(i, uvs.getX(i) * 2, v.y / 0.28)
  }
  geo.computeVertexNormals()
  return geo
}

/**
 * A small brown mushroom: a lathed cap, dark at the centre and paler towards
 * the rim with faint radial streaks, striped gills underneath, and a stem that
 * browns towards its base. The lathe profile runs bottom to top (gills out to
 * the rim, then over the dome to the apex) so its faces point outwards.
 */
function mushroomGeometry(capRadius: number, height: number): BufferGeometry {
  const r = capRadius
  const segments = 64
  const profile = [
    new Vector2(r * 0.13, height - r * 0.2),
    new Vector2(r * 0.5, height - r * 0.15),
    new Vector2(r * 0.92, height - r * 0.09),
    new Vector2(r, height - r * 0.04),
  ]
  const GILLS = 3
  const n = 12
  for (let i = n; i >= 0; i--) {
    const a = ((i / n) * Math.PI) / 2
    profile.push(new Vector2(r * Math.sin(a) + 1e-5, height + r * 0.6 * Math.cos(a)))
  }
  const capGeo = new LatheGeometry(profile, segments)
  const streak = rng(Math.round(r * 1e5))
  const streaks = Array.from({ length: segments }, () => 0.9 + 0.2 * streak())
  const capColour = new Float32Array(capGeo.getAttribute('position').count * 3)
  for (let v = 0; v < capColour.length / 3; v++) {
    const column = Math.floor(v / profile.length) % segments
    const j = v % profile.length
    const rho = profile[j].x / r
    let c: [number, number, number]
    if (j < GILLS) {
      const g = (column % 2 ? 0.72 : 1) * (0.75 + 0.25 * rho)
      c = [0.6 * g, 0.47 * g, 0.32 * g]
    } else {
      const t = Math.pow(rho, 1.5)
      const s = streaks[column]
      c = [(0.26 + 0.34 * t) * s, (0.13 + 0.25 * t) * s, (0.05 + 0.14 * t) * s]
    }
    capColour.set(c, v * 3)
  }
  capGeo.setAttribute('color', new BufferAttribute(capColour, 3))

  const stemGeo = new CylinderGeometry(r * 0.11, r * 0.16, height, 12, 4, true)
  stemGeo.translate(0, height / 2, 0)
  const sp = stemGeo.getAttribute('position')
  const stemColour = new Float32Array(sp.count * 3)
  for (let v = 0; v < sp.count; v++) {
    const t = Math.min(1, sp.getY(v) / (height * 0.6))
    stemColour.set([0.4 + 0.42 * t, 0.28 + 0.47 * t, 0.16 + 0.44 * t], v * 3)
  }
  stemGeo.setAttribute('color', new BufferAttribute(stemColour, 3))
  return mergeGeometries([capGeo.toNonIndexed(), stemGeo.toNonIndexed()])!
}

/** A wood anemone: green stem, six white petals, yellow centre. */
function anemoneGeometry(height: number): BufferGeometry {
  const parts: BufferGeometry[] = []
  const tint = (g: BufferGeometry, rgb: [number, number, number]) => {
    const p = g.getAttribute('position')
    const c = new Float32Array(p.count * 3)
    for (let i = 0; i < p.count; i++) c.set(rgb, i * 3)
    g.setAttribute('color', new BufferAttribute(c, 3))
    return g.index ? g.toNonIndexed() : g
  }
  const stem = new CylinderGeometry(0.0012, 0.0018, height, 6, 1, true)
  stem.translate(0, height / 2, 0)
  parts.push(tint(stem, [0.18, 0.32, 0.1]))
  for (let i = 0; i < 6; i++) {
    const petal = new SphereGeometry(1, 8, 4, 0, Math.PI * 2, 0, Math.PI / 2)
    petal.scale(0.011, 0.0025, 0.006)
    petal.translate(0.012, 0, 0)
    petal.rotateZ(0.35)
    petal.rotateY((i / 6) * Math.PI * 2)
    petal.translate(0, height, 0)
    parts.push(tint(petal, [0.95, 0.94, 0.9]))
  }
  const centre = new SphereGeometry(0.0035, 8, 6)
  centre.translate(0, height + 0.002, 0)
  parts.push(tint(centre, [0.95, 0.75, 0.1]))
  return mergeGeometries(parts)!
}

function vertexColourMaterial(translucent: number): MeshSSSNodeMaterial {
  const m = new MeshSSSNodeMaterial({ roughness: 0.55 })
  const albedo = vertexColor()
  m.colorNode = albedo
  m.emissiveNode = focusContour()
  makeTranslucent(m, albedo.rgb, translucent)
  return m
}

const onGround = (x: number, z: number): Vector3 => new Vector3(x, groundHeight(x, z), z)

/** `fern` and `deadTrunk` are glTF content already given node materials (adoptGltf). */
export function createHeroes(bark: PbrSet, moss: PbrSet, fern: Mesh, deadTrunk: Object3D): Heroes {
  const group = new Group()
  group.name = 'heroes'
  const rand = rng(77)

  // 0.35 m — a mossy log across the bottom of the frame, mushrooms on its top edge.
  const axis = new Vector3(0.91, 0, -0.41).normalize()
  const logRadius = 0.15
  const logCentre = new Vector3(L.x - 0.07, L.y - 0.06 - logRadius, L.z - 0.35).addScaledVector(axis, -0.5)
  const log = mossyLog(bark, moss, 1.9, logRadius)
  // Cylinder axis (local y) along `axis`; local x (moss side) pointing up.
  const basis = new Matrix4().makeBasis(new Vector3(0, 1, 0), axis, new Vector3(0, 1, 0).cross(axis).normalize())
  log.quaternion.setFromRotationMatrix(basis)
  log.position.copy(logCentre)
  group.add(log)

  const mushroomMat = vertexColourMaterial(1.4)
  const shrooms: Array<[number, number, number, number]> = [
    // t along the axis, sideways offset, cap radius, height (m)
    [0.43, 0.01, 0.011, 0.026],
    [0.47, -0.012, 0.016, 0.036],
    [0.5, 0.006, 0.009, 0.019],
    [0.535, -0.004, 0.013, 0.031],
    [0.58, 0.014, 0.007, 0.015],
  ]
  const side = new Vector3(0, 1, 0).cross(axis).normalize()
  for (const [t, s, r, h] of shrooms) {
    const m = new Mesh(mushroomGeometry(r, h), mushroomMat)
    m.position.copy(logCentre).addScaledVector(axis, t).addScaledVector(side, s).add(new Vector3(0, logRadius * 0.97, 0))
    m.rotation.set((rand() - 0.5) * 0.25, rand() * 6.28, (rand() - 0.5) * 0.25)
    m.castShadow = m.receiveShadow = true
    group.add(m)
  }

  // 0.8 m — a fern arching in from the right at lens height.
  const heroFern = fern.clone()
  heroFern.scale.setScalar(1.55)
  heroFern.position.copy(onGround(L.x + 0.32, L.z - 0.95))
  heroFern.rotation.y = 2.4
  group.add(heroFern)

  // Dew on the fronds that cross the frame. Seen against the sun, a drop
  // refracts it towards the lens and shows as a bright point (the sparkle of
  // dew in backlight), shadowed like any direct light; defocused, the points
  // become bokeh.
  heroFern.updateMatrixWorld(true)
  // Candidates: frond vertices inside the 50 mm frame (36 × 24 mm at 50 mm).
  const candidates: Vector3[] = []
  heroFern.traverse((o) => {
    if (!(o instanceof Mesh)) return
    const p = o.geometry.getAttribute('position')
    const nrm = o.geometry.getAttribute('normal')
    const w = new Vector3()
    const nw = new Vector3()
    for (let i = 0; i < p.count; i++) {
      w.fromBufferAttribute(p, i).applyMatrix4(o.matrixWorld)
      const d = L.z - w.z
      if (d < 0.6 || d > 1.05) continue
      if (Math.abs(w.x - L.x) > d * 0.36 || Math.abs(w.y - L.y) > d * 0.24) continue
      nw.fromBufferAttribute(nrm, i).transformDirection(o.matrixWorld)
      candidates.push(w.clone().addScaledVector(nw, 0.002))
    }
  })
  const drops = Array.from({ length: Math.min(48, candidates.length) }, () => candidates.splice(Math.floor(rand() * candidates.length), 1)[0])
  const dropMat = new MeshSSSNodeMaterial({ color: 0x0a0d0c, roughness: 0.03, metalness: 0 })
  dropMat.emissiveNode = focusContour()
  makeTranslucent(dropMat, vec3(1), 30)
  console.info(`[forest] dew: ${drops.length} drops`)
  const dews = new InstancedMesh(new SphereGeometry(1, 12, 8), dropMat, drops.length)
  drops.forEach((p, i) => dews.setMatrixAt(i, new Matrix4().compose(p, new Quaternion(), new Vector3().setScalar(0.0014 + rand() * 0.0012))))
  group.add(dews)

  // ~1.5 m — a drift of wood anemones.
  const anemoneMat = vertexColourMaterial(1.1)
  const flower = anemoneGeometry(1)
  const count = 70
  const flowers = new InstancedMesh(flower, anemoneMat, count)
  const mtx = new Matrix4()
  for (let i = 0; i < count; i++) {
    const a = rand() * Math.PI * 2
    const r = Math.sqrt(rand()) * 0.9
    const x = L.x - 0.1 + Math.cos(a) * r * 1.2
    const z = L.z - 1.7 + Math.sin(a) * r * 0.7
    const h = 0.17 + rand() * 0.16
    const tilt = new Quaternion().setFromAxisAngle(new Vector3(rand() - 0.5, 0, rand() - 0.5).normalize(), rand() * 0.25)
    mtx.compose(onGround(x, z), tilt, new Vector3(1, h, 1))
    flowers.setMatrixAt(i, mtx)
  }
  flowers.castShadow = flowers.receiveShadow = true
  group.add(flowers)

  // 3 m — a mossy trunk left of centre, its near face at 3 m.
  const trunkRadius = 0.24
  const trunk = new Mesh(trunkGeometry(trunkRadius, 14), barkMaterial(bark, moss))
  trunk.position.copy(onGround(L.x - 0.35, L.z - 3 - trunkRadius)).add(new Vector3(0, -0.08, 0))
  trunk.rotation.y = 0.7
  trunk.castShadow = trunk.receiveShadow = true
  group.add(trunk)

  // 7 m — a fallen log across the view.
  const fallen = deadTrunk.clone(true)
  fallen.scale.setScalar(1.4)
  fallen.position.copy(onGround(L.x + 0.5, L.z - 7.2))
  fallen.position.y -= 0.05
  fallen.rotation.y = 0.12
  group.add(fallen)

  const subject = (name: string, p: Vector3): Subject => ({ name, position: { x: p.x, y: p.y, z: p.z } })
  const capTop = logCentre.clone().addScaledVector(axis, 0.47).add(new Vector3(0, logRadius + 0.036, 0))
  return {
    group,
    subjects: [
      subject('mushroom', capTop),
      subject('fern', new Vector3(L.x + 0.12, L.y - 0.02, L.z - 0.8)),
      subject('anemones', onGround(L.x - 0.1, L.z - 1.6).add(new Vector3(0, 0.3, 0))),
      subject('trunk', new Vector3(L.x - 0.35, L.y + 0.2, L.z - 3)),
      subject('fallen log', onGround(L.x + 0.5, L.z - 7.2).add(new Vector3(0, 0.25, 0))),
    ],
  }
}
