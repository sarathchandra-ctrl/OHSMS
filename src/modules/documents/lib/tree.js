// ─────────────────────────────────────────────────────────────────────────────
// The folder tree.
//
// Pure. Nothing here touches Firestore, React or the clock, because this is the
// part that has to be right — a browser that puts a document in the wrong
// folder, or in none, loses it as surely as deleting it.
//
// ── The shape ────────────────────────────────────────────────────────────────
//
//   Documents/
//   ├── Org Level Documents/          manual subfolders allowed
//   ├── <Region>/                     ┐
//   │   └── <Entity>/                 │ DERIVED from the site registry
//   │       └── <Site>/               ┘
//   │           ├── Pre Launch/       manual subfolders allowed
//   │           │   └── <Category>/   DERIVED from the handover checklist
//   │           └── Others/           manual subfolders allowed
//   └── Unfiled/                      backlog; appears only when non-empty
//
// Most of this tree is DERIVED, not stored. Regions, entities and sites are
// whatever the site registry says they are, and the two buckets under each site
// are fixed. Nobody creates or renames them, because the registry is the
// authority and a stored copy would drift the moment somebody edited a site.
//
// Only the leaves are people's own: free-form subfolders inside Pre Launch,
// Others, and Org Level Documents. Those live in documentFolders and carry a
// parentId naming the node they hang off.
//
// The one addition to that rule is the row of category folders inside every
// site's Pre Launch: Electrical System, Fire Alarm System, and the rest of the
// handover schedule. They are derived too, from the checklist in prelaunch.js
// rather than from the registry, and for the same reason — the list is the same
// for every site, and a stored copy would drift the moment the schedule changed.
// Nobody creates or renames them; people may still add their own subfolders
// inside one.
//
// ── The folder decides who may see the document ──────────────────────────────
//
// Every node resolves to a CLASSIFICATION — level, region, siteId — which is
// what the server's site rule reads (siteId, visibility). Filing a document is therefore the same act as
// classifying it, and there is no second setting that can disagree with where
// the document appears to be:
//
//   Org Level Documents (and below)   → org level, whole organization
//   Region, Entity (and below)        → region level
//   Site, Pre Launch, Others (below)  → site level, visible to that site
//
// Entity is a filing distinction, not a security one: the rules have no notion
// of an entity, so a document in an entity folder is region-level. That is
// stated here rather than left to be discovered.
//
// ── Nothing is unreachable ───────────────────────────────────────────────────
//
// A document names its node in `folderId`. If that node is gone — a site
// removed from the registry, a manual folder deleted — it falls back to the
// node its CLASSIFICATION implies, and failing that to Unfiled. A misplaced
// document is recoverable; an invisible one is not.
// ─────────────────────────────────────────────────────────────────────────────

import { ORG, REGION, SITE, levelOf, classificationFields } from './classification'
import { storageKindFor } from './docTypes'
import { PRE_LAUNCH_CATEGORIES } from './prelaunch'

const clean = (v) => String(v ?? '').trim()

/** How deep a MANUAL subfolder chain may go beneath its derived parent. */
export const MAX_DEPTH = 8

/** The longest a folder name may be. */
export const MAX_NAME = 80

// ── Node identity ────────────────────────────────────────────────────────────
//
// Derived nodes get deterministic ids so a document can name one and be found
// again after a reload. Region and entity names are free text, so each part is
// percent-encoded — which escapes the '/' separator too, making the id
// unambiguous however anybody names a region.
//
// Manual folders use their Firestore auto-id, which is alphanumeric and so can
// never collide with one of the prefixed ids below.

const enc = encodeURIComponent

export const ORG_NODE = 'org'
export const UNFILED_NODE = 'unfiled'
export const PRE_LAUNCH = 'pre-launch'
export const OTHERS = 'others'

export const ORG_NAME = 'Org Level Documents'
export const UNFILED_NAME = 'Unfiled'

/** The two buckets every site gets, in the order they should be shown. */
export const SITE_BUCKETS = [
  { key: PRE_LAUNCH, name: 'Pre Launch' },
  { key: OTHERS, name: 'Others' },
]

export const regionNode = (region) => `region:${enc(clean(region))}`
export const entityNode = (region, entity) => `entity:${enc(clean(region))}/${enc(clean(entity))}`
export const siteNode = (siteId) => `site:${clean(siteId)}`
export const bucketNode = (siteId, bucket) => `site:${clean(siteId)}/${bucket}`

/**
 * A checklist category inside a site's Pre Launch bucket.
 *
 * Built from the bucket id so the whole chain reads as one path, and so a
 * category can never be mistaken for a manual folder: those use Firestore
 * auto-ids, which contain no slash.
 */
export const prelaunchNode = (siteId, categoryKey) =>
  `${bucketNode(siteId, PRE_LAUNCH)}/${clean(categoryKey)}`

export const isRegionNode = (id) => String(id || '').startsWith('region:')

/** The checklist category a node IS, or '' when it is not one. */
export const prelaunchCategoryOf = (node) =>
  (node && node.kind === 'prelaunch' ? clean(node.categoryKey) : '')

// ── Building the tree ────────────────────────────────────────────────────────

/**
 * The whole tree, as a lookup of nodes plus a child index.
 *
 * @param sites   the site registry rows this viewer can see
 * @param folders the stored manual subfolders
 * @param docs    the documents, used only to decide whether Unfiled exists
 *
 * Regions and entities are derived from the sites — an org's regions are
 * whatever its sites say they are — so a site added to a new region grows the
 * tree without anybody creating anything.
 *
 * A site with no region, or no entity, still gets a home: it is grouped under a
 * blank-named placeholder rather than dropped, because a site the registry
 * knows about must not vanish from the library for want of a label.
 */
export function buildTree({ sites = [], folders = [], docs = [] } = {}) {
  const nodes = new Map()
  const children = new Map()

  const add = (node) => {
    nodes.set(node.id, node)
    if (!children.has(node.parentId)) children.set(node.parentId, [])
    children.get(node.parentId).push(node.id)
    return node
  }

  // Org level, always first: the one folder about the organization rather than
  // a part of it, and where someone looking for a policy starts.
  add({
    id: ORG_NODE, parentId: null, kind: 'org', name: ORG_NAME, scope: ORG,
    region: '', entity: '', siteId: '', filable: true, canAddFolder: true,
  })

  // Regions → entities → sites, each derived from the registry.
  const byRegion = new Map()
  for (const s of sites || []) {
    if (!s || !clean(s.id)) continue
    const region = clean(s.region)
    const entity = clean(s.entity)
    if (!byRegion.has(region)) byRegion.set(region, new Map())
    const entities = byRegion.get(region)
    if (!entities.has(entity)) entities.set(entity, [])
    entities.get(entity).push(s)
  }

  const regionNames = [...byRegion.keys()].sort((a, b) => a.localeCompare(b))
  for (const region of regionNames) {
    const rid = regionNode(region)
    add({
      id: rid, parentId: null, kind: 'region',
      // A site whose region is blank is a real site with a missing label. It
      // gets a folder that says so rather than being filed under "".
      name: region || 'No region set', scope: REGION,
      region, entity: '', siteId: '', filable: true, canAddFolder: false,
    })

    const entities = byRegion.get(region)
    for (const entity of [...entities.keys()].sort((a, b) => a.localeCompare(b))) {
      const eid = entityNode(region, entity)
      add({
        id: eid, parentId: rid, kind: 'entity', name: entity || 'No entity set', scope: REGION,
        region, entity, siteId: '', filable: true, canAddFolder: false,
      })

      const list = [...entities.get(entity)]
        .sort((a, b) => clean(a.name).localeCompare(clean(b.name)))
      for (const site of list) {
        const sid = siteNode(site.id)
        add({
          id: sid, parentId: eid, kind: 'site', name: clean(site.name) || clean(site.id), scope: SITE,
          region, entity, siteId: clean(site.id), filable: true, canAddFolder: false,
        })
        // The two fixed buckets. Documents go in these; the site folder above
        // holds them and nothing else people have to think about.
        for (const b of SITE_BUCKETS) {
          const bid = bucketNode(site.id, b.key)
          add({
            id: bid, parentId: sid, kind: 'bucket', name: b.name, scope: SITE,
            region, entity, siteId: clean(site.id), filable: true, canAddFolder: true,
          })

          // Pre Launch, and only Pre Launch, is broken out into the handover
          // schedule's categories. Others is the bucket for everything the
          // schedule does not ask for, so imposing the same shape on it would
          // be six empty folders per site saying nothing.
          if (b.key !== PRE_LAUNCH) continue
          for (const cat of PRE_LAUNCH_CATEGORIES) {
            add({
              id: prelaunchNode(site.id, cat.key), parentId: bid, kind: 'prelaunch',
              name: cat.name, categoryKey: cat.key, scope: SITE,
              region, entity, siteId: clean(site.id),
              // Filable, because a category is where its documents go. Manual
              // subfolders are allowed inside one too — a site with forty
              // electrical certificates still wants to sort them.
              filable: true, canAddFolder: true,
            })
          }
        }
      }
    }
  }

  // Manual subfolders, attached wherever their parent allows it. A folder whose
  // parent is gone is skipped rather than re-parented — it would otherwise
  // appear somewhere nobody put it — and its documents fall back to their
  // classification, which is what keeps them reachable.
  for (const f of folders || []) {
    if (!f || !clean(f.id)) continue
    const parentId = clean(f.parentId)
    const parent = nodes.get(parentId)
    if (!parent || !parent.canAddFolder) continue
    add({
      id: String(f.id), parentId, kind: 'manual', name: clean(f.name),
      // A manual folder is a place INSIDE something, so it inherits that
      // something's scope wholesale. Anything less makes a hole in the tree
      // where a document would come out unclassified.
      scope: parent.scope, region: parent.region, entity: parent.entity, siteId: parent.siteId,
      filable: true, canAddFolder: true, stored: f,
    })
  }

  // Unfiled last, and only when something has landed in it. It is a backlog,
  // not a destination: nothing may be filed there deliberately.
  const tree = { nodes, children }
  const stray = (docs || []).some((d) => d && resolveNode(d, tree) === UNFILED_NODE)
  if (stray) {
    add({
      id: UNFILED_NODE, parentId: null, kind: 'unfiled', name: UNFILED_NAME, scope: '',
      region: '', entity: '', siteId: '', filable: false, canAddFolder: false,
    })
  }

  return tree
}

/** The ids directly beneath a node, in the order they were built. */
export const childrenOf = (tree, id) => (tree.children.get(id === null ? null : id) || [])

/** The top-level nodes, in display order. */
export const rootsOf = (tree) => childrenOf(tree, null)

export const nodeAt = (tree, id) => tree.nodes.get(clean(id)) || null

// ── Where a document sits ────────────────────────────────────────────────────

/**
 * The node a document is in.
 *
 * Its own `folderId` when that node still exists; otherwise the node its
 * CLASSIFICATION implies, so a document whose folder was deleted resurfaces
 * where it belongs rather than disappearing; otherwise Unfiled.
 */
export function resolveNode(doc, tree) {
  const stored = clean(doc?.folderId)
  if (stored && tree.nodes.has(stored)) return stored

  switch (levelOf(doc)) {
    case ORG: return ORG_NODE
    case REGION: {
      const id = regionNode(doc.region)
      return tree.nodes.has(id) ? id : UNFILED_NODE
    }
    case SITE: {
      const id = siteNode(doc.siteId)
      return tree.nodes.has(id) ? id : UNFILED_NODE
    }
    default: return UNFILED_NODE
  }
}

/** The documents sitting directly in one node. */
export const filesIn = (docs = [], tree, id) =>
  (docs || []).filter((d) => d && resolveNode(d, tree) === clean(id))

/**
 * The classification a node confers — what the server's site rule reads.
 *
 * Handed to classificationFields, which every other part of the app already
 * trusts to write level / region / siteId / visibility and the siteRegion +
 * siteEntity snapshot the security rule depends on.
 */
export function nodeClassification(tree, id, sites = []) {
  const node = nodeAt(tree, id)
  if (!node || !node.filable) return classificationFields({ level: '' }, sites)

  // On `scope`, not on which fields happen to be filled. A manual folder under
  // Org Level carries no region and no site — reading those would make it look
  // unclassified and quietly strip the org level off everything filed in it.
  switch (node.scope) {
    case ORG: return classificationFields({ level: ORG }, sites)
    // Region AND entity: the rules have no entity level, so an entity folder is
    // region-scoped. Filing is finer than security here, deliberately.
    case REGION: return classificationFields({ level: REGION, region: node.region }, sites)
    case SITE: return classificationFields({ level: SITE, siteId: node.siteId }, sites)
    default: return classificationFields({ level: '' }, sites)
  }
}

/** The bucket folder a node's uploads go into — one per top-level ancestor. */
export function storageFolder(tree, id) {
  const node = nodeAt(tree, id)
  if (!node) return storageKindFor(null)
  if (node.kind === 'org') return storageKindFor(null)
  return storageKindFor(node.region || null)
}

// ── Walking ──────────────────────────────────────────────────────────────────

/** A node's ancestors, outermost first, excluding the node itself. */
export function ancestorsOf(tree, id) {
  const out = []
  const seen = new Set()
  let cur = nodeAt(tree, id)
  while (cur && cur.parentId) {
    const parent = nodeAt(tree, cur.parentId)
    // Cycle-safe: no UI can build one, but a bad write could, and a frozen tab
    // is a worse failure than a wrong breadcrumb.
    if (!parent || seen.has(parent.id)) break
    seen.add(parent.id)
    out.unshift(parent)
    cur = parent
    if (out.length > MAX_DEPTH + 4) break
  }
  return out
}

/** The breadcrumb for a node: every ancestor, then the node. */
export const breadcrumbOf = (tree, id) =>
  nodeAt(tree, id) ? [...ancestorsOf(tree, id), nodeAt(tree, id)] : []

/** How deep a MANUAL chain runs beneath its derived parent. */
export function manualDepth(tree, id) {
  let depth = 0
  let cur = nodeAt(tree, id)
  while (cur && cur.kind === 'manual' && depth <= MAX_DEPTH + 1) {
    depth += 1
    cur = nodeAt(tree, cur.parentId)
  }
  return depth
}

/** A node and everything beneath it. */
export function subtreeOf(tree, id) {
  const start = clean(id)
  if (!tree.nodes.has(start)) return new Set()
  const out = new Set([start])
  const stack = [start]
  while (stack.length) {
    for (const child of childrenOf(tree, stack.pop())) {
      if (out.has(child)) continue
      out.add(child)
      stack.push(child)
    }
  }
  return out
}

/**
 * Direct and total document counts for every node.
 *
 * `total` includes everything below a node, which is what a folder tile shows —
 * a region reading "0" while three documents sit under one of its sites would
 * be a lie, and it is the lie that makes people think a region has no paperwork.
 */
export function countTree(docs = [], tree) {
  const direct = new Map()
  for (const d of docs || []) {
    if (!d) continue
    const id = resolveNode(d, tree)
    direct.set(id, (direct.get(id) || 0) + 1)
  }

  const total = new Map()
  // Depth-first from each root, summing children into their parent on the way
  // back up — every node visited once.
  const sum = (id) => {
    let n = direct.get(id) || 0
    for (const child of childrenOf(tree, id)) n += sum(child)
    total.set(id, n)
    return n
  }
  rootsOf(tree).forEach(sum)

  return { direct, total }
}

// ── Naming a folder ──────────────────────────────────────────────────────────

/**
 * Why a folder name is not acceptable, or '' if it is.
 *
 * Case-insensitive uniqueness among SIBLINGS, the way a filesystem does it:
 * "Drawings" and "drawings" side by side is two folders nobody can tell apart,
 * and the second one is where things go missing. Derived siblings count too — a
 * manual folder called "Pre Launch" next to the real one would be worse.
 */
export function folderNameError(name, siblings = [], exceptId = '') {
  const n = clean(name)
  if (!n) return 'Give the folder a name'
  if (n.length > MAX_NAME) return `Keep the name under ${MAX_NAME} characters`
  const taken = (siblings || []).some(
    (s) => s && String(s.id) !== clean(exceptId) && clean(s.name).toLowerCase() === n.toLowerCase()
  )
  return taken ? 'A folder here already has that name' : ''
}

/** The sibling nodes a new or renamed folder must not clash with. */
export const siblingsOf = (tree, parentId) =>
  childrenOf(tree, parentId).map((id) => nodeAt(tree, id)).filter(Boolean)

// ── The move picker ──────────────────────────────────────────────────────────

/**
 * Every node a document may be filed into, as `{ value, label, depth }`.
 *
 * Unfiled is excluded: it is where things end up, never where they are put.
 */
export function fileChoices(tree) {
  const out = []
  const walk = (id, depth) => {
    const node = nodeAt(tree, id)
    if (!node || node.kind === 'unfiled') return
    if (node.filable) out.push({ value: id, label: node.name, depth, kind: node.kind })
    for (const child of childrenOf(tree, id)) walk(child, depth + 1)
  }
  rootsOf(tree).forEach((id) => walk(id, 0))
  return out
}
