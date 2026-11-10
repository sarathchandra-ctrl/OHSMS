// ─────────────────────────────────────────────────────────────────────────────
// Names this module shows people, and the data-shape contract it shares with
// hecp-loto (the standalone app this module was ported from).
//
// Two words from the HYD8 reference app are deliberately not used. The person
// who applies a lock is a Technician (the hecp-loto role), not that app's
// job-title abbreviation. "LOTO" stays the name of the energy-control
// procedure, the devices and the standard, which is what hecp-loto calls them.
// The per-job isolation permit was removed from the module (2026-11-10).
// ─────────────────────────────────────────────────────────────────────────────
import { ENERGY_SOURCES, GROUP_LOTO_BOX, LOTO_DEVICES } from './energySources'
import { LOCK_STATUS, PROCEDURE_STATUS } from './procedures'
import { ROLES } from './roles'

/** The person who applies and removes a lock. */
export const TECHNICIAN_LABEL = 'Technician'

/** Role key stored on a profile inside this module. */
export const TECHNICIAN_ROLE = ROLES.TECHNICIAN

/** Lock types a point or a group member can carry. hecp-loto's two. */
export const LOCK_TYPES = ['personal', 'department']

/**
 * The shapes a procedure and its locks are allowed to use. Tests pin these to
 * the hecp-loto values so a rename in one file cannot silently fork the data.
 */
export const HECP_SHAPES = {
  procedureStatuses: Object.values(PROCEDURE_STATUS),
  lockStatuses: Object.values(LOCK_STATUS),
  pointPrefixes: ENERGY_SOURCES.map((e) => e.prefix),
  deviceKeys: LOTO_DEVICES.map((d) => d.key),
  groupLockDevice: GROUP_LOTO_BOX,
  lockTypes: LOCK_TYPES,
}
