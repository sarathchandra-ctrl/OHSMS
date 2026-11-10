import { useEffect, useMemo, useState } from 'react'
import toast from 'react-hot-toast'
import { toastCaught } from '../../shared/lib/toastCaught'
import { UsersRound, Check, X, ShieldCheck, KeyRound, Search } from 'lucide-react'
import { useAuth } from '../../shared/auth/AuthContext'
import {
  subscribeOrgUsers, setUserStatus, setUserRole, setUserAccess, grantAccessRequest, subscribeSites,
} from '../../shared/org/orgData'
import { ROLES, roleLabel } from '../../shared/auth/permissions'
import { enabledModules } from '../../shared/modules/entitlements'
import { MODULE_BY_KEY } from '../../shared/modules/registry'
import {
  orgDepartments, regionsOf, entitiesOf, resolveAccessibleSites, accessSummary, hasPendingAccessRequest,
  accessDetail, shortList,
} from '../../shared/auth/access'
import {
  PageHeader, Badge, Button, Select, Field, Modal, MultiSelect, SkeletonTable, EmptyState, Pager,
} from '../../shared/ui'
import { initials } from '../../shared/lib/format'
import AddEmployee, { temporaryPassword } from './AddEmployee'
import { resetMemberPassword } from '../../shared/functions'

const STATUS_TONE = { approved: 'green', pending: 'amber', suspended: 'red' }
const emptyScope = { sites: [], regions: [], entities: [] }

const moduleNames = (keys) => keys.map((k) => MODULE_BY_KEY[k]?.label || k)

/** Which regions, entities and sites a person has, by name. */
function ScopeLines({ scope, sites }) {
  const d = accessDetail(scope, sites)
  const rows = [
    ['Regions', d.regions],
    ['Entities', d.entities],
    ['Sites', d.sites],
  ].filter(([, names]) => names.length)
  if (!rows.length) return <span className="text-xs text-ink-400">No access</span>
  return (
    <dl className="space-y-0.5 text-xs">
      {rows.map(([label, names]) => (
        <div key={label} className="flex gap-1.5" title={names.join(', ')}>
          <dt className="flex-none font-semibold text-ink-500">{label}:</dt>
          <dd className="min-w-0 text-ink-700">{shortList(names)}</dd>
        </div>
      ))}
    </dl>
  )
}

export default function Users() {
  const { actor, user, org, orgModuleMap } = useAuth()
  const [users, setUsers] = useState(null)
  const [sites, setSites] = useState([])
  const [manage, setManage] = useState(null) // user being managed | null
  // form.modules: null = every module (the stored field is absent), else a list.
  const [form, setForm] = useState({ role: 'member', department: '', modules: null, ...emptyScope })
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    const unsubs = [
      subscribeOrgUsers((list) =>
        setUsers(
          list.sort((a, b) => (a.status === 'pending' ? -1 : 1) - (b.status === 'pending' ? -1 : 1))
        )
      ),
      subscribeSites(setSites),
    ]
    return () => unsubs.forEach((u) => u && u())
  }, [])

  const regions = useMemo(() => regionsOf(sites), [sites])
  const entities = useMemo(() => entitiesOf(sites), [sites])
  const siteOptions = useMemo(() => sites.map((s) => ({ value: s.id, label: s.name })), [sites])
  // Only the modules this organization has can be granted.
  const moduleOptions = useMemo(
    () => enabledModules(orgModuleMap).map((m) => ({ value: m.key, label: m.label })),
    [orgModuleMap]
  )

  const approve = async (u) => wrap(() => setUserStatus(u.uid, 'approved', actor, u.name), `${u.name} approved`)
  const suspend = async (u) => wrap(() => setUserStatus(u.uid, 'suspended', actor, u.name), `${u.name} suspended`)
  // A new temporary password, shown once to the admin to pass on.
  const [resetDone, setResetDone] = useState(null)
  const resetPassword = async (u) => {
    if (!window.confirm(`Give ${u.name || u.email} a new temporary password? Their current password stops working.`)) return
    const password = temporaryPassword()
    try {
      await resetMemberPassword({ uid: u.uid, password })
      setResetDone({ name: u.name || u.email, email: u.email, password })
    } catch (err) {
      toast.error(err?.message || 'The password was not reset.')
    }
  }
  const changeRole = async (u, role) => wrap(() => setUserRole(u.uid, role, actor, u.name), `${u.name} → ${roleLabel(role)}`)
  const grantRequest = async (u) =>
    wrap(() => grantAccessRequest(u.uid, u.accessRequest, actor, u.name, u.access?.modules), `Access granted to ${u.name}`)

  async function wrap(fn, ok) {
    try { await fn(); toast.success(ok) } catch (e) { toastCaught(e, 'Failed') }
  }

  const openManage = (u) => {
    const a = u.access || emptyScope
    setForm({
      name: u.name && u.name !== u.email ? u.name : '',
      role: u.role || 'member',
      department: u.department || '',
      sites: a.sites || [],
      regions: a.regions || [],
      entities: a.entities || [],
      modules: Array.isArray(a.modules) ? a.modules : null,
    })
    setManage(u)
  }

  const applyFromRequest = () => {
    const r = manage?.accessRequest
    if (!r) return
    setForm((f) => ({
      ...f,
      department: r.department || f.department,
      sites: r.sites || [],
      regions: r.regions || [],
      entities: r.entities || [],
    }))
  }

  const saveManage = async (e) => {
    e.preventDefault()
    setBusy(true)
    try {
      const isSelf = manage.uid === user?.uid
      if (!isSelf && form.role !== manage.role) {
        await setUserRole(manage.uid, form.role, actor, manage.name)
      }
      await setUserAccess(
        manage.uid,
        {
          name: form.name,
          department: form.department,
          access: {
            sites: form.sites,
            regions: form.regions,
            entities: form.entities,
            // Kept for every role, so a manager moved back to employee gets
            // the list they had rather than every module.
            ...(form.modules ? { modules: form.modules } : {}),
          },
        },
        actor, manage.name
      )
      toast.success(`Access updated for ${form.name.trim() || manage.name}`)
      setManage(null)
    } catch (err) {
      toastCaught(err, 'Failed')
    } finally {
      setBusy(false)
    }
  }

  const previewSites = useMemo(
    () => resolveAccessibleSites({ role: form.role, access: { sites: form.sites, regions: form.regions, entities: form.entities } }, sites, { isAdmin: form.role === 'admin' }),
    [form, sites]
  )

  const pending = (users || []).filter((u) => u.status === 'pending').length
  const requests = (users || []).filter(hasPendingAccessRequest).length

  // Directory search + pagination — keeps the table responsive at 5 000 employees.
  const PAGE_SIZE = 25
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(1)
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    const list = (users || []).filter(
      (u) => !q || `${u.name} ${u.email} ${u.department || ''} ${u.role} ${u.status}`.toLowerCase().includes(q),
    )
    // Surface pending approvals & access requests first, then alphabetical.
    return list.sort((a, b) => {
      const aTop = (a.status === 'pending' ? 2 : 0) + (hasPendingAccessRequest(a) ? 1 : 0)
      const bTop = (b.status === 'pending' ? 2 : 0) + (hasPendingAccessRequest(b) ? 1 : 0)
      return bTop - aTop || (a.name || '').localeCompare(b.name || '')
    })
  }, [users, search])
  useEffect(() => { setPage(1) }, [search])
  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))
  const safePage = Math.min(page, pageCount)
  const pageItems = filtered.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE)

  return (
    <>
      <PageHeader
        title="Employees"
        subtitle={
          'Employee repository — add employees, set roles & site access, reset passwords'
        }
        icon={UsersRound}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            {pending > 0 && <Badge tone="amber">{pending} pending approval</Badge>}
            {requests > 0 && <Badge tone="violet">{requests} access request{requests === 1 ? '' : 's'}</Badge>}
            <AddEmployee />
          </div>
        }
      />

      {users === null ? (
        <SkeletonTable rows={5} cols={5} />
      ) : users.length === 0 ? (
        <EmptyState icon={UsersRound} title="No employees yet" description="Add employees above. Each gets a temporary password to change at first sign-in." />
      ) : (
        <>
        <div className="mb-3 flex flex-wrap items-center gap-3">
          <div className="relative min-w-[220px] flex-1">
            <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-400" />
            <input className="input pl-9" placeholder="Search name, email, department, role…" value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>
          <span className="text-sm text-ink-500">
            {filtered.length === users.length ? `${users.length} employees` : `${filtered.length} of ${users.length} employees`}
          </span>
        </div>
        <div className="card table-crisp overflow-x-auto p-0">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="text-xs uppercase tracking-wide text-ink-400">
                <th className="px-5 py-3 font-semibold">User</th>
                <th className="px-5 py-3 font-semibold">Dept</th>
                <th className="px-5 py-3 font-semibold">Role</th>
                <th className="px-5 py-3 font-semibold">Site access</th>
                <th className="px-5 py-3 font-semibold">Status</th>
                <th className="px-5 py-3"><span className="sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody>
              {pageItems.map((u) => {
                const isSelf = u.uid === user?.uid
                const reqPending = hasPendingAccessRequest(u)
                return (
                  <tr key={u.uid} className="hover:bg-surface-100">
                    <td className="px-5 py-3.5">
                      <div className="flex items-center gap-3">
                        {/* Decorative: the initials are a visual restatement of the
                            name sitting immediately beside them, so announcing
                            both reads every row as "S M Sarath Menon". */}
                        <span aria-hidden="true" className="grid h-9 w-9 place-items-center rounded-xl bg-brand-600 text-xs font-bold text-white">
                          {initials(u.name) || 'U'}
                        </span>
                        <div>
                          <p className="font-medium text-ink-900">{u.name}{isSelf && <span className="ml-1 text-xs text-ink-400">(you)</span>}</p>
                          <p className="text-xs text-ink-400">{u.email}</p>
                        </div>
                      </div>
                    </td>
                    <td className="px-5 py-3.5 text-ink-600">
                      <div>{u.department || u.dept || '—'}</div>
                      {!u.department && !u.dept && u.departmentRequest ? (
                        <p className="text-xs text-ink-400">Asked: {u.departmentRequest}</p>
                      ) : null}
                    </td>
                    <td className="px-5 py-3.5">
                      <Select
                        className="!w-40 !py-1.5 text-xs"
                        value={u.role || 'member'}
                        disabled={isSelf}
                        title={isSelf ? "You can't change your own role" : undefined}
                        onChange={(e) => changeRole(u, e.target.value)}
                      >
                        {ROLES.map((r) => (
                          <option key={r.key} value={r.key}>{r.label}</option>
                        ))}
                      </Select>
                    </td>
                    <td className="px-5 py-3.5">
                      <div className="flex flex-col gap-1">
                        {u.role === 'admin' ? (
                          <span className="text-xs text-ink-600">All sites (admin)</span>
                        ) : (
                          <ScopeLines scope={u.access} sites={sites} />
                        )}
                        {(u.role || 'member') === 'member' && Array.isArray(u.access?.modules) && (
                          <span className="text-xs text-ink-500" title={moduleNames(u.access.modules).join(', ')}>
                            <b className="font-semibold">Modules:</b>{' '}
                            {u.access.modules.length ? shortList(moduleNames(u.access.modules)) : 'none'}
                          </span>
                        )}
                        {reqPending && <Badge tone="violet">Requested: {accessSummary(u.accessRequest, sites)}</Badge>}
                      </div>
                    </td>
                    <td className="px-5 py-3.5">
                      <Badge tone={STATUS_TONE[u.status] || 'gray'}>{u.status}</Badge>
                    </td>
                    <td className="px-5 py-3.5">
                      <div className="flex items-center justify-end gap-1.5">
                        {u.status === 'pending' && (
                          <Button variant="soft" icon={Check} onClick={() => approve(u)} className="!py-1.5 text-xs">Approve</Button>
                        )}
                        {reqPending && (
                          <Button variant="soft" icon={ShieldCheck} onClick={() => grantRequest(u)} className="!py-1.5 text-xs">Grant</Button>
                        )}
                        <Button variant="ghost" icon={KeyRound} onClick={() => openManage(u)} className="!py-1.5 text-xs">Edit</Button>
                        {!isSelf && (
                          <Button variant="ghost" onClick={() => resetPassword(u)} className="!py-1.5 text-xs">Reset password</Button>
                        )}
                        {!isSelf && u.status === 'approved' && (
                          <button onClick={() => suspend(u)} className="rounded-lg p-1.5 text-red-500 hover:bg-red-50" title="Suspend"><X size={16} /></button>
                        )}
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
        <Pager className="mt-3" page={safePage} pageCount={pageCount} onPage={setPage} total={filtered.length} pageSize={PAGE_SIZE} />
        </>
      )}

      <Modal
        open={!!resetDone}
        onClose={() => setResetDone(null)}
        title="Temporary password"
        footer={<Button type="button" onClick={() => setResetDone(null)}>Done</Button>}
      >
        {resetDone && (
          <div className="space-y-3 text-sm text-ink-700">
            <p>
              Give this to <b>{resetDone.name}</b> ({resetDone.email}). They will choose their own
              password when they next sign in. It is not shown again.
            </p>
            <p className="well rounded-xl p-3 font-mono">{resetDone.password}</p>
          </div>
        )}
      </Modal>

      {/* Manage access modal */}
      <Modal
        open={!!manage}
        onClose={() => setManage(null)}
        size="lg"
        title={manage ? `Edit — ${manage.name}` : ''}
        footer={
          <>
            <Button variant="ghost" type="button" onClick={() => setManage(null)}>Cancel</Button>
            <Button form="access-form" type="submit" loading={busy}>Save &amp; grant</Button>
          </>
        }
      >
        {manage && (
          <form id="access-form" onSubmit={saveManage} className="space-y-4">
            {manage.accessRequest && (
              <div className="flex items-center justify-between gap-3 rounded-2xl bg-violet-50 px-3 py-2 text-sm">
                <span className="text-violet-800">
                  Requested: <b>{accessSummary(manage.accessRequest, sites)}</b>
                  {manage.accessRequest.department ? ` · ${manage.accessRequest.department}` : ''}
                </span>
                <button type="button" onClick={applyFromRequest} className="rounded-lg bg-violet-600 px-2.5 py-1 text-xs font-semibold text-white">
                  Use request
                </button>
              </div>
            )}

            <Field label="Full name" htmlFor="emp-full-name" hint={manage.email}>
              <input
                id="emp-full-name"
                className="input"
                value={form.name}
                maxLength={120}
                placeholder="As it should appear on records"
                onChange={(e) => setForm({ ...form, name: e.target.value })}
              />
            </Field>

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field label="Department" htmlFor="dept">
                <Select id="dept" value={form.department} onChange={(e) => setForm({ ...form, department: e.target.value })}>
                  <option value="">—</option>
                  {orgDepartments(org).map((d) => <option key={d} value={d}>{d}</option>)}
                </Select>
              </Field>
              <Field label="Role" htmlFor="role" hint={manage.uid === user?.uid ? "You can't change your own role" : 'Admin grants all-site access'}>
                <Select id="role" value={form.role} disabled={manage.uid === user?.uid} onChange={(e) => setForm({ ...form, role: e.target.value })}>
                  {ROLES.map((r) => <option key={r.key} value={r.key}>{r.label}</option>)}
                </Select>
              </Field>
            </div>

            <p className="text-xs text-ink-500">
              Grant access by <b>entity</b> (all its sites), <b>region</b> (all its sites), and/or specific
              <b> sites</b>. Selecting multiple is allowed; the union applies.
            </p>

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              <Field label={`Entities (${form.entities.length})`}>
                <MultiSelect options={entities} value={form.entities} onChange={(entities) => setForm({ ...form, entities })} empty="No entities in site inventory" />
              </Field>
              <Field label={`Regions (${form.regions.length})`}>
                <MultiSelect options={regions} value={form.regions} onChange={(regions) => setForm({ ...form, regions })} empty="No regions in site inventory" />
              </Field>
              <Field label={`Sites (${form.sites.length})`}>
                <MultiSelect options={siteOptions} value={form.sites} onChange={(s) => setForm({ ...form, sites: s })} empty="No sites yet" />
              </Field>
            </div>

            {form.role === 'member' ? (
              <fieldset className="space-y-2">
                <legend className="label">
                  Modules{form.modules ? ` (${form.modules.length} of ${moduleOptions.length})` : ''}
                </legend>
                <label className="flex items-center gap-2 text-sm text-ink-700">
                  <input
                    type="checkbox"
                    checked={!form.modules}
                    onChange={(e) =>
                      setForm({
                        ...form,
                        modules: e.target.checked ? null : moduleOptions.map((o) => o.value),
                      })
                    }
                  />
                  All modules, including ones added later
                </label>
                {form.modules && (
                  <MultiSelect
                    options={moduleOptions}
                    value={form.modules}
                    onChange={(modules) => setForm({ ...form, modules })}
                    empty="This organization has no modules enabled"
                  />
                )}
              </fieldset>
            ) : (
              <p className="text-xs text-ink-500">
                {roleLabel(form.role)} sees every module the organization has.
              </p>
            )}

            <div className="well rounded-2xl p-3 text-sm">
              <span className="font-medium text-ink-600">Resolves to </span>
              {form.role === 'admin' ? (
                <Badge tone="brand">All sites (admin)</Badge>
              ) : (
                <span className="font-semibold text-ink-900">
                  {previewSites.length} site{previewSites.length === 1 ? '' : 's'}
                  {previewSites.length > 0 && previewSites.length <= 6 && (
                    <span className="font-normal text-ink-500"> — {previewSites.map((s) => s.name).join(', ')}</span>
                  )}
                </span>
              )}
            </div>
          </form>
        )}
      </Modal>
    </>
  )
}
