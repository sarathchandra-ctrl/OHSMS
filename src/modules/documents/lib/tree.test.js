import { describe, it, expect } from 'vitest'
import {
  MAX_DEPTH, ORG_NODE, UNFILED_NODE, PRE_LAUNCH, OTHERS,
  ancestorsOf, breadcrumbOf, bucketNode, buildTree, childrenOf, countTree,
  entityNode, fileChoices, filesIn, folderNameError, manualDepth, nodeAt,
  nodeClassification, prelaunchCategoryOf, prelaunchNode, regionNode, resolveNode,
  rootsOf, siblingsOf, siteNode, storageFolder, subtreeOf,
} from './tree'
import { PRE_LAUNCH_CATEGORIES } from './prelaunch'

// Two regions, two entities in one of them, three sites.
const sites = [
  { id: 's1', name: 'North Plant', region: 'North', entity: 'Acme Mfg' },
  { id: 's2', name: 'South Warehouse', region: 'South', entity: 'Acme Logistics' },
  { id: 's3', name: 'South Depot', region: 'South', entity: 'Acme Logistics' },
  { id: 's4', name: 'South Lab', region: 'South', entity: 'Acme Research' },
]

const NORTH = regionNode('North')
const SOUTH = regionNode('South')
const MFG = entityNode('North', 'Acme Mfg')
const LOG = entityNode('South', 'Acme Logistics')
const S1 = siteNode('s1')
const S1_PRE = bucketNode('s1', PRE_LAUNCH)
const S1_OTHER = bucketNode('s1', OTHERS)

const tree = () => buildTree({ sites })
const names = (t, id) => childrenOf(t, id).map((c) => nodeAt(t, c).name)

// The handover categories every Pre Launch bucket is broken into, in order.
const CATEGORY_NAMES = PRE_LAUNCH_CATEGORIES.map((c) => c.name)

describe('the derived skeleton', () => {
  it('puts Org Level Documents first, then the regions in order', () => {
    const t = tree()
    expect(rootsOf(t).map((id) => nodeAt(t, id).name))
      .toEqual(['Org Level Documents', 'North', 'South'])
  })

  it('nests entity under region, and site under entity', () => {
    const t = tree()
    expect(names(t, NORTH)).toEqual(['Acme Mfg'])
    expect(names(t, MFG)).toEqual(['North Plant'])
    // Sorted by name, and grouped by their own entity.
    expect(names(t, SOUTH)).toEqual(['Acme Logistics', 'Acme Research'])
    expect(names(t, LOG)).toEqual(['South Depot', 'South Warehouse'])
  })

  // The whole point of the fixed pair: they exist before anybody files anything.
  it('gives every site a Pre Launch and an Others folder, in that order', () => {
    const t = tree()
    expect(names(t, S1)).toEqual(['Pre Launch', 'Others'])
    expect(names(t, siteNode('s4'))).toEqual(['Pre Launch', 'Others'])
  })

  // A site the registry knows about must not vanish from the library for want
  // of a label — it gets a folder that says the label is missing.
  it('still files a site whose region or entity is blank', () => {
    const t = buildTree({ sites: [{ id: 'x', name: 'Orphan Site' }] })
    const region = rootsOf(t).map((id) => nodeAt(t, id).name)
    expect(region).toContain('No region set')
    const rid = regionNode('')
    expect(names(t, rid)).toEqual(['No entity set'])
  })

  it('copes with no sites at all', () => {
    const t = buildTree()
    expect(rootsOf(t).map((id) => nodeAt(t, id).name)).toEqual(['Org Level Documents'])
  })

  // Region names are free text and may contain the id separator. Encoding each
  // part is what keeps two different regions from sharing one node.
  it('keeps node ids unambiguous however a region is named', () => {
    const odd = [
      { id: 'a', name: 'A', region: 'North/South', entity: 'E' },
      { id: 'b', name: 'B', region: 'North', entity: 'South/E' },
    ]
    const t = buildTree({ sites: odd })
    expect(regionNode('North/South')).not.toBe(regionNode('North'))
    expect(nodeAt(t, entityNode('North', 'South/E')).name).toBe('South/E')
    expect(nodeAt(t, regionNode('North/South')).name).toBe('North/South')
  })
})

describe('where documents may go', () => {
  const t = tree()

  it('lets documents into every derived folder', () => {
    for (const id of [ORG_NODE, NORTH, MFG, S1, S1_PRE, S1_OTHER]) {
      expect(nodeAt(t, id).filable, id).toBe(true)
    }
  })

  // The skeleton is the registry's; only the leaves are people's own.
  it('allows manual subfolders only in Org Level and the site buckets', () => {
    expect(nodeAt(t, ORG_NODE).canAddFolder).toBe(true)
    expect(nodeAt(t, S1_PRE).canAddFolder).toBe(true)
    expect(nodeAt(t, S1_OTHER).canAddFolder).toBe(true)
    for (const id of [NORTH, MFG, S1]) {
      expect(nodeAt(t, id).canAddFolder, id).toBe(false)
    }
  })

  it('offers every filable node in the move picker, indented by depth', () => {
    const choices = fileChoices(t)
    const byValue = Object.fromEntries(choices.map((c) => [c.value, c]))
    expect(byValue[ORG_NODE].depth).toBe(0)
    expect(byValue[NORTH].depth).toBe(0)
    expect(byValue[MFG].depth).toBe(1)
    expect(byValue[S1].depth).toBe(2)
    expect(byValue[S1_PRE].depth).toBe(3)
  })

  // Unfiled is where things end up, never where they are put.
  it('never offers Unfiled', () => {
    const stray = buildTree({ sites, docs: [{ id: 'x' }] })
    expect(nodeAt(stray, UNFILED_NODE)).toBeTruthy()
    expect(fileChoices(stray).some((c) => c.value === UNFILED_NODE)).toBe(false)
  })
})

describe('manual subfolders', () => {
  const folders = [
    { id: 'f1', name: 'Drawings', parentId: S1_PRE },
    { id: 'f2', name: 'Revisions', parentId: 'f1' },
    { id: 'f3', name: 'Policies', parentId: ORG_NODE },
    // Its parent forbids children — an entity folder is the registry's, not
    // anybody's to extend.
    { id: 'bad', name: 'Sneaky', parentId: MFG },
    { id: 'gone', name: 'Orphan', parentId: 'no-such-node' },
  ]
  const t = buildTree({ sites, folders })

  it('attaches to the node named by parentId', () => {
    // After the derived categories, which are the registry's and come first.
    expect(names(t, S1_PRE)).toEqual([...CATEGORY_NAMES, 'Drawings'])
    expect(names(t, 'f1')).toEqual(['Revisions'])
    expect(names(t, ORG_NODE)).toEqual(['Policies'])
  })

  // Dropped rather than re-parented: a folder appearing somewhere nobody put it
  // is worse than one that does not appear.
  it('drops a folder whose parent forbids children, or is gone', () => {
    expect(nodeAt(t, 'bad')).toBeNull()
    expect(nodeAt(t, 'gone')).toBeNull()
    expect(names(t, MFG)).toEqual(['North Plant'])
  })

  it('measures manual depth from the derived parent', () => {
    expect(manualDepth(t, S1_PRE)).toBe(0)
    expect(manualDepth(t, 'f1')).toBe(1)
    expect(manualDepth(t, 'f2')).toBe(2)
  })

  it('collects a folder and everything beneath it', () => {
    expect([...subtreeOf(t, 'f1')].sort()).toEqual(['f1', 'f2'])
    expect(subtreeOf(t, 'nope').size).toBe(0)
  })

  it('walks ancestors outermost first', () => {
    expect(ancestorsOf(t, 'f2').map((n) => n.name))
      .toEqual(['North', 'Acme Mfg', 'North Plant', 'Pre Launch', 'Drawings'])
  })

  it('builds a breadcrumb ending at the node itself', () => {
    expect(breadcrumbOf(t, S1_PRE).map((n) => n.name))
      .toEqual(['North', 'Acme Mfg', 'North Plant', 'Pre Launch'])
    expect(breadcrumbOf(t, 'missing')).toEqual([])
  })

  // No UI can build a cycle, but a bad write could — and a frozen tab is a
  // worse failure than a wrong breadcrumb.
  it('does not hang on a parentId chain that loops', () => {
    const looped = buildTree({
      sites,
      folders: [
        { id: 'a', name: 'A', parentId: 'b' },
        { id: 'b', name: 'B', parentId: 'a' },
      ],
    })
    // Neither can attach — each parent is missing when the other is read — so
    // the tree simply does not contain them.
    expect(nodeAt(looped, 'a')).toBeNull()
    expect(ancestorsOf(looped, 'a').length).toBeLessThanOrEqual(MAX_DEPTH + 4)
  })
})

describe('resolving a document to a folder', () => {
  const folders = [{ id: 'f1', name: 'Drawings', parentId: S1_PRE }]
  const t = buildTree({ sites, folders })

  it('uses the folderId it was filed under', () => {
    expect(resolveNode({ folderId: S1_PRE }, t)).toBe(S1_PRE)
    expect(resolveNode({ folderId: 'f1' }, t)).toBe('f1')
  })

  // The one failure a file browser must not have. A folder cannot be deleted
  // while it holds anything, so this should not arise — "should not" is not a
  // guarantee, and a misplaced document beats an invisible one.
  it('falls back to what the classification implies when the folder is gone', () => {
    expect(resolveNode({ folderId: 'deleted', level: 'site', siteId: 's1' }, t)).toBe(S1)
    expect(resolveNode({ folderId: 'deleted', level: 'region', region: 'South' }, t)).toBe(SOUTH)
    expect(resolveNode({ folderId: 'deleted', level: 'org' }, t)).toBe(ORG_NODE)
  })

  // Every document written before any of this existed carries a level and no
  // folder. That is why no migration is needed.
  it('places a legacy document from its level alone', () => {
    expect(resolveNode({ level: 'org' }, t)).toBe(ORG_NODE)
    expect(resolveNode({ level: 'region', region: 'North' }, t)).toBe(NORTH)
    expect(resolveNode({ level: 'site', siteId: 's2' }, t)).toBe(siteNode('s2'))
  })

  it('drops everything that names nothing recognisable into Unfiled', () => {
    expect(resolveNode({}, t)).toBe(UNFILED_NODE)
    expect(resolveNode({ level: 'site', siteId: 'gone' }, t)).toBe(UNFILED_NODE)
    expect(resolveNode({ level: 'region', region: 'Nowhere' }, t)).toBe(UNFILED_NODE)
  })

  it('shows Unfiled only once something has landed in it', () => {
    expect(nodeAt(buildTree({ sites, docs: [{ level: 'org' }] }), UNFILED_NODE)).toBeNull()
    expect(nodeAt(buildTree({ sites, docs: [{}] }), UNFILED_NODE)).toBeTruthy()
  })

  it('returns exactly the documents filed at a node', () => {
    const docs = [
      { id: 'a', folderId: S1_PRE }, { id: 'b', folderId: 'f1' },
      { id: 'c', folderId: S1_PRE }, { id: 'd', level: 'org' },
    ]
    expect(filesIn(docs, t, S1_PRE).map((d) => d.id)).toEqual(['a', 'c'])
    expect(filesIn(docs, t, 'f1').map((d) => d.id)).toEqual(['b'])
    expect(filesIn(docs, t, ORG_NODE).map((d) => d.id)).toEqual(['d'])
  })
})

describe('the folder decides who may see the document', () => {
  const t = tree()

  it('files Org Level as organization-wide', () => {
    const c = nodeClassification(t, ORG_NODE, sites)
    expect(c.level).toBe('org')
    expect(c.visibility).toBe('all')
    expect(c.siteId).toBe('')
  })

  it('files a region folder at region level', () => {
    const c = nodeClassification(t, NORTH, sites)
    expect(c.level).toBe('region')
    expect(c.region).toBe('North')
    expect(c.visibility).toBe('all')
  })

  // The rules have no entity level, so an entity folder is region-scoped.
  // Filing is finer than security here, deliberately.
  it('files an entity folder at region level too', () => {
    const c = nodeClassification(t, MFG, sites)
    expect(c.level).toBe('region')
    expect(c.region).toBe('North')
  })

  // This is what makes the server hide the document from other sites.
  it('files a site folder and its buckets at site level, with the rule snapshot', () => {
    for (const id of [S1, S1_PRE, S1_OTHER]) {
      const c = nodeClassification(t, id, sites)
      expect(c.level, id).toBe('site')
      expect(c.siteId, id).toBe('s1')
      expect(c.visibility, id).toBe('site')
      expect(c.siteRegion, id).toBe('North')
      expect(c.siteEntity, id).toBe('Acme Mfg')
    }
  })

  // A manual folder inherits the scope of whatever it hangs under, or it would
  // be a hole in the middle of the tree.
  it('gives a manual subfolder the scope of its parent', () => {
    const deep = buildTree({ sites, folders: [{ id: 'f1', name: 'D', parentId: S1_PRE }] })
    expect(nodeClassification(deep, 'f1', sites).siteId).toBe('s1')
    const org = buildTree({ sites, folders: [{ id: 'f9', name: 'P', parentId: ORG_NODE }] })
    expect(nodeClassification(org, 'f9', sites).level).toBe('org')
  })

  // Nothing is guessed into org-wide: unclassified is a backlog item, not a
  // policy for everybody.
  it('does not promote an unfilable node to organization-wide', () => {
    const stray = buildTree({ sites, docs: [{}] })
    expect(nodeClassification(stray, UNFILED_NODE, sites).level).toBe('')
    expect(nodeClassification(stray, 'nonsense', sites).level).toBe('')
  })
})

describe('where the bytes go', () => {
  const t = tree()

  // One storage folder per REGION, not per node: the tree lives in Firestore
  // and can be reorganised freely, and the bytes stay put.
  it('uses one bucket folder for everything under a region', () => {
    const region = storageFolder(t, NORTH)
    expect(region).toBe('documents-region-North')
    expect(storageFolder(t, MFG)).toBe(region)
    expect(storageFolder(t, S1)).toBe(region)
    expect(storageFolder(t, S1_PRE)).toBe(region)
  })

  it('gives org level its own', () => {
    expect(storageFolder(t, ORG_NODE)).toBe('documents-org')
  })
})

describe('the counts', () => {
  const folders = [{ id: 'f1', name: 'Drawings', parentId: S1_PRE }]
  const docs = [
    { id: 'a', folderId: S1_PRE },
    { id: 'b', folderId: 'f1' },
    { id: 'c', folderId: S1_OTHER },
    { id: 'd', folderId: ORG_NODE },
  ]
  const t = buildTree({ sites, folders, docs })
  const { direct, total } = countTree(docs, t)

  it('counts what sits directly in a node', () => {
    expect(direct.get(S1_PRE)).toBe(1)
    expect(direct.get('f1')).toBe(1)
    expect(direct.get(S1)).toBeUndefined()
  })

  // A region reading "0" while three documents sit under one of its sites is a
  // lie, and it is the lie that makes people think a region has no paperwork.
  it('rolls everything up through every ancestor', () => {
    expect(total.get(S1_PRE)).toBe(2) // its own + Drawings
    expect(total.get(S1)).toBe(3)     // + Others
    expect(total.get(MFG)).toBe(3)
    expect(total.get(NORTH)).toBe(3)
    expect(total.get(ORG_NODE)).toBe(1)
  })

  // The number on the tile and the rows behind it come from the same place.
  it('agrees with filesIn, node for node', () => {
    for (const id of [ORG_NODE, NORTH, MFG, S1, S1_PRE, S1_OTHER, 'f1']) {
      expect(direct.get(id) || 0, id).toBe(filesIn(docs, t, id).length)
    }
  })

  it('leaves an empty folder at zero rather than absent', () => {
    expect(total.get(SOUTH)).toBe(0)
    expect(total.get(bucketNode('s2', PRE_LAUNCH))).toBe(0)
  })
})

describe('naming a folder', () => {
  const t = buildTree({ sites, folders: [{ id: 'f1', name: 'Drawings', parentId: S1_PRE }] })

  it('needs a name, and caps its length', () => {
    expect(folderNameError('', [])).toBeTruthy()
    expect(folderNameError('   ', [])).toBeTruthy()
    expect(folderNameError('x'.repeat(200), [])).toBeTruthy()
    expect(folderNameError('Fine', [])).toBe('')
  })

  // "Drawings" and "drawings" side by side is two folders nobody can tell
  // apart, and the second one is where things go missing.
  it('refuses a name a sibling already has, whatever the case', () => {
    const siblings = siblingsOf(t, S1_PRE)
    expect(folderNameError('Drawings', siblings)).toBeTruthy()
    expect(folderNameError('  drawings ', siblings)).toBeTruthy()
    expect(folderNameError('Drawings', siblings, 'f1')).toBe('') // renaming itself
    expect(folderNameError('Elsewhere', siblings)).toBe('')
  })

  // A manual folder called "Pre Launch" beside the real one would be worse than
  // a duplicate — you could not tell which one anybody meant.
  it('counts derived siblings too', () => {
    expect(folderNameError('Pre Launch', siblingsOf(t, S1))).toBeTruthy()
    expect(folderNameError('North Plant', siblingsOf(t, MFG))).toBeTruthy()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// The bug this suite exists to keep dead.
//
// Editing a document in Unfiled — the exact workflow the Unfiled empty state
// invites — seeded the Location picker with a node the picker deliberately does
// not offer. The select then matched no option, read as '', and the only sign
// anything was wrong was "Choose a folder to file this in" at submit.
//
// Two halves have to stay true for the dialog's fix to hold: Unfiled must stay
// out of the choices, and it must be recognisable as unfilable so the dialog
// can start blank instead of holding a value nothing can display.
// ─────────────────────────────────────────────────────────────────────────────
describe('a document in the Unfiled backlog', () => {
  const t = buildTree({ sites, docs: [{ id: 'stray', title: 'Lockout/Tagout Policy' }] })

  it('resolves to Unfiled', () => {
    expect(resolveNode({ id: 'stray' }, t)).toBe(UNFILED_NODE)
  })

  it('is not somewhere the picker will offer', () => {
    expect(fileChoices(t).some((c) => c.value === UNFILED_NODE)).toBe(false)
  })

  // The dialog keys its "start blank and prompt" decision off exactly this, so
  // if Unfiled ever became filable the picker would silently break again.
  it('is reported as unfilable, so the dialog can start blank', () => {
    expect(nodeAt(t, UNFILED_NODE).filable).toBe(false)
    expect(nodeAt(t, '')).toBeNull()
  })

  // Everywhere you CAN stand and file is offered, or the same mismatch returns
  // for a different node.
  it('offers every other filable node the browser can navigate to', () => {
    const offered = new Set(fileChoices(t).map((c) => c.value))
    for (const [id, node] of t.nodes) {
      if (node.filable) expect(offered.has(id), id).toBe(true)
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// The handover checklist categories.
//
// Derived from prelaunch.js rather than the registry, but derived all the same:
// nobody creates them, every site gets the identical set, and an empty one is
// the finding a handover review is looking for.
// ─────────────────────────────────────────────────────────────────────────────
describe('pre-launch categories', () => {
  const t = tree()

  it('breaks every site’s Pre Launch into the same categories, in order', () => {
    expect(names(t, S1_PRE)).toEqual(CATEGORY_NAMES)
    expect(names(t, bucketNode('s4', PRE_LAUNCH))).toEqual(CATEGORY_NAMES)
  })

  // Others is the bucket for everything the schedule does not ask for, so
  // imposing the same six folders on it would say nothing about six things.
  it('leaves Others alone', () => {
    expect(names(t, S1_OTHER)).toEqual([])
  })

  it('files a category at its site’s level, like every other node under it', () => {
    const id = prelaunchNode('s1', 'electrical')
    const c = nodeClassification(t, id, sites)
    expect(c.level).toBe('site')
    expect(c.siteId).toBe('s1')
    expect(c.visibility).toBe('site')
    expect(c.siteRegion).toBe('North')
    expect(nodeAt(t, id).parentId).toBe(S1_PRE)
    expect(prelaunchCategoryOf(nodeAt(t, id))).toBe('electrical')
    expect(prelaunchCategoryOf(nodeAt(t, S1_PRE))).toBe('')
  })

  // People still sort their own way inside one; the category itself is not
  // theirs to rename or delete.
  it('takes manual subfolders but is not one', () => {
    const id = prelaunchNode('s1', 'fas')
    const deep = buildTree({ sites, folders: [{ id: 'f1', name: 'OEM', parentId: id }] })
    expect(names(deep, id)).toEqual(['OEM'])
    expect(nodeAt(deep, 'f1').siteId).toBe('s1')
    expect(nodeAt(t, id).kind).toBe('prelaunch')
  })

  it('rolls its documents up into the bucket and the site', () => {
    const id = prelaunchNode('s1', 'electrical')
    const docs = [{ id: 'd1', folderId: id, level: 'site', siteId: 's1' }]
    const { direct, total } = countTree(docs, buildTree({ sites, docs }))
    expect(direct.get(id)).toBe(1)
    expect(total.get(S1_PRE)).toBe(1)
    expect(total.get(S1)).toBe(1)
  })

  it('is offered in the move picker, under its bucket', () => {
    const byValue = Object.fromEntries(fileChoices(t).map((c) => [c.value, c]))
    expect(byValue[prelaunchNode('s1', 'general')].depth).toBe(4)
  })

  // A category name beside the real ones would be two folders nobody can tell
  // apart, which is where things go missing.
  it('is a sibling a manual folder may not shadow', () => {
    expect(folderNameError('Electrical System', siblingsOf(t, S1_PRE))).toBeTruthy()
  })
})
