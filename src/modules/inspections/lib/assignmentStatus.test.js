import { describe, it, expect } from 'vitest'
import { applyAssignmentStatus } from './data'
import { buildScheduledTasks } from './schedule'

// A completed assigned inspection used to stay Pending forever. The only
// statuses ever written were Pending and Cancelled, so it kept rolling into
// overdueTasks — the list people actually work from — and the more work got
// done the longer that list grew.

describe('applyAssignmentStatus', () => {
  const list = () => [
    { id: 'a1', status: 'Pending', scheduledDate: '2026-09-01' },
    { id: 'a2', status: 'Pending', scheduledDate: '2026-09-02' },
    { id: 'a3', status: 'Cancelled', scheduledDate: '2026-08-01' },
  ]

  it('sets the status of the one named', () => {
    const { assignments } = applyAssignmentStatus(list(), 'a1', 'Completed')
    expect(assignments.find((a) => a.id === 'a1').status).toBe('Completed')
  })

  it('reports that it found it', () => {
    expect(applyAssignmentStatus(list(), 'a1', 'Completed').found).toBe(true)
  })

  it('leaves every other assignment exactly as it was', () => {
    const { assignments } = applyAssignmentStatus(list(), 'a1', 'Completed')
    expect(assignments.filter((a) => a.id !== 'a1')).toEqual(list().filter((a) => a.id !== 'a1'))
  })

  it('keeps the rest of the assignment it changed', () => {
    const { assignments } = applyAssignmentStatus(list(), 'a2', 'Completed')
    expect(assignments.find((a) => a.id === 'a2').scheduledDate).toBe('2026-09-02')
  })

  it('does not mutate what it was given', () => {
    const before = list()
    applyAssignmentStatus(before, 'a1', 'Completed')
    expect(before[0].status).toBe('Pending')
  })

  it('reports not-found rather than inventing an assignment', () => {
    const { assignments, found } = applyAssignmentStatus(list(), 'gone', 'Completed')
    expect(found).toBe(false)
    expect(assignments).toEqual(list())
  })

  it('copes with a template that has no assignments at all', () => {
    expect(applyAssignmentStatus(undefined, 'a1', 'Completed')).toEqual({ assignments: [], found: false })
  })
})

// The belt-and-braces half. completeAssignment is a SECOND write and can fail
// on its own, so the schedule drops a done one-off on the record alone.
describe('a completed one-off leaves the schedule', () => {
  const template = (assignments) => ({
    id: 't1', title: 'Monthly extinguisher check', status: 'Draft', assignments,
  })
  const oneOff = { id: 'a1', status: 'Pending', scheduledDate: '2026-09-01', siteId: 's1' }
  const currentMonth = new Date(2026, 8, 15)

  const idsFor = (templates, records) =>
    buildScheduledTasks({ templates, records, currentMonth }).map((t) => t.assignmentId)

  it('is on the schedule while nothing has been recorded against it', () => {
    expect(idsFor([template([oneOff])], [])).toContain('a1')
  })

  it('drops off once an inspection names it', () => {
    expect(idsFor([template([oneOff])], [{ assignmentId: 'a1', completedAt: '2026-09-01' }]))
      .not.toContain('a1')
  })

  it('drops off when its status was flipped to Completed', () => {
    expect(idsFor([template([{ ...oneOff, status: 'Completed' }])], [])).not.toContain('a1')
  })

  it('is NOT dropped by a record belonging to a different assignment', () => {
    expect(idsFor([template([oneOff])], [{ assignmentId: 'a2', completedAt: '2026-09-01' }]))
      .toContain('a1')
  })

  it('is NOT dropped by an unassigned record for the same template', () => {
    // A walk-up inspection of the same form is not the assigned one being done.
    expect(idsFor([template([oneOff])], [{ templateId: 't1', completedAt: '2026-09-01' }]))
      .toContain('a1')
  })
})
