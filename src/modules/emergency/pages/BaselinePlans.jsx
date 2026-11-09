import { useEffect, useMemo, useState } from 'react'
import toast from 'react-hot-toast'
import { toastCaught } from '../../../shared/lib/toastCaught'
import { Library, Info, PackagePlus, AlertTriangle } from 'lucide-react'
import { PageHeader, Card, SkeletonCard, Button, Modal } from '../../../shared/ui'
import { useAuth } from '../../../shared/auth/AuthContext'
import { subscribeOrgUsers } from '../../../shared/org/orgData'
import RescuePlans from '../components/RescuePlans'
import { subscribeRescuePlans, RESCUE_SCENARIOS, installBaselineLibrary } from '../lib/firestore'
import { BASELINE_LIBRARY } from '../lib/baselineLibrary'

/**
 * The org-wide baseline emergency response library. Sites recall these plans
 * and adapt them locally — the same pattern as baseline risk assessments.
 */
export default function BaselinePlans() {
  const { actor, isManager } = useAuth()
  const [plans, setPlans] = useState(null)
  const [users, setUsers] = useState([])
  const [installOpen, setInstallOpen] = useState(false)
  const [replace, setReplace] = useState(false)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    const u1 = subscribeRescuePlans(setPlans)
    const u2 = subscribeOrgUsers(setUsers)
    return () => { u1(); u2() }
  }, [])

  const approvedUsers = useMemo(() => users.filter((u) => u.status === 'approved'), [users])
  const baselines = useMemo(() => (plans || []).filter((p) => p.kind === 'baseline'), [plans])
  const coverage = useMemo(() => {
    const covered = new Set(baselines.map((b) => b.scenario))
    return RESCUE_SCENARIOS.filter((s) => s !== 'Other').filter((s) => !covered.has(s))
  }, [baselines])

  // What the standard library would add on top of what this org already has.
  const missingFromLibrary = useMemo(() => {
    const covered = new Set(baselines.map((b) => b.scenario))
    return BASELINE_LIBRARY.filter((e) => !covered.has(e.scenario))
  }, [baselines])

  const install = async () => {
    setBusy(true)
    try {
      const { added, updated } = await installBaselineLibrary(BASELINE_LIBRARY, baselines, actor, { replace })
      toast.success(
        added || updated
          ? `${added} plan(s) added${updated ? `, ${updated} replaced` : ''}`
          : 'Every standard scenario is already here'
      )
      setInstallOpen(false)
      setReplace(false)
    } catch (err) {
      toastCaught(err, 'Failed to install the library')
    } finally {
      setBusy(false)
    }
  }

  if (plans === null) {
    return (
      <>
        <PageHeader title="Baseline Emergency Response" subtitle="Standard rescue plans every site can recall" icon={Library} />
        <SkeletonCard className="max-w-3xl" />
      </>
    )
  }

  return (
    <>
      <PageHeader
        title="Baseline Emergency Response"
        subtitle="Your organization's standard rescue plans — each site recalls these and adapts them locally"
        icon={Library}
        actions={isManager && (missingFromLibrary.length > 0 || baselines.length > 0) && (
          <Button
            variant={baselines.length === 0 ? 'primary' : 'ghost'}
            icon={PackagePlus}
            onClick={() => { setReplace(false); setInstallOpen(true) }}
          >
            {baselines.length === 0
              ? `Install standard library (${BASELINE_LIBRARY.length})`
              : missingFromLibrary.length > 0
                ? `Add ${missingFromLibrary.length} standard plan(s)`
                : 'Reinstall standard library'}
          </Button>
        )}
      />

      {/* Nothing to recall until this library exists, so make the first step obvious. */}
      {baselines.length === 0 && (
        <Card className="mb-4 border-brand-200 bg-brand-50">
          <div className="flex flex-wrap items-start gap-3">
            <PackagePlus size={20} className="mt-0.5 shrink-0 text-brand-700" />
            <div className="min-w-0 flex-1">
              <p className="font-semibold text-brand-900">Start with the standard library</p>
              <p className="mt-0.5 text-sm text-brand-800">
                {BASELINE_LIBRARY.length} industry-standard rescue procedures covering fire, medical, chemical,
                confined space, structural and security emergencies — written against <b>roles</b> rather than
                names, so they work for any organization. Install them, edit anything you want, then each site
                recalls what it needs. Until this library exists, sites have nothing to recall.
              </p>
            </div>
            {isManager && (
              <Button icon={PackagePlus} onClick={() => { setReplace(false); setInstallOpen(true) }}>
                Install {BASELINE_LIBRARY.length} plans
              </Button>
            )}
          </div>
        </Card>
      )}

      <Card className="mb-4 !py-3">
        <p className="flex items-start gap-2 text-sm text-ink-600">
          <Info size={16} className="mt-0.5 shrink-0 text-brand-600" />
          <span>
            Write each scenario once here. On a site&apos;s <b>Rescue Plans</b> tab, use <b>Recall baseline</b> to copy
            them in — the site copy stays editable and is flagged <b>Adapted from baseline</b> once changed.
            {coverage.length > 0 && (
              <> Scenarios with no baseline yet: <b>{coverage.join(', ')}</b>.</>
            )}
          </span>
        </p>
      </Card>

      <RescuePlans baseline plans={plans} users={approvedUsers} />

      {/* Install / reinstall the standard library */}
      <Modal
        open={installOpen}
        onClose={() => setInstallOpen(false)}
        title="Install the standard baseline library"
        size="lg"
        footer={
          <>
            <Button variant="ghost" onClick={() => setInstallOpen(false)}>Cancel</Button>
            <Button icon={PackagePlus} loading={busy} onClick={install}>
              {replace
                ? `Replace all ${BASELINE_LIBRARY.length}`
                : `Add ${missingFromLibrary.length || 0} plan(s)`}
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <p className="text-sm text-ink-600">
            {missingFromLibrary.length > 0
              ? <>Adds <b>{missingFromLibrary.length}</b> standard procedure(s) not yet in your library. Scenarios you
                already have are left alone, so nothing you have written is touched.</>
              : <>Every standard scenario is already in your library. Nothing will be added unless you choose to
                replace them below.</>}
          </p>

          {missingFromLibrary.length > 0 && (
            <div className="max-h-56 overflow-auto rounded-2xl border border-surface-200">
              <table className="w-full text-sm">
                <tbody className="divide-y divide-surface-100">
                  {missingFromLibrary.map((e) => (
                    <tr key={e.scenario}>
                      <td className="px-4 py-2 font-medium text-ink-800">{e.scenario}</td>
                      <td className="px-4 py-2 text-ink-500">{e.title}</td>
                      <td className="whitespace-nowrap px-4 py-2 text-right text-ink-400">{e.steps.length} steps</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {baselines.length > 0 && (
            <label className="flex cursor-pointer items-start gap-3 rounded-2xl border border-amber-200 bg-amber-50 p-3">
              <input type="checkbox" className="mt-1" checked={replace} onChange={(e) => setReplace(e.target.checked)} />
              <span className="text-sm text-amber-900">
                <span className="font-semibold">Also replace the {baselines.length} plan(s) I already have</span>
                <span className="mt-0.5 flex items-start gap-1.5">
                  <AlertTriangle size={14} className="mt-0.5 shrink-0" />
                  Overwrites your edits to those baselines with the standard wording. Sites keep their own copies,
                  but each will be flagged <b>Baseline revised</b> so they can pull the change and re-approve.
                </span>
              </span>
            </label>
          )}

          <p className="text-xs text-ink-500">
            Procedures name a role for every step, never a person — they read in whatever your organization calls
            each role (Org Settings → General). Emergency phone numbers come from each site&apos;s own mapped
            contacts, so the same procedures work in any country.
          </p>
        </div>
      </Modal>
    </>
  )
}
