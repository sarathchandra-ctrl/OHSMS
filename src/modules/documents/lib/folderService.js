// ─────────────────────────────────────────────────────────────────────────────
// The subfolders people create, in organizations/{orgId}/documentFolders.
//
// Only SUBFOLDERS are stored. The roots — Org Level Documents and one per
// region — are derived from the site registry on every render (see tree.js), so
// there is nothing here to keep in step with it.
//
// No rule of its own in stack/policy.mjs: the general rules cover it, and
// cover it correctly: any approved member reads, a writer creates and renames,
// and only a MANAGER may delete. That last one is not an accident of the
// generic rule — deleting a folder is the destructive operation here, and it is
// the same bar the rules put on deleting any other record.
//
// A folder record is metadata and nothing else: a name, the root it hangs off,
// and its parent. The documents inside it point AT it; it does not list them.
// That is what makes renaming a folder free and moving one cheap.
// ─────────────────────────────────────────────────────────────────────────────

import { dataProvider } from '../../../shared/data'
import { logAudit } from '../../../shared/org/orgData'
import { AUDIT } from '../../../shared/audit/audit'
import { isPermissionDenied } from '../../../shared/lib/permissionDenied'

const COLLECTION = 'documentFolders'
const path = () => `${COLLECTION}`

// Generous, because this is the whole tree for the org and it is small: a
// folder is a name and two ids. An org with more than this many folders has a
// problem the cap would only hide.
const MAX = 2000

const clean = (v) => String(v ?? '').trim()

const audit = (actor, action, folder, summary) =>
  logAudit(actor, action, {
    module: 'documents',
    target: COLLECTION,
    targetId: folder?.id || null,
    targetLabel: clean(folder?.name),
    summary,
  })

export const documentFolderService = {
  collectionName: COLLECTION,

  /**
   * Every folder in the org, live.
   *
   * Not narrowed by root or by the viewer's sites, on purpose. The whole tree
   * is needed to draw a breadcrumb or roll a count up through ancestors, and a
   * partial tree renders a folder whose parent is missing — which the walks in
   * tree.js survive, but as a wrong answer rather than a crash.
   *
   * A folder name is not sensitive in the way a document is: the DOCUMENTS are
   * scoped on read by the server (stack/policy.mjs siteBlocked), so an empty folder is all an
   * out-of-region member can see inside one.
   */
  subscribe(cb) {
    return dataProvider.subscribe(
      path(),
      { orderBy: ['createdAt', 'desc'], limit: MAX },
      cb,
      (err) => {
        // Permission-denied is the viewer not being allowed the tree — empty
        // folders, quietly. Any other failure used to vanish into "this org
        // has no folders", which is indistinguishable from the truth.
        if (!isPermissionDenied(err)) {
          // eslint-disable-next-line no-console
          console.error('[Documents] folder listener failed:', err?.message || err)
        }
        cb([])
      }
    )
  },

  /**
   * @param folder { name, parentId } — parentId is the id of the node it hangs
   *        off: the Org Level root, a site's Pre Launch / Others bucket, or
   *        another manual folder. buildTree drops a folder whose parent does
   *        not allow children, so a bad parentId makes the folder invisible
   *        rather than putting it somewhere surprising.
   *
   * The caller validates the name against its siblings (folderNameError) and
   * the depth against MAX_DEPTH. Neither can be enforced here without reading
   * the tree back, and neither is a security boundary: the worst a bad write
   * does is make a folder somebody has to rename.
   */
  async create(folder, actor) {
    const record = {
      name: clean(folder?.name),
      parentId: clean(folder?.parentId),
      createdAt: dataProvider.serverTimestamp(),
      updatedAt: dataProvider.serverTimestamp(),
      createdBy: actor?.uid || null,
      createdByName: actor?.name || 'Unknown',
    }
    const id = await dataProvider.create(path(), record)
    await audit(
      actor,
      AUDIT.CREATE,
      { id, name: record.name },
      `Created folder "${record.name}"`
    )
    return id
  },

  async rename(folder, name, actor) {
    const next = clean(name)
    await dataProvider.update(path(), folder.id, {
      name: next,
      updatedAt: dataProvider.serverTimestamp(),
    })
    await audit(
      actor,
      AUDIT.UPDATE,
      { id: folder.id, name: next },
      `Renamed folder "${clean(folder.name)}" to "${next}"`
    )
  },

  /**
   * Delete a folder. Manager-only, enforced by the server rather than
   * here — this call simply fails for anyone else, which is the right place for
   * that decision to live.
   *
   * The caller refuses to reach this point while the folder holds anything.
   * There is no recursive delete and no trash: a folder is cheap to recreate
   * and its contents are not, so the destructive version of this operation is
   * one the product does not offer.
   */
  async remove(folder, actor) {
    await dataProvider.remove(path(), folder.id)
    await audit(actor, AUDIT.DELETE, folder, `Deleted folder "${clean(folder.name)}"`)
  },
}
