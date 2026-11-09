import { describe, it, expect } from 'vitest'
import { receiveFromVendorUpdate, validateRefilledClosed, validateRefilledHpt } from './receive'
import { receiveClosures, hptSuppressed } from './defectClosure'
import { applyListFilters } from './listFilter'
import { deriveExtinguisherDefects } from './derivedExtDefects'
import { isInProcess, isToBeRefilled, severityLabel } from './extinguisherLogic'
import { STATUS, STATUS_LABEL } from './constants'
import { buildExtinguisherExportRows } from './exporter'
import { defectRows } from '../../../../stack/lib/siteSummary.js'

const today = new Date(2026, 9, 15)
const out = {
  id: 'e1',
  status: STATUS.IN_PROCESS_REFILLING,
  serialNo: 'FE-9',
  type: 'ABC',
  capacity: '6 Kg',
  centerName: 'Depot',
  region: 'North',
  entity: 'COCO',
  location: 'Lobby',
  siteId: 's1',
  physicalDefects: ['empty', 'pin'],
  dateOfNextRefill: '2026-01-01',
  dateOfNextHPT: '2028-01-01',
  quotation: { submittedAt: '2026-09-01', vendor: 'Acme' },
}

const input = { receivedOn: '2026-10-15', dateOfNextRefill: '2027-10-15' }

describe('validateRefilledClosed', () => {
  it('accepts both dates only when they fall after today', () => {
    expect(
      validateRefilledClosed(
        { dateOfNextRefill: '2027-01-01', dateOfNextHPT: '2031-01-01' },
        '2026-10-15'
      )
    ).toBe('')
  })

  it('rejects a missing date, today, and a date already past', () => {
    expect(
      validateRefilledClosed({ dateOfNextRefill: '', dateOfNextHPT: '2031-01-01' }, '2026-10-15')
    ).toMatch(/both new due dates/)
    expect(
      validateRefilledClosed(
        { dateOfNextRefill: '2026-10-15', dateOfNextHPT: '2031-01-01' },
        '2026-10-15'
      )
    ).toMatch(/after today/)
    expect(
      validateRefilledClosed(
        { dateOfNextRefill: '2027-01-01', dateOfNextHPT: '2020-01-01' },
        '2026-10-15'
      )
    ).toMatch(/after today/)
  })
})

describe('validateRefilledHpt', () => {
  const cert = {
    testedOn: '2026-10-01',
    vendor: 'Acme Test',
    fileName: 'cert.pdf',
    fileData: 'data:application/pdf;base64,QQ==',
  }

  it('asks for nothing when the hydrostatic date is the one already stored', () => {
    expect(validateRefilledHpt('2031-01-01', { dateOfNextHPT: '2031-01-01' })).toBe('')
  })

  it('requires the certificate when the date moves', () => {
    expect(validateRefilledHpt('2020-01-01', { dateOfNextHPT: '2031-01-01' })).toMatch(/certificate/)
    expect(
      validateRefilledHpt('2020-01-01', {
        dateOfNextHPT: '2031-01-01',
        certificate: { ...cert, vendor: '' },
      })
    ).toMatch(/agency/)
    expect(
      validateRefilledHpt('2020-01-01', { dateOfNextHPT: '2031-01-01', certificate: cert })
    ).toBe('')
  })
})

describe('receiveFromVendorUpdate', () => {
  it('returns the unit to Active, records the received date, and moves the refill date', () => {
    const r = receiveFromVendorUpdate(out, input)
    expect(r.error).toBe('')
    expect(r.updates).toMatchObject({
      status: STATUS.ACTIVE,
      receivedAt: '2026-10-15',
      lastRefilledAt: '2026-10-15',
      dateOfNextRefill: '2027-10-15',
      quotation: null,
    })
    expect(r.updates.physicalDefects).toEqual(['pin'])
    expect(r.clearedDefects).toEqual(['empty'])
    expect(r.updates.dateOfNextHPT).toBeUndefined()
  })

  it('refuses a unit that is not with the vendor, and a future received date', () => {
    expect(receiveFromVendorUpdate({ ...out, status: STATUS.ACTIVE }, input).error).toMatch(
      /vendor/
    )
    expect(receiveFromVendorUpdate(out, { ...input, receivedOn: '2026-12-01' }).error).toMatch(
      /future/
    )
    expect(
      receiveFromVendorUpdate(out, { ...input, dateOfNextRefill: '2026-10-15' }).error
    ).toMatch(/after/)
  })

  it('leaves the hydrostatic test date overdue when that test has not been recorded', () => {
    const due = { ...out, dateOfNextHPT: '2020-01-01' }
    const r = receiveFromVendorUpdate(due, input)
    const merged = { ...due, ...r.updates }
    expect(isToBeRefilled(merged, today)).toBe(true)
    expect(deriveExtinguisherDefects([merged], new Set(), today).map((d) => d.defectType)).toEqual([
      'hpt_due',
    ])
  })
})

describe('after receipt the unit reads as Active everywhere the open lists look', () => {
  const r = receiveFromVendorUpdate(out, input)
  const merged = { ...out, ...r.updates }

  it('matches an Active status filter and leaves the in-process filter', () => {
    expect(isInProcess(merged)).toBe(false)
    expect(isToBeRefilled(merged, today)).toBe(false)
    expect(severityLabel(merged, today)).toBe('PIN')
    expect(applyListFilters([merged], { status: [STATUS.ACTIVE] })).toEqual([merged])
    expect(applyListFilters([merged], { status: [STATUS.IN_PROCESS_REFILLING] })).toEqual([])
  })

  it('exports Status as Active', () => {
    const [row] = buildExtinguisherExportRows([merged], today)
    expect(row.Status).toBe(STATUS_LABEL[STATUS.ACTIVE])
    expect(row.Status).toBe('Active')
    expect(row['Date of Next Refill']).toBe('2027-10-15')
  })

  it('drops off the Empty defect list and the site-lookup open-defect rows', () => {
    expect(deriveExtinguisherDefects([merged], new Set(), today)).toEqual([])
    expect(deriveExtinguisherDefects([out], new Set(), today).map((d) => d.defectLabel)).toEqual([
      'Empty',
    ])
    const rows = defectRows({ extinguishers: [merged], reports: [] }, '2026-10-15')
    expect(rows.map((d) => d.defectType)).toEqual([])
    expect(
      defectRows({ extinguishers: [out], reports: [] }, '2026-10-15').map((d) => d.defectType)
    ).toEqual(['empty'])
  })

  it('writes a closure for the empty defect and leaves the physical one', () => {
    const docs = receiveClosures(out, {
      receivedOn: '2026-10-15',
      closedBy: 'Ravi',
      closedByUid: 'u1',
    })
    expect(docs).toHaveLength(1)
    expect(docs[0]).toMatchObject({
      defectKey: 'e1:empty',
      defectType: 'empty',
      defectLabel: 'Empty',
      kind: 'extinguisher',
      remarks: 'Received back from vendor',
      closedOn: '2026-10-15',
      closedBy: 'Ravi',
      closedByUid: 'u1',
      source: 'received',
      serialNo: 'FE-9',
      photo: null,
    })
  })
})

describe('a closed HPT-due defect stays off the open list until its due date changes', () => {
  const ext = {
    id: 'e2',
    status: 'active',
    serialNo: 'FE-2',
    dateOfNextHPT: '2020-01-01',
    hptClosedFor: '2020-01-01',
    physicalDefects: [],
  }

  it('suppresses the derived row and the site-lookup row, and reopens when the date moves', () => {
    expect(hptSuppressed(ext)).toBe(true)
    expect(deriveExtinguisherDefects([ext], new Set(), today)).toEqual([])
    expect(defectRows({ extinguishers: [ext] }, '2026-10-15')).toEqual([])
    const moved = { ...ext, dateOfNextHPT: '2026-01-01' }
    expect(hptSuppressed(moved)).toBe(false)
    expect(deriveExtinguisherDefects([moved], new Set(), today).map((d) => d.id)).toEqual([
      'e2:hpt_due',
    ])
  })
})
