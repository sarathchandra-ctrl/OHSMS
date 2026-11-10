import { describe, it, expect } from 'vitest'
import { applyControlPatch } from './data'

// The merge behind patchAdditionalControl. It exists as a pure function because
// what went wrong here was silent: the Action Tracker rebuilt the whole
// activities array from a snapshot and wrote it back, so closing one action
// reverted every edit anyone else had made since — on a risk register, where a
// vanished hazard is the thing the register is for.

const tree = () => [
  {
    id: 'act-1',
    name: 'Welding',
    hazards: [
      {
        id: 'haz-1',
        name: 'Arc flash',
        additionalControls: [
          { id: 'c-1', description: 'Screens', status: 'Open' },
          { id: 'c-2', description: 'PPE', status: 'Open' },
        ],
      },
      { id: 'haz-2', name: 'Fume', additionalControls: [{ id: 'c-3', status: 'Open' }] },
    ],
  },
  { id: 'act-2', name: 'Grinding', hazards: [{ id: 'haz-3', additionalControls: [] }] },
]

const at = (activities, a, h, c) =>
  activities.find((x) => x.id === a).hazards.find((x) => x.id === h)
    .additionalControls.find((x) => x.id === c)

const locator = { activityId: 'act-1', hazardId: 'haz-1', controlId: 'c-1' }

describe('applyControlPatch', () => {
  it('sets the field on the control named', () => {
    const next = applyControlPatch(tree(), locator, { status: 'Implemented' })
    expect(at(next, 'act-1', 'haz-1', 'c-1').status).toBe('Implemented')
  })

  it('keeps the rest of the control it patched', () => {
    const next = applyControlPatch(tree(), locator, { status: 'Implemented' })
    expect(at(next, 'act-1', 'haz-1', 'c-1').description).toBe('Screens')
  })

  it('leaves the sibling control alone', () => {
    const next = applyControlPatch(tree(), locator, { status: 'Implemented' })
    expect(at(next, 'act-1', 'haz-1', 'c-2').status).toBe('Open')
  })

  it('leaves the sibling hazard alone', () => {
    const next = applyControlPatch(tree(), locator, { status: 'Implemented' })
    expect(at(next, 'act-1', 'haz-2', 'c-3').status).toBe('Open')
  })

  it('leaves the other activity alone', () => {
    const next = applyControlPatch(tree(), locator, { status: 'Implemented' })
    expect(next.find((a) => a.id === 'act-2')).toEqual(tree()[1])
  })

  it('KEEPS a hazard added since this screen last read — the defect', () => {
    // The transaction hands this the state as it is NOW, so a hazard somebody
    // added a moment ago is in `activities` and has to survive the patch. The
    // old path built the array from a stale snapshot, where it was not.
    const fresh = tree()
    fresh[0].hazards.push({ id: 'haz-new', name: 'Hot work', additionalControls: [] })
    const next = applyControlPatch(fresh, locator, { status: 'Implemented' })
    expect(next[0].hazards.map((h) => h.id)).toContain('haz-new')
  })

  it('does not mutate what it was given', () => {
    const before = tree()
    applyControlPatch(before, locator, { status: 'Implemented' })
    expect(before[0].hazards[0].additionalControls[0].status).toBe('Open')
  })

  it('applies several fields at once', () => {
    const next = applyControlPatch(tree(), locator, { status: 'Closed', dueDate: '2026-09-30' })
    expect(at(next, 'act-1', 'haz-1', 'c-1')).toMatchObject({ status: 'Closed', dueDate: '2026-09-30' })
  })

  it('throws when the control has been removed by somebody else', () => {
    // Reporting success here would tell the person their action is complete
    // while it stays open on everybody's tracker.
    expect(() => applyControlPatch(tree(), { ...locator, controlId: 'gone' }, { status: 'Closed' }))
      .toThrow(/no longer/)
  })

  it('throws when the hazard has been removed', () => {
    expect(() => applyControlPatch(tree(), { ...locator, hazardId: 'gone' }, { status: 'Closed' }))
      .toThrow(/no longer/)
  })

  it('throws when the activity has been removed', () => {
    expect(() => applyControlPatch(tree(), { ...locator, activityId: 'gone' }, { status: 'Closed' }))
      .toThrow(/no longer/)
  })

  it('throws rather than inventing a tree when there are no activities', () => {
    expect(() => applyControlPatch([], locator, { status: 'Closed' })).toThrow(/no longer/)
    expect(() => applyControlPatch(undefined, locator, { status: 'Closed' })).toThrow(/no longer/)
  })

  it('copes with an activity that has no hazards array', () => {
    expect(() => applyControlPatch([{ id: 'act-1' }], locator, { status: 'Closed' })).toThrow(/no longer/)
  })
})
