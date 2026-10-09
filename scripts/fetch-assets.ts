/**
 * Fetches the CC0 assets the forest uses into public/assets/ (git-ignored)
 * and writes ASSETS.md with source, author and licence for each.
 *
 *   npm run fetch-assets
 *
 * Idempotent: files already on disk are skipped. Poly Haven's API terms ask
 * every request to carry a User-Agent naming the software.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const UA = 'FocusLab-asset-fetch/0.1 (personal, local use)'
const ROOT = 'public/assets'

interface PolyHaven {
  id: string
  kind: 'hdri' | 'texture' | 'model'
  res: string
  /** Texture maps to fetch, by Poly Haven map name. */
  maps?: string[]
  use: string
}

interface AmbientCG {
  id: string
  res: string
  use: string
}

const POLYHAVEN: PolyHaven[] = [
  { id: 'river_walk_1', kind: 'hdri', res: '4k', use: 'Sky, image-based lighting and the distant treeline' },
  { id: 'forest_leaves_02', kind: 'texture', res: '2k', maps: ['Diffuse', 'nor_gl', 'Rough', 'AO'], use: 'Forest floor' },
  { id: 'leaves_forest_ground', kind: 'texture', res: '2k', maps: ['Diffuse', 'nor_gl', 'Rough', 'AO'], use: 'Forest floor variation' },
  { id: 'bark_brown_01', kind: 'texture', res: '2k', maps: ['Diffuse', 'nor_gl', 'Rough', 'AO'], use: 'Tree bark' },
  { id: 'fern_02', kind: 'model', res: '2k', use: 'Ferns, including the 0.8 m hero frond' },
  { id: 'dead_tree_trunk', kind: 'model', res: '2k', use: 'Fallen log at 7 m' },
  { id: 'tree_stump_01', kind: 'model', res: '1k', use: 'Stumps' },
  { id: 'rock_moss_set_01', kind: 'model', res: '1k', use: 'Mossy rocks' },
]

const AMBIENTCG: AmbientCG[] = [
  { id: 'Moss002', res: '2K-JPG', use: 'Moss on logs, trunks and the hero log edge' },
  { id: 'Ground037', res: '2K-JPG', use: 'Damp ground with moss' },
  { id: 'LeafSet024', res: '2K-JPG', use: 'Beech leaves (canopy)' },
  { id: 'LeafSet012', res: '2K-JPG', use: 'Dry oak leaves (leaf litter)' },
]

async function json(url: string): Promise<any> {
  const r = await fetch(url, { headers: { 'User-Agent': UA } })
  if (!r.ok) throw new Error(`${r.status} ${url}`)
  return r.json()
}

async function download(url: string, path: string): Promise<'fetched' | 'kept'> {
  if (existsSync(path)) return 'kept'
  mkdirSync(dirname(path), { recursive: true })
  const r = await fetch(url, { headers: { 'User-Agent': UA } })
  if (!r.ok) throw new Error(`${r.status} ${url}`)
  writeFileSync(path, Buffer.from(await r.arrayBuffer()))
  return 'fetched'
}

interface Row {
  source: string
  id: string
  use: string
  authors: string
  files: string[]
}
const rows: Row[] = []

for (const a of POLYHAVEN) {
  const info = await json(`https://api.polyhaven.com/info/${a.id}`)
  const files = await json(`https://api.polyhaven.com/files/${a.id}`)
  const dir = join(ROOT, 'polyhaven', a.id)
  const got: string[] = []
  if (a.kind === 'hdri') {
    const f = files.hdri[a.res].hdr
    const path = join(dir, `${a.id}_${a.res}.hdr`)
    console.log(`${await download(f.url, path)}  ${path}`)
    got.push(path)
  } else if (a.kind === 'texture') {
    for (const map of a.maps!) {
      const f = files[map][a.res].jpg
      const path = join(dir, f.url.split('/').pop()!)
      console.log(`${await download(f.url, path)}  ${path}`)
      got.push(path)
    }
  } else {
    const g = files.gltf[a.res].gltf
    const path = join(dir, g.url.split('/').pop()!)
    console.log(`${await download(g.url, path)}  ${path}`)
    got.push(path)
    for (const [rel, inc] of Object.entries(g.include as Record<string, { url: string }>)) {
      const p = join(dir, rel)
      console.log(`${await download(inc.url, p)}  ${p}`)
      got.push(p)
    }
  }
  rows.push({
    source: `https://polyhaven.com/a/${a.id}`,
    id: a.id,
    use: a.use,
    authors: Object.keys(info.authors ?? {}).join(', '),
    files: got,
  })
}

for (const a of AMBIENTCG) {
  const meta = await json(`https://ambientcg.com/api/v3/assets?id=${a.id}&include=downloads`)
  const dl = meta.assets[0].downloads.find((d: { attributes: string }) => d.attributes === a.res)
  const dir = join(ROOT, 'ambientcg', a.id)
  const zip = join(dir, `${a.id}_${a.res}.zip`)
  const state = await download(dl.url, zip)
  if (state === 'fetched') execFileSync('unzip', ['-oq', zip, '-d', dir])
  console.log(`${state}  ${zip}`)
  rows.push({ source: `https://ambientcg.com/view?id=${a.id}`, id: a.id, use: a.use, authors: 'ambientCG (Lennart Demes)', files: [dir] })
}

const md = [
  '# Assets',
  '',
  'Every third-party asset Focus Lab uses. All are **CC0 1.0** (public domain dedication):',
  'no attribution is required, it is given anyway. Files are fetched into `public/assets/`',
  '(git-ignored) by `npm run fetch-assets`, which also regenerates this file.',
  '',
  '| Asset | Source | Author | Used for |',
  '|---|---|---|---|',
  ...rows.map((r) => `| \`${r.id}\` | ${r.source} | ${r.authors} | ${r.use} |`),
  '',
  '## Code',
  '',
  '| Package | Source | Licence | Used for |',
  '|---|---|---|---|',
  '| ez-tree (vendored, `vendor/ez-tree`, commit dcf309b) | https://github.com/dgreenheck/ez-tree | MIT, © Daniel Greenheck | Procedural tree geometry |',
  '',
]
writeFileSync('ASSETS.md', md.join('\n'))
console.log('wrote ASSETS.md')
