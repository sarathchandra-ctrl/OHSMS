// @vitest-environment jsdom
//
// ─────────────────────────────────────────────────────────────────────────────
// What the SAVE actually carries.
//
// prelaunch.test.js covers refiledKey, and it passed while the feature was
// broken in production — because the defect was never in the rule, it was in
// applying an edit-only rule to a create. A unit test of the helper cannot see
// that; only a test that submits the form can.
//
// So these drive the real dialog and assert on the payload handed to onSubmit.
// That payload is the record, and `prelaunchKey` in it is the whole of what
// ties an uploaded certificate to the checklist row somebody clicked Add on.
// ─────────────────────────────────────────────────────────────────────────────
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import DocumentDialog from './DocumentDialog'
import { buildTree, bucketNode, prelaunchNode, PRE_LAUNCH } from './lib/tree'

const sites = [
  { id: 's1', name: 'North Plant', region: 'North', entity: 'Acme Mfg' },
  { id: 's2', name: 'South Depot', region: 'South', entity: 'Acme Logistics' },
]
const tree = buildTree({ sites })

const ELECTRICAL_S1 = prelaunchNode('s1', 'electrical')
const ELECTRICAL_S2 = prelaunchNode('s2', 'electrical')
const PRE_S1 = bucketNode('s1', PRE_LAUNCH)

/** The seed the checklist hands over when somebody clicks Add on a row. */
const seed = {
  title: 'Load calculation and Sanctioned load report',
  docType: 'Policy',
  owner: 'Project',
  prelaunchKey: 'electrical-01',
}

function open(props = {}) {
  const onSubmit = vi.fn()
  render(
    <DocumentDialog
      open
      mode="new"
      nodeId={ELECTRICAL_S1}
      tree={tree}
      sites={sites}
     
      busy={false}
      onClose={() => {}}
      onSubmit={onSubmit}
      {...props}
    />
  )
  return onSubmit
}

/** Fill in a link, which is the cheapest source that passes validation. */
function attachLink() {
  fireEvent.change(screen.getByLabelText(/The document itself/i), { target: { value: 'link' } })
  fireEvent.change(screen.getByPlaceholderText('https://…'), {
    target: { value: 'https://example.test/a.pdf' },
  })
}

const save = () => fireEvent.submit(document.getElementById('document-form'))

afterEach(cleanup)

describe('adding a document to a checklist placeholder', () => {
  // THE REGRESSION. Every document added from a row saved without its key, so
  // it landed as an ordinary file in the folder and the row stayed open —
  // which reads to the person doing it as "it made a new document instead of
  // filling in the placeholder".
  it('carries the row key through to the record', () => {
    const onSubmit = open({ seed })
    attachLink()
    save()

    expect(onSubmit).toHaveBeenCalledTimes(1)
    const [payload, error] = onSubmit.mock.calls[0]
    expect(error).toBeFalsy()
    expect(payload.prelaunchKey).toBe('electrical-01')
  })

  it('files it at the site the folder names, so readiness can find it', () => {
    const onSubmit = open({ seed })
    attachLink()
    save()

    const [payload] = onSubmit.mock.calls[0]
    // Readiness matches on siteId AND key; either one missing reopens the row.
    expect(payload.siteId).toBe('s1')
    expect(payload.level).toBe('site')
    expect(payload.folderId).toBe(ELECTRICAL_S1)
  })

  it('keeps the key when the row is filed into the bucket above its category', () => {
    const onSubmit = open({ seed, nodeId: PRE_S1 })
    attachLink()
    save()

    expect(onSubmit.mock.calls[0][0].prelaunchKey).toBe('electrical-01')
  })

  // An ordinary Add document, not from a row, must not acquire one.
  it('writes no key for a document added without a row', () => {
    const onSubmit = open()
    fireEvent.change(screen.getByLabelText(/Document title/i), { target: { value: 'Site plan' } })
    fireEvent.change(screen.getByLabelText(/^Type/i), { target: { value: 'Policy' } })
    attachLink()
    save()

    expect(onSubmit.mock.calls[0][0].prelaunchKey).toBeUndefined()
  })
})

describe('editing a document that satisfies a row', () => {
  const filed = {
    id: 'd1',
    title: 'Load calculation and Sanctioned load report',
    docType: 'Policy',
    source: 'link',
    linkUrl: 'https://example.test/a.pdf',
    prelaunchKey: 'electrical-01',
    siteId: 's1',
    level: 'site',
    __node: ELECTRICAL_S1,
  }

  it('keeps the key when it is tidied within its own site', () => {
    const onSubmit = open({ mode: 'edit', doc: filed, nodeId: ELECTRICAL_S1 })
    save()
    expect(onSubmit.mock.calls[0][0].prelaunchKey).toBe('electrical-01')
  })

  // The finding the guarded rule exists for: carrying the key across would
  // close the row at the new site and reopen it at the old.
  it('drops the key when it is moved to another site', () => {
    const onSubmit = open({ mode: 'edit', doc: filed, nodeId: ELECTRICAL_S1 })
    fireEvent.change(screen.getByLabelText(/Location/i), { target: { value: ELECTRICAL_S2 } })
    save()

    const [payload] = onSubmit.mock.calls[0]
    expect(payload.prelaunchKey).toBeUndefined()
    expect(payload.siteId).toBe('s2')
  })
})
