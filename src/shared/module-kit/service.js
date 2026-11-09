// ─────────────────────────────────────────────────────────────────────────────
// Generic org-scoped CRUD service for a module collection. Every module gets
// tenant-scoped reads/writes + automatic audit logging by calling
// createModuleService('<collection>'). Records live at
// /organizations/{orgId}/<collection> so the security rules isolate tenants.
//
// All reads/writes go through the data provider (src/shared/data) — this file
// no longer knows which database it is talking to.
// ─────────────────────────────────────────────────────────────────────────────
import { dataProvider } from '../data'
import { logAudit } from '../org/orgData'
import { AUDIT } from '../audit/audit'
import { reserveDocId } from '../docId/reserve'

export function createModuleService(collectionName, moduleKey = collectionName) {
  const path = () => `${collectionName}`

  return {
    collectionName,

    subscribe(cb, onError) {
      return dataProvider.subscribe(
        path(),
        { orderBy: ['createdAt', 'desc'], limit: 1000 },
        cb,
        // A refused read must not look like an empty module. Callers that care
        // pass onError; everyone else gets the failure in the console instead
        // of a list of nothing.
        (err) => {
          if (typeof onError === 'function') onError(err)
          else {
            // eslint-disable-next-line no-console
            console.error(`[${collectionName}] subscribe failed:`, err?.code || err?.message || err)
          }
        }
      )
    },

    async list() {
      return dataProvider.list(path(), { orderBy: ['createdAt', 'desc'] })
    },

    async create(data, actor, label) {
      const id = await dataProvider.create(path(), {
        ...data,
        docId: await reserveDocId(moduleKey),
        createdAt: dataProvider.serverTimestamp(),
        updatedAt: dataProvider.serverTimestamp(),
        createdBy: actor?.uid || null,
        createdByName: actor?.name || 'Unknown',
      })
      await logAudit(actor, AUDIT.CREATE, {
        module: moduleKey,
        target: collectionName,
        targetId: id,
        targetLabel: label || data.title || '',
        summary: `Created ${collectionName} "${label || data.title || id}"`,
      })
      return id
    },

    async update(id, data, actor, label) {
      await dataProvider.update(path(), id, {
        ...data,
        updatedAt: dataProvider.serverTimestamp(),
      })
      await logAudit(actor, AUDIT.UPDATE, {
        module: moduleKey,
        target: collectionName,
        targetId: id,
        targetLabel: label || data.title || '',
      })
    },

    async setStatus(id, status, actor, label) {
      await dataProvider.update(path(), id, {
        status,
        updatedAt: dataProvider.serverTimestamp(),
      })
      await logAudit(actor, AUDIT.STATUS, {
        module: moduleKey,
        target: collectionName,
        targetId: id,
        targetLabel: label || '',
        summary: `Status → ${status}`,
      })
    },

    async remove(id, actor, label) {
      await dataProvider.remove(path(), id)
      await logAudit(actor, AUDIT.DELETE, {
        module: moduleKey,
        target: collectionName,
        targetId: id,
        targetLabel: label || '',
        summary: `Deleted ${collectionName} "${label || id}"`,
      })
    },
  }
}
