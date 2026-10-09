import { Matrix3, Matrix4, Vector3, type Texture } from 'three/webgpu'
import {
  cameraPosition,
  equirectUV,
  exp,
  fog,
  max,
  mix,
  normalize,
  positionWorld,
  positionWorldDirection,
  pow,
  texture,
  uniform,
  vec3,
} from 'three/tsl'
import type { Node } from 'three/webgpu'

/**
 * Height fog with aerial perspective, in every world material so the live and
 * exact paths see identical haze, and in the sky so distant geometry and the
 * HDRI behind it fade into the same air.
 *
 * Density falls with height as exp(−K·y). Along a ray to infinity rising at
 * angle α the optical depth integrates to DENSITY / (K·sin α), which gives the
 * sky's haze in closed form: thick at the horizon, thin overhead.
 *
 * The air is lit like the forest it hangs in: dim and cool in the shade, warm
 * only when looking towards the low sun (forward scattering).
 */
const DENSITY = 0.004
const K = 0.06

export interface Atmosphere {
  fog: Node
  background: Node
}

export function forestAtmosphere(sunDirection: Vector3, sky: Texture, skyRotation: number): Atmosphere {
  const sun = uniform(sunDirection.clone().normalize())
  const airColour = (view: Node<'vec3'>): Node<'vec3'> => {
    const forward = pow(max(view.dot(sun), 0), 12)
    return mix(vec3(0.085, 0.1, 0.11), vec3(1.1, 0.72, 0.4), forward)
  }

  const toPoint = positionWorld.sub(cameraPosition)
  const view = normalize(toPoint)
  const depth = toPoint.length().mul(DENSITY).mul(exp(max(positionWorld.y, 0).mul(-K)))
  const fogNode = fog(airColour(view), exp(depth.negate()).oneMinus())

  const rotate = uniform(new Matrix3().setFromMatrix4(new Matrix4().makeRotationY(skyRotation)))
  const dir = positionWorldDirection
  const skyColour = texture(sky, equirectUV(rotate.mul(dir))).rgb
  const skyDepth = max(dir.y, 0.02).mul(K).reciprocal().mul(DENSITY)
  const background = mix(skyColour, airColour(dir), exp(skyDepth.negate()).oneMinus())

  return { fog: fogNode, background }
}
