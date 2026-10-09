import {
  AdditiveBlending,
  BufferGeometry,
  Color,
  Float32BufferAttribute,
  HalfFloatType,
  IndirectStorageBufferAttribute,
  Mesh,
  NodeMaterial,
  OrthographicCamera,
  QuadMesh,
  RenderTarget,
  Scene,
  Vector4,
  type Node,
  type PerspectiveCamera,
  type WebGPURenderer,
} from 'three/webgpu'
import {
  Fn,
  If,
  Loop,
  abs,
  atomicAdd,
  atomicStore,
  dot,
  float,
  fract,
  instanceIndex,
  instancedArray,
  int,
  ivec2,
  max,
  min,
  mix,
  mrt,
  output,
  positionGeometry,
  positionView,
  screenCoordinate,
  screenUV,
  select,
  sin,
  smoothstep,
  storage,
  texture,
  textureLoad,
  uint,
  uniform,
  uniformArray,
  uvec2,
  vec2,
  vec3,
  vec4,
} from 'three/tsl'
import { apertureOutline, apertureRadius, sampleAperture, type Aperture } from '../optics/aperture'
import { r2 } from '../optics/sequence'
import { fxaa } from 'three/addons/tsl/display/FXAANode.js'

/**
 * Live depth of field: hybrid gather + scatter on linear HDR, in the spirit
 * of Jimenez (CoD: Advanced Warfare, SIGGRAPH 2014) and Unreal's diaphragm
 * DOF, driven by exactly the blur of the optics module:
 * c_px = cocScale · (k − 1/d), d the axial (view-space) depth.
 *
 *   scene (MRT: HDR colour, axial depth; one sample per pixel)
 *   → prefilter (half res, three fields: far, near, in focus)
 *   → tiles (compute: largest near blur per 16 px tile, dilated)
 *   → far gather (+ background estimate behind near objects), near gather
 *   → highlight scatter (compute append → indirect aperture-polygon sprites)
 *   → composite (full res: sharp → far → near)
 *
 * Field separation happens at the downsample: every half-res texel keeps the
 * far, near and in-focus parts of its 2×2 block as separate premultiplied
 * colours with their own coverage, so an in-focus edge never lends its colour
 * to the background blur next to it (a dark halo), and partial near texels
 * give partial alpha (coverage-correct soft foreground edges).
 *
 * Shapes follow refinement 4: a point's blur in the photo is the aperture
 * upright in the far field and rotated 180° in the near field. Bright pixels
 * with a large CoC are split: the part above HIGHLIGHT is scattered as
 * sprites with energy conserved, the rest is gathered, so no light is
 * counted twice.
 *
 * Kernel cap: MAX_RADIUS_HALF half-res px = 64 full-res px radius (a 128 px
 * blur circle). Larger blurs are clamped here; the exact path has no cap.
 *
 * The scene pass is not multisampled: a resolved depth averages surfaces
 * across a silhouette, and a pixel half bead, half sky would get a blur that
 * belongs to neither.
 */

/** Samples per gather, drawn from a pool of KERNEL_POOL aperture points. */
const KERNEL = 64
const KERNEL_POOL = 256
const MAX_RADIUS_HALF = 32
const TILE = 8
/** Linear luminance above which a blurred pixel's excess is scattered as a sprite. */
const HIGHLIGHT = 8
/** Smallest blur (diameter, full-res px) that gets scattered; below it highlights stay in the gather. */
const SCATTER_MIN_COC = 4
const MAX_SPRITES = 1 << 16
/** Stops of HDR the anti-aliasing encoding spans. */
const LOG_RANGE = 16

export interface LiveDofParams {
  kPerM: number
  /** c_px = cocScalePx · (kPerM − 1/d) at the full render width. */
  cocScalePx: number
  aperture: Aperture
}

export type ViewMode = 'beauty' | 'blur'

export interface LiveDof {
  /** Full-res linear HDR result. */
  output: RenderTarget
  resize(width: number, height: number): void
  render(scene: Scene, camera: PerspectiveCamera, p: LiveDofParams, view: ViewMode): void
  dispose(): void
}

type F = Node<'float'>
type V3 = Node<'vec3'>
type V4 = Node<'vec4'>

const luminance = (c: V3): F => c.dot(vec3(0.2126, 0.7152, 0.0722))

/**
 * Premultiplied field colour without the part that is scattered as a
 * highlight sprite. `c` is the field's CoC, positive far, negative near.
 */
function gatherable(prem: V4, c: F): V3 {
  const l = luminance(prem.rgb.div(max(prem.a, 1e-4)))
  const scattered = abs(c).greaterThanEqual(SCATTER_MIN_COC).and(l.greaterThan(HIGHLIGHT))
  return select(scattered, prem.rgb.mul(float(HIGHLIGHT).div(l)), prem.rgb)
}

export function createLiveDof(renderer: WebGPURenderer): LiveDof {
  let W = 0
  let H = 0
  let w = 0
  let h = 0

  const sceneRT = new RenderTarget(1, 1, { type: HalfFloatType, count: 2 })
  sceneRT.textures[0].name = 'output'
  // Not 'depth': three treats an MRT output with that name as the fragment depth (r186).
  sceneRT.textures[1].name = 'viewZ'
  const sceneMRT = mrt({ output, viewZ: vec4(positionView.z.negate(), 0, 0, 1) })
  // Pixels no geometry covers (a plain background clears instead of drawing)
  // are infinitely far, not at the clear colour's few millimetres.
  sceneMRT.setClearColor('viewZ', new Color(65504, 0, 0))

  // Half-res fields: far, near and in-focus (premultiplied rgb, coverage) and
  // the luminance-weighted CoC of the far and near parts.
  const fieldsRT = new RenderTarget(1, 1, { type: HalfFloatType, count: 4 })
  const [FAR, NEAR, FOCUS, COC] = [0, 1, 2, 3]
  fieldsRT.textures[FAR].name = 'output'
  fieldsRT.textures[NEAR].name = 'near'
  fieldsRT.textures[FOCUS].name = 'focus'
  fieldsRT.textures[COC].name = 'coc'
  const farRT = new RenderTarget(1, 1, { type: HalfFloatType })
  const nearRT = new RenderTarget(1, 1, { type: HalfFloatType })
  const scatterFarRT = new RenderTarget(1, 1, { type: HalfFloatType })
  const scatterNearRT = new RenderTarget(1, 1, { type: HalfFloatType })
  // The composite is anti-aliased in a log encoding: FXAA detects edges by luma
  // contrast, which only behaves on perceptually spaced values, and log keeps
  // half-float precision across 16 stops of HDR.
  const encodedRT = new RenderTarget(1, 1, { type: HalfFloatType })
  const out = new RenderTarget(1, 1, { type: HalfFloatType })

  const kPerM = uniform(0)
  const cocScale = uniform(0)
  const fullSize = uniform(vec2(1, 1))
  const halfSize = uniform(vec2(1, 1))
  const tilesX = uniform(1, 'uint')
  const viewBlur = uniform(0)
  const kernelValues = Array.from({ length: KERNEL_POOL }, () => new Vector4())
  const kernel = uniformArray<'vec4'>(kernelValues, 'vec4')

  /** Signed blur diameter in full-res px for an axial depth in metres. */
  const cocOf = (d: F): F => cocScale.mul(kPerM.sub(float(1).div(d)))

  // Prefilter: each full-res sample of the 2×2 block goes to the far or near
  // field by its own CoC (smoothly, between 1 and 4 px), the rest is in focus.
  const prefilterMat = new NodeMaterial()
  const taps = [
    [0, 0],
    [1, 0],
    [0, 1],
    [1, 1],
  ].map(([dx, dy]) => {
    const q = ivec2(screenCoordinate.xy).mul(2).add(ivec2(dx, dy))
    const rgb = textureLoad(sceneRT.textures[0], q).rgb
    const c = cocOf(textureLoad(sceneRT.textures[1], q).r)
    const wf = smoothstep(1, SCATTER_MIN_COC, c)
    const wn = smoothstep(1, SCATTER_MIN_COC, c.negate())
    return { rgb, c, l: luminance(rgb).add(1e-4), wf, wn, wi: float(1).sub(wf).sub(wn) }
  })
  const sum3 = (f: (t: (typeof taps)[number]) => V3): V3 => taps.map(f).reduce((a, b) => a.add(b))
  const sum1 = (f: (t: (typeof taps)[number]) => F): F => taps.map(f).reduce((a, b) => a.add(b))
  const fieldOut = (wOf: (t: (typeof taps)[number]) => F): V4 =>
    vec4(sum3((t) => t.rgb.mul(wOf(t))).mul(0.25), sum1(wOf).mul(0.25))
  // CoC of each field weighted by luminance: it sets how far the field's energy
  // spreads, so it follows the surface the energy comes from.
  const fieldCoc = (wOf: (t: (typeof taps)[number]) => F): F =>
    sum1((t) => t.c.mul(wOf(t)).mul(t.l)).div(sum1((t) => wOf(t).mul(t.l)).max(1e-6))
  // Material-level MRT: a NodeMaterial with a fragmentNode ignores MRT entirely (r186).
  prefilterMat.mrtNode = mrt({
    output: fieldOut((t) => t.wf),
    near: fieldOut((t) => t.wn),
    focus: fieldOut((t) => t.wi),
    coc: vec4(fieldCoc((t) => t.wf), fieldCoc((t) => t.wn), 0, 1),
  })
  const prefilterQuad = new QuadMesh(prefilterMat)

  // Tiles: [min near CoC, near radius] (radius in half-res px).
  let tiles = instancedArray(1, 'vec2')
  let nearDilated = instancedArray(1, 'float')
  let tileKernel: ReturnType<typeof buildTileKernels> | null = null

  function buildTileKernels(tx: number, ty: number) {
    const tileBuf = tiles
    const dilBuf = nearDilated
    const classify = Fn(() => {
      const t = instanceIndex
      const origin = uvec2(t.mod(tilesX), t.div(tilesX)).mul(TILE)
      const nearMin = float(0).toVar()
      Loop({ start: 0, end: TILE, type: 'int' }, { start: 0, end: TILE, type: 'int' }, ({ i, j }) => {
        // Clamp to the last texel for tiles that overhang the image edge.
        const q = ivec2(min(vec2(origin.add(uvec2(uint(i), uint(j)))), halfSize.sub(1)))
        const c = textureLoad(fieldsRT.textures[COC], q)
        nearMin.assign(min(nearMin, c.g))
      })
      tileBuf.element(t).assign(vec2(nearMin, nearMin.negate().div(4)))
    })().compute(tx * ty, [64])

    const reach = Math.ceil(MAX_RADIUS_HALF / TILE)
    const dilate = Fn(() => {
      const t = instanceIndex
      const tx0 = int(t.mod(tilesX))
      const ty0 = int(t.div(tilesX))
      const best = float(0).toVar()
      Loop(
        { start: -reach, end: reach, condition: '<=', type: 'int' },
        { start: -reach, end: reach, condition: '<=', type: 'int' },
        ({ i, j }) => {
          const nx = tx0.add(i)
          const ny = ty0.add(j)
          If(nx.greaterThanEqual(0).and(ny.greaterThanEqual(0)).and(nx.lessThan(int(tilesX))).and(ny.lessThan(ty)), () => {
            const r = tileBuf.element(ny.mul(int(tilesX)).add(nx)).y
            // A neighbour's near blur can reach this tile if its radius spans the gap.
            const gap = max(abs(float(i)), abs(float(j))).sub(1).max(0).mul(TILE)
            If(r.greaterThanEqual(gap), () => best.assign(max(best, r)))
          })
        },
      )
      dilBuf.element(t).assign(best)
    })().compute(tx * ty, [64])
    return { classify, dilate }
  }

  /** Point sample at a camera-frame offset (y up; texels run y down). Bilinear taps would blend CoCs. */
  const tap = (tex: number, pix: Node<'vec2'>, o: Node<'vec2'>): V4 =>
    textureLoad(fieldsRT.textures[tex], ivec2(pix.add(vec2(o.x, o.y.negate())).floor().clamp(vec2(0), halfSize.sub(1))))

  const tileOf = () => {
    const p = uvec2(screenCoordinate.xy).div(TILE)
    return p.y.mul(tilesX).add(p.x)
  }

  /** About two samples per px² of kernel area, between 16 and KERNEL. */
  const sampleCount = (R: F) => int(R.mul(R).mul(2).clamp(16, KERNEL))

  /**
   * Each pixel reads its own window of the R2 pool: any contiguous run of R2
   * points is well spread over the aperture, so the shape is kept, and the
   * undersampling of large blurs becomes fine noise (removed by the fill pass)
   * instead of the same structured pattern at every pixel.
   */
  const poolStart = () => int(fract(sin(dot(screenCoordinate.xy, vec2(12.9898, 78.233))).mul(43758.5453)).mul(KERNEL_POOL))
  const kernelAt = (start: Node<'int'>, i: Node<'int'>): V4 => kernel.element(start.add(i).mod(KERNEL_POOL))

  // Far gather. At far centres: far-field samples whose blur reaches the centre,
  // a farther sample limited to the centre's own blur (it cannot spread over
  // something nearer). At near centres with no far content: an estimate of the
  // background behind the foreground object from the far and in-focus fields
  // around it, so the near blur composites over what a lens sees past its edge.
  const farMat = new NodeMaterial()
  const buildFarGather = () =>
    Fn(() => {
      const pix = screenCoordinate.xy
      const centerFar = textureLoad(fieldsRT.textures[FAR], ivec2(pix))
      const centerNear = textureLoad(fieldsRT.textures[NEAR], ivec2(pix))
      const centerCoc = textureLoad(fieldsRT.textures[COC], ivec2(pix))
      const start = poolStart()
      const result = vec4(0).toVar()
      If(centerFar.a.greaterThan(1e-3), () => {
        const cc = centerCoc.r
        const rc = cc.div(4).min(MAX_RADIUS_HALF)
        // No far sample reaches past the centre's own blur: nearer far-field
        // samples blur less, farther ones are limited to it. Sampling a wider
        // radius would spend the kernel where nothing can contribute, and a
        // slightly blurred subject in front of a heavily blurred background
        // would go almost unsampled (black specks, seams on tile boundaries).
        const R = rc.max(1)
        const sum = vec3(0).toVar()
        const cov = float(0).toVar()
        const n = sampleCount(R)
        Loop(n, ({ i }) => {
          const u = kernelAt(start, i)
          // Far field: the aperture upright in the photo means offsets in −Shape.
          const o = u.xy.negate().mul(R)
          const s = tap(FAR, pix, o)
          const sc = tap(COC, pix, o).r
          const rs = sc.div(4).min(MAX_RADIUS_HALF)
          const r = select(sc.greaterThan(cc), min(rs, rc), rs)
          const wgt = r.sub(R.mul(u.z)).add(0.5).clamp(0, 1).div(max(r.mul(r), 0.25))
          sum.addAssign(gatherable(s, sc).mul(wgt))
          cov.addAssign(s.a.mul(wgt))
        })
        If(cov.greaterThan(1e-6), () => result.assign(vec4(sum.div(cov), 1)))
      }).ElseIf(centerNear.a.greaterThan(1e-3), () => {
        // The background is whatever lies farther than this centre: the far and
        // in-focus fields, and near-field samples clearly less blurred than it
        // (ground two metres behind a twig at 35 cm is still in the near field).
        const cn = centerCoc.g
        const Rb = cn.negate().div(4).min(MAX_RADIUS_HALF)
        If(Rb.greaterThan(0.5), () => {
          const sum = vec3(0).toVar()
          const cov = float(0).toVar()
          Loop(sampleCount(Rb), ({ i }) => {
            const o = kernelAt(start, i).xy.mul(Rb)
            const far = tap(FAR, pix, o)
            const focus = tap(FOCUS, pix, o)
            const near = tap(NEAR, pix, o)
            const coc = tap(COC, pix, o)
            const behind = select(coc.g.greaterThan(cn.add(2)), float(1), float(0))
            sum.addAssign(gatherable(far, coc.r).add(focus.rgb).add(gatherable(near, coc.g).mul(behind)))
            cov.addAssign(far.a.add(focus.a).add(near.a.mul(behind)))
          })
          If(cov.greaterThan(1e-3), () => result.assign(vec4(sum.div(cov), 1)))
        })
      })
      return result
    })()
  const farQuad = new QuadMesh(farMat)

  // Near gather: near-field samples whose blur reaches the centre, never limited,
  // so foreground blur spreads over everything behind it. Alpha is the share of
  // the centre's aperture the foreground covers: Σ coverage·weight · R²/n.
  const nearMat = new NodeMaterial()
  const buildNearGather = () =>
    Fn(() => {
      const pix = screenCoordinate.xy
      const start = poolStart()
      const R = nearDilated.element(tileOf()).min(MAX_RADIUS_HALF)
      const result = vec4(0).toVar()
      If(R.greaterThan(0.5), () => {
        const sum = vec3(0).toVar()
        const cov = float(0).toVar()
        const n = sampleCount(R)
        Loop(n, ({ i }) => {
          const u = kernelAt(start, i)
          // Near field: the aperture rotated 180° in the photo means offsets in +Shape.
          const o = u.xy.mul(R)
          const s = tap(NEAR, pix, o)
          const sc = tap(COC, pix, o).g
          const r = sc.negate().div(4).min(MAX_RADIUS_HALF)
          const wgt = r.sub(R.mul(u.z)).add(0.5).clamp(0, 1).div(max(r.mul(r), 0.25))
          sum.addAssign(gatherable(s, sc).mul(wgt))
          cov.addAssign(s.a.mul(wgt))
        })
        result.assign(vec4(sum.div(max(cov, 1e-6)), cov.mul(R.mul(R)).div(float(n)).clamp(0, 1)))
      })
      return result
    })()
  const nearQuad = new QuadMesh(nearMat)

  // Fill: a 3×3 tent over each gathered layer removes the remaining sampling
  // noise. Weighted by alpha, so texels with nothing in the layer (in-focus
  // regions in the far layer) cannot darken their neighbours.
  const fillOf = (src: RenderTarget) => {
    const m = new NodeMaterial()
    m.fragmentNode = Fn(() => {
      const p = ivec2(screenCoordinate.xy)
      const rgb = vec3(0).toVar()
      const a = float(0).toVar()
      for (const dy of [-1, 0, 1]) {
        for (const dx of [-1, 0, 1]) {
          const wgt = ((2 - Math.abs(dx)) * (2 - Math.abs(dy))) / 16
          const q = ivec2(vec2(p.add(ivec2(dx, dy))).clamp(vec2(0), halfSize.sub(1)))
          const s = textureLoad(src.texture, q)
          rgb.addAssign(s.rgb.mul(s.a).mul(wgt))
          a.addAssign(s.a.mul(wgt))
        }
      }
      return vec4(rgb.div(max(a, 1e-6)), a)
    })()
    return { material: m, quad: new QuadMesh(m) }
  }
  const farFill = fillOf(farRT)
  const nearFill = fillOf(nearRT)
  const farFillRT = new RenderTarget(1, 1, { type: HalfFloatType })
  const nearFillRT = new RenderTarget(1, 1, { type: HalfFloatType })

  // Highlight scatter: compute appends sprites, an indirect draw renders them.
  const spriteData = instancedArray(MAX_SPRITES * 2, 'vec4')
  const args = new IndirectStorageBufferAttribute(new Uint32Array(4), 1)
  const argsNode = storage(args, 'uint', 4).toAtomic()
  const vertexCount = uniform(0, 'uint')
  // drawIndirect arguments [vertexCount, instanceCount, firstVertex, firstInstance],
  // written on the GPU so no CPU upload can race the appended count.
  const resetArgs = Fn(() => {
    atomicStore(argsNode.element(0), vertexCount)
    atomicStore(argsNode.element(1), uint(0))
    atomicStore(argsNode.element(2), uint(0))
    atomicStore(argsNode.element(3), uint(0))
  })().compute(1)
  let extract: ReturnType<typeof buildExtract> | null = null
  function buildExtract() {
    return Fn(() => {
      const t = instanceIndex
      const q = ivec2(int(t.mod(uint(halfSize.x))), int(t.div(uint(halfSize.x))))
      const coc = textureLoad(fieldsRT.textures[COC], q)
      for (const [field, c] of [
        [FAR, coc.r],
        [NEAR, coc.g],
      ] as const) {
        const s = textureLoad(fieldsRT.textures[field], q)
        const l = luminance(s.rgb.div(max(s.a, 1e-4)))
        If(abs(c).greaterThanEqual(SCATTER_MIN_COC).and(l.greaterThan(HIGHLIGHT)).and(s.a.greaterThan(1e-3)), () => {
          const slot = atomicAdd(argsNode.element(1), uint(1))
          If(slot.lessThan(uint(MAX_SPRITES)), () => {
            // Centre in full-res px (y down), signed radius, energy of the field's
            // share of the 2×2 block above the highlight level.
            const excess = s.rgb.mul(float(1).sub(float(HIGHLIGHT).div(l))).mul(4)
            spriteData.element(slot.mul(2)).assign(vec4(vec2(q).add(0.5).mul(2), c.mul(0.5), 0))
            spriteData.element(slot.mul(2).add(1)).assign(vec4(excess, 0))
          })
        })
      }
    })().compute(Math.max(1, w * h), [64])
  }

  const spriteGeometry = new BufferGeometry()
  const spriteMat = new NodeMaterial()
  spriteMat.transparent = true
  spriteMat.blending = AdditiveBlending
  spriteMat.depthTest = false
  spriteMat.depthWrite = false
  spriteMat.vertexNode = Fn(() => {
    const d = spriteData.element(instanceIndex.mul(2))
    // Signed radius: far upright (y up in the camera frame), near rotated 180°.
    const local = positionGeometry.xy.mul(d.z)
    const px = d.xy.add(vec2(local.x, local.y.negate()))
    return vec4(px.x.div(fullSize.x).mul(2).sub(1), float(1).sub(px.y.div(fullSize.y).mul(2)), 0, 1)
  })()
  const spriteField = uniform(0)
  spriteMat.fragmentNode = Fn(() => {
    const d = spriteData.element(instanceIndex.mul(2))
    const e = spriteData.element(instanceIndex.mul(2).add(1)).rgb
    // Energy spread over the area-equivalent disc of the blur; one field per draw.
    const inField = select(d.z.lessThan(0), spriteField, float(1).sub(spriteField))
    return vec4(e.div(d.z.mul(d.z).mul(Math.PI).max(0.25)).mul(inField), 1)
  })()
  const sprites = new Mesh(spriteGeometry, spriteMat)
  sprites.frustumCulled = false
  const spriteScene = new Scene()
  spriteScene.add(sprites)
  const spriteCamera = new OrthographicCamera()
  let spriteShape = ''

  function setSpriteShape(ap: Aperture): void {
    const key = `${ap.blades}|${ap.roundness}|${ap.rotation}`
    if (key === spriteShape) return
    spriteShape = key
    const outline = apertureOutline(ap, 2, 96)
    const pos: number[] = []
    for (let i = 0; i < outline.length; i++) {
      const [x0, y0] = outline[i]
      const [x1, y1] = outline[(i + 1) % outline.length]
      pos.push(0, 0, 0, x0, y0, 0, x1, y1, 0)
    }
    spriteGeometry.setAttribute('position', new Float32BufferAttribute(pos, 3))
    vertexCount.value = pos.length / 3
    spriteGeometry.setIndirect(args)
  }

  // Composite at full res: sharp → far (+ far highlights) → near (+ near highlights).
  const compositeMat = new NodeMaterial()
  compositeMat.fragmentNode = Fn(() => {
    const uv = screenUV
    const sharp = texture(sceneRT.textures[0], uv).rgb
    const c = cocOf(texture(sceneRT.textures[1], uv).r)
    const rad = abs(c).mul(0.5)
    const farSample = texture(farFillRT.texture, uv)
    // Coverage of the far layer is read unfiltered: a bilinear value just under 1
    // would let a sharp near-field highlight leak through.
    const farCover = textureLoad(farRT.texture, ivec2(screenCoordinate.xy.mul(0.5))).a
    // Far pixels take the far gather; near pixels the background estimate behind them.
    const tFar = smoothstep(0.5, 2, rad).mul(select(c.greaterThan(0), float(1), farCover))
    const farColor = farSample.rgb.add(texture(scatterFarRT.texture, uv).rgb)
    const baseColor = mix(sharp, farColor, tFar)
    const near = texture(nearFillRT.texture, uv)
    const color = mix(baseColor, near.rgb, near.a).add(texture(scatterNearRT.texture, uv).rgb)
    // Blur map: near blue, far orange, inside the acceptable circle white.
    const strength = float(1).sub(abs(c).negate().div(16).exp())
    const map = select(c.lessThan(0), vec3(0.15, 0.45, 1), vec3(1, 0.5, 0.12)).mul(strength).add(0.04)
    const blurMap = select(abs(c).lessThan(fullSize.x.mul(0.03 / 36)), vec3(0.9), map)
    return vec4(mix(color, blurMap, viewBlur).add(1).log2().div(LOG_RANGE), 1)
  })()
  const compositeQuad = new QuadMesh(compositeMat)

  // Anti-aliasing for the in-focus layer: the scene pass has one sample per pixel
  // (see above), so sharp edges would otherwise be stair-stepped.
  const aaMat = new NodeMaterial()
  // The addon's typings declare FXAANode as a plain class; at runtime it is a vec4 node.
  const antialiased = fxaa(texture(encodedRT.texture)) as unknown as V4
  aaMat.fragmentNode = Fn(() => vec4(antialiased.rgb.mul(LOG_RANGE).exp2().sub(1), 1))()
  const aaQuad = new QuadMesh(aaMat)

  let kernelShape = ''
  const clearColor = new Color()

  function updateKernel(ap: Aperture): void {
    const key = `${ap.blades}|${ap.roundness}|${ap.rotation}`
    if (key === kernelShape) return
    kernelShape = key
    for (let i = 0; i < KERNEL_POOL; i++) {
      const [x, y] = sampleAperture(ap, ...r2(i))
      // q = |u| / R_shape(angle of u): the sample covers the centre when R·q ≤ r.
      const edge = apertureRadius(ap, 2, Math.atan2(y, x))
      kernelValues[i].set(x, y, Math.hypot(x, y) / edge, 0)
    }
  }

  function renderQuad(q: QuadMesh, target: RenderTarget): void {
    renderer.setRenderTarget(target)
    q.render(renderer)
  }

  return {
    output: out,
    resize(width, height) {
      if (width === W && height === H) return
      W = width
      H = height
      w = Math.ceil(W / 2)
      h = Math.ceil(H / 2)
      sceneRT.setSize(W, H)
      out.setSize(W, H)
      encodedRT.setSize(W, H)
      scatterFarRT.setSize(W, H)
      scatterNearRT.setSize(W, H)
      for (const t of [fieldsRT, farRT, nearRT, farFillRT, nearFillRT]) t.setSize(w, h)
      fullSize.value.set(W, H)
      halfSize.value.set(w, h)
      const tx = Math.ceil(w / TILE)
      const ty = Math.ceil(h / TILE)
      tilesX.value = tx
      tiles = instancedArray(tx * ty, 'vec2')
      nearDilated = instancedArray(tx * ty, 'float')
      tileKernel = buildTileKernels(tx, ty)
      extract = buildExtract()
      // Gathers read the new tile buffers.
      farMat.fragmentNode = buildFarGather()
      nearMat.fragmentNode = buildNearGather()
      farMat.needsUpdate = true
      nearMat.needsUpdate = true
    },
    render(scene, camera, p, view) {
      kPerM.value = p.kPerM
      cocScale.value = p.cocScalePx
      viewBlur.value = view === 'blur' ? 1 : 0
      updateKernel(p.aperture)
      setSpriteShape(p.aperture)

      renderer.setRenderTarget(sceneRT)
      renderer.setMRT(sceneMRT)
      renderer.render(scene, camera)
      renderer.setMRT(null)
      renderer.setRenderTarget(fieldsRT)
      prefilterQuad.render(renderer)

      renderer.compute(tileKernel!.classify)
      renderer.compute(tileKernel!.dilate)
      renderQuad(farQuad, farRT)
      renderQuad(nearQuad, nearRT)
      renderQuad(farFill.quad, farFillRT)
      renderQuad(nearFill.quad, nearFillRT)

      renderer.compute(resetArgs)
      renderer.compute(extract!)
      // Additive targets start from zero, not the page colour.
      renderer.getClearColor(clearColor)
      const clearAlpha = renderer.getClearAlpha()
      renderer.setClearColor(0x000000, 0)
      spriteField.value = 0
      renderer.setRenderTarget(scatterFarRT)
      renderer.render(spriteScene, spriteCamera)
      spriteField.value = 1
      renderer.setRenderTarget(scatterNearRT)
      renderer.render(spriteScene, spriteCamera)
      renderer.setClearColor(clearColor, clearAlpha)

      renderQuad(compositeQuad, encodedRT)
      renderQuad(aaQuad, out)
      renderer.setRenderTarget(null)
    },
    dispose() {
      for (const t of [sceneRT, fieldsRT, farRT, nearRT, farFillRT, nearFillRT, scatterFarRT, scatterNearRT, encodedRT, out]) t.dispose()
      for (const m of [prefilterMat, farMat, nearMat, farFill.material, nearFill.material, spriteMat, compositeMat, aaMat]) m.dispose()
      spriteGeometry.dispose()
    },
  }
}
