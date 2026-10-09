import { NoColorSpace, RepeatWrapping, SRGBColorSpace, TextureLoader, type DataTexture, type Group, type Texture } from 'three/webgpu'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { HDRLoader } from 'three/addons/loaders/HDRLoader.js'

/** Files fetched by scripts/fetch-assets.ts into public/assets/. */
const BASE = '/assets'

const textureLoader = new TextureLoader()
const gltfLoader = new GLTFLoader()
const hdrLoader = new HDRLoader()

/** Colour maps are sRGB; data maps (normal, roughness, AO) are linear. Repeating, anisotropic. */
export async function loadTexture(path: string, color: boolean): Promise<Texture> {
  const t = await textureLoader.loadAsync(`${BASE}/${path}`)
  t.colorSpace = color ? SRGBColorSpace : NoColorSpace
  t.wrapS = t.wrapT = RepeatWrapping
  t.anisotropy = 16
  return t
}

export interface PbrSet {
  color: Texture
  normal: Texture
  roughness: Texture
  ao: Texture | null
}

/** A Poly Haven texture set at 2k. */
export async function polyHavenSet(id: string, diffuse = 'diff', ao = true): Promise<PbrSet> {
  const p = (map: string) => `polyhaven/${id}/${id}_${map}_2k.jpg`
  const [color, normal, roughness, aoMap] = await Promise.all([
    loadTexture(p(diffuse), true),
    loadTexture(p('nor_gl'), false),
    loadTexture(p('rough'), false),
    ao ? loadTexture(p('ao'), false) : Promise.resolve(null),
  ])
  return { color, normal, roughness, ao: aoMap }
}

/** An ambientCG material set at 2K; `opacity` for cut-out leaves. */
export async function ambientCgSet(id: string): Promise<PbrSet & { opacity: Texture | null }> {
  const p = (map: string) => `ambientcg/${id}/${id}_2K-JPG_${map}.jpg`
  const [color, normal, roughness, opacity] = await Promise.all([
    loadTexture(p('Color'), true),
    loadTexture(p('NormalGL'), false),
    loadTexture(p('Roughness'), false),
    loadTexture(p('Opacity'), false).catch(() => null),
  ])
  return { color, normal, roughness, ao: null, opacity }
}

export async function loadHdr(path: string): Promise<DataTexture> {
  return hdrLoader.loadAsync(`${BASE}/${path}`)
}

export async function loadGltf(path: string): Promise<Group> {
  return (await gltfLoader.loadAsync(`${BASE}/${path}`)).scene
}
