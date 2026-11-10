import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { ENERGY_SOURCES, GROUP_LOTO_BOX, LOTO_DEVICES } from './energySources'
import { LOCK_STATUS, PROCEDURE_STATUS } from './procedures'
import { ROLE_META, ROLES } from './roles'
import { HECP_SHAPES, TECHNICIAN_LABEL, TECHNICIAN_ROLE } from './terminology'

const here = dirname(fileURLToPath(import.meta.url))

function sourceFiles(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) sourceFiles(path, out)
    else if (/\.(js|jsx)$/.test(name) && !name.endsWith('.test.js') && !name.endsWith('.test.jsx'))
      out.push(path)
  }
  return out
}

describe('terminology shared with hecp-loto', () => {
  it('calls the person a Technician', () => {
    expect(TECHNICIAN_LABEL).toBe('Technician')
    expect(TECHNICIAN_ROLE).toBe('technician')
    expect(ROLE_META[ROLES.TECHNICIAN].label).toBe('Technician')
  })

  it('keeps hecp-loto procedure statuses, lock states, prefixes and devices', () => {
    expect(HECP_SHAPES.procedureStatuses).toEqual([
      'draft',
      'pending_approval',
      'approved',
      'rejected',
    ])
    expect(Object.values(PROCEDURE_STATUS)).toEqual(HECP_SHAPES.procedureStatuses)
    expect(HECP_SHAPES.lockStatuses).toEqual(['unlocked', 'partial', 'locked'])
    expect(Object.values(LOCK_STATUS)).toEqual(['unlocked', 'partial', 'locked'])
    expect(HECP_SHAPES.pointPrefixes).toEqual(['E', 'M', 'H', 'P', 'C', 'G'])
    expect(ENERGY_SOURCES.map((e) => e.prefix)).toEqual(['E', 'M', 'H', 'P', 'C', 'G'])
    expect(HECP_SHAPES.deviceKeys).toEqual([
      'safety_padlock',
      'hasp',
      'pin_inout',
      'ball_valve_lock',
      'gate_valve_lock',
      'plug_cover',
      'cable_lockout',
      'flange_blind',
    ])
    expect(LOTO_DEVICES.map((d) => d.key)).toEqual(HECP_SHAPES.deviceKeys)
    expect(GROUP_LOTO_BOX).toBe('group_loto_box')
    expect(HECP_SHAPES.lockTypes).toEqual(['personal', 'department'])
  })

  it('does not use the HYD8 role word MST anywhere in the module source', () => {
    const root = join(here, '..')
    const hits = []
    for (const file of sourceFiles(root)) {
      const text = readFileSync(file, 'utf8')
      if (/\bMST\b/.test(text)) hits.push(file)
    }
    expect(hits).toEqual([])
  })
})
