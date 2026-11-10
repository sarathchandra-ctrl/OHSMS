import { describe, expect, it } from 'vitest'
import {
  actionAssignedTo,
  canCloseAction,
  canUpdateActionStatus,
  actionOwnerDisplay,
  actionOwnerKind,
  actionOwnerRecord,
  actionOwnerText,
  meetingExportSheets,
  OWNER_DEPARTMENT,
  OWNER_PERSON,
} from './actionOwner'

describe('committee action owner', () => {
  it('treats a row that only has owner as a person', () => {
    const legacy = { action: 'Fix the gate', owner: 'Ada' }
    expect(actionOwnerKind(legacy)).toBe(OWNER_PERSON)
    expect(actionOwnerText(legacy)).toBe('Ada')
    expect(actionOwnerDisplay(legacy)).toBe('Ada')
    expect(actionOwnerRecord(legacy)).toEqual({
      ownerKind: OWNER_PERSON,
      owner: 'Ada',
      ownerUid: '',
      department: '',
    })
  })

  it('keeps a department and drops the person', () => {
    const row = actionOwnerRecord({
      ownerKind: OWNER_DEPARTMENT,
      department: ' Housekeeping ',
      owner: 'Ada',
    })
    expect(row).toEqual({
      ownerKind: OWNER_DEPARTMENT,
      department: 'Housekeeping',
      owner: '',
      ownerUid: '',
    })
    expect(actionOwnerDisplay(row)).toBe('Department · Housekeeping')
    expect(actionAssignedTo(row, { name: 'Housekeeping' })).toBe(false)
  })

  it('lets anyone in the department close it, and an admin, and not another department', () => {
    const row = { ownerKind: OWNER_DEPARTMENT, department: 'Housekeeping', owner: '' }
    expect(canCloseAction(row, { department: 'Housekeeping' })).toBe(true)
    // `department` is the profile field. `dept` is only used when that is blank.
    expect(canCloseAction(row, { department: '', dept: 'Housekeeping' })).toBe(true)
    expect(canCloseAction(row, { department: 'Safety', dept: 'Housekeeping' })).toBe(false)
    expect(canCloseAction(row, { department: 'Safety' })).toBe(false)
    expect(canCloseAction(row, { department: '' }, { elevated: true })).toBe(true)
    expect(canUpdateActionStatus(row, { department: 'Housekeeping' })).toBe(true)
    expect(canUpdateActionStatus(row, { department: 'Safety' }, { canEditMeeting: true })).toBe(false)
  })

  it('lets the named person update their own action, and nobody else', () => {
    const row = { owner: 'Ada' }
    expect(actionAssignedTo(row, { name: 'Ada' })).toBe(true)
    expect(actionAssignedTo(row, { email: 'Ada' })).toBe(true)
    expect(actionAssignedTo(row, { name: 'Bea' })).toBe(false)
    expect(actionAssignedTo({ ownerKind: OWNER_PERSON, owner: '' }, { name: 'Ada' })).toBe(false)
  })

  it('exports each action with its responsible party', () => {
    const sheets = meetingExportSheets(
      [
        {
          docId: 'MOM-1',
          siteId: 's1',
          date: '2026-10-01',
          type: 'HSE Committee Meeting',
          subject: 'Quarterly',
          attendees: [{}],
          actions: [
            { action: 'Fix the gate', owner: 'Ada', due: '2026-10-10', status: 'Open' },
            {
              action: 'Mop the yard',
              ownerKind: OWNER_DEPARTMENT,
              department: 'Housekeeping',
              owner: '',
              due: '2026-10-12',
              status: 'Open',
            },
          ],
        },
      ],
      (id) => (id === 's1' ? 'Yard' : id),
    )
    expect(sheets.meetings[0]).toMatchObject({ ID: 'MOM-1', Site: 'Yard', Actions: 2 })
    expect(sheets.actions).toEqual([
      {
        ID: 'MOM-1',
        Site: 'Yard',
        Action: 'Fix the gate',
        Responsible: 'Person',
        Owner: 'Ada',
        Due: '2026-10-10',
        Status: 'Open',
      },
      {
        ID: 'MOM-1',
        Site: 'Yard',
        Action: 'Mop the yard',
        Responsible: 'Department',
        Owner: 'Housekeeping',
        Due: '2026-10-12',
        Status: 'Open',
      },
    ])
  })
})
