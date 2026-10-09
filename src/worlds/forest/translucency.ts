import { Vector3, type MeshSSSNodeMaterial } from 'three/webgpu'
import { float, normalWorld, positionWorld, smoothstep, uniform } from 'three/tsl'
import type { Node } from 'three/webgpu'

/**
 * Sunlight through thin living tissue (leaves, petals, mushroom caps): when
 * the camera looks towards the sun through it, it glows in its own colour.
 * It is part of the sun's direct light, so it is shadowed: a fern standing in
 * a trunk's shadow stays dark. Light leaves through the side facing away from
 * the sun, so the glow follows the visible face's normal (face-flipped on
 * double-sided leaves).
 *
 * Shadows are looked up 3 cm towards the sun. The shadow map's normal offset
 * alone would push the lookup on a leaf's shaded face behind the leaf, and the
 * leaf would shadow its own glow. A thick cap still shadows its own centre,
 * so only its rim and gills glow, as they do.
 */
export const sunDirection = uniform(new Vector3(0, 1, 0))

/** `strength` is the glow, in multiples of the albedo, seen straight into the sun. */
export function makeTranslucent(m: MeshSSSNodeMaterial, albedo: Node<'vec3'>, strength: number): void {
  const exit = smoothstep(-0.1, 0.6, normalWorld.dot(sunDirection).negate())
  m.thicknessColorNode = albedo.mul(exit)
  m.thicknessPowerNode = float(4)
  // × the default attenuation (0.1) × the sun's intensity (5) = strength.
  m.thicknessScaleNode = float(2 * strength)
  m.receivedShadowPositionNode = positionWorld.add(sunDirection.mul(0.03))
}
