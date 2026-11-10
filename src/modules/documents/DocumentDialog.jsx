import { useMemo, useState } from 'react'
import { Modal, Button, Field, Select } from '../../shared/ui'
import RecordForm from '../../shared/module-kit/RecordForm'
import { MAX_UPLOAD_BYTES } from '../../shared/storage'
import {
  DOC_TYPES, SOURCE_OPTIONS, SOURCE_UPLOAD, SOURCE_LINK, isSafeDocumentUrl,
} from './lib/docTypes'
import { fileChoices, nodeAt, nodeClassification, storageFolder, breadcrumbOf } from './lib/tree'
import { refiledKey } from './lib/prelaunch'

/**
 * Adding a document, or editing one.
 *
 * A document is A FILE OR A LINK, and the two are the same kind of thing here:
 * both are something you open, both live in a folder, both show up in the
 * browser as a file. The only place the difference surfaces is this form, where
 * one asks for bytes and the other for an address.
 *
 * WHERE it goes is a first-class field rather than something implied by which
 * folder you happened to be standing in. That single control is also the move:
 * changing it on an existing document re-files it, which is why there is no
 * separate "Move to…" anywhere else in the module.
 *
 * There is no site or region picker. The folder IS the classification — filing
 * into a site's Pre Launch folder is what makes the document that site's, in
 * the tree and on the server at once (stack/policy.mjs siteBlocked). A second control could only disagree
 * with the first.
 */
const FIELDS = [
  { key: 'title', label: 'Document title', full: true, required: true },
  { key: 'docType', label: 'Type', type: 'select', required: true, options: DOC_TYPES,
    placeholder: 'What kind of document is this?' },
  {
    key: 'source',
    label: 'The document itself',
    type: 'select',
    required: true,
    options: SOURCE_OPTIONS,
    placeholder: 'Upload it, or link to it',
    hint: 'Upload a copy into this folder, or point at where it already lives',
  },
  {
    key: 'file',
    label: 'File',
    type: 'file',
    full: true,
    when: (v) => v.source === SOURCE_UPLOAD,
    maxBytes: MAX_UPLOAD_BYTES,
    // Held, not uploaded. The bytes go to the bucket inside the save, once the
    // record is about to exist — see saveDoc. Uploading on pick used to strand
    // a file every time a form was abandoned, with nothing pointing at it to
    // tidy it up.
    //
    // It also means the folder chosen ABOVE is read at save time rather than at
    // pick time, so changing the location after attaching now files the bytes
    // where the record says they are.
    defer: true,
  },
  {
    key: 'linkUrl',
    label: 'Link',
    full: true,
    when: (v) => v.source === SOURCE_LINK,
    placeholder: 'https://…',
    hint: 'An http or https address — anything else is refused on save',
  },
  { key: 'version', label: 'Version', placeholder: 'e.g. 1.0' },
  { key: 'owner', label: 'Owner' },
  { key: 'reference', label: 'Reference no.' },
  { key: 'effectiveDate', label: 'Effective date', type: 'date' },
  { key: 'reviewDate', label: 'Next review date', type: 'date', hint: 'Overdue reviews are flagged' },
  { key: 'summary', label: 'Summary / notes', type: 'textarea', full: true, rows: 3 },
]

/**
 * @param seed fields to start filled in — the pre-launch checklist hands over a
 *        title, a type and the `prelaunchKey` tying the record to the row it
 *        satisfies. `location` is applied last: where a document goes is the
 *        folder the browser is standing in, and a seed must not move it.
 *
 * `prelaunchKey` has no field in FIELDS and never gets one. It is identity, not
 * data somebody types — and RecordForm leaves keys it does not render alone, so
 * it rides through the form and out the other side untouched.
 */
const emptyDoc = (location, seed) => ({
  title: '', docType: '', source: SOURCE_UPLOAD, file: null, linkUrl: '',
  version: '', owner: '', reference: '',
  effectiveDate: '', reviewDate: '', summary: '',
  ...(seed || {}),
  location,
})

export default function DocumentDialog({
  open, mode, doc, seed, nodeId, tree, sites, busy, onClose, onSubmit,
}) {
  /**
   * Where the form starts, and why it can start NOWHERE.
   *
   * A document in Unfiled resolves to a node the picker deliberately does not
   * offer — Unfiled is where things end up, never where they are put. Seeding
   * the select with it left a value no option matched, so the browser showed a
   * blank control that read as '', and the only sign anything was wrong came
   * at submit as "Choose a folder to file this in". That is precisely the
   * backlog workflow the Unfiled empty state invites, so it failed on the one
   * path it most needed to work.
   *
   * Blank on purpose now, with a prompt in the list. Defaulting to a real
   * folder would be worse than asking: we do not know where an unclassified
   * document belongs, and the nearest default — Org Level — is the WIDEST
   * visibility there is. Guessing that direction publishes things.
   */
  const [form, setForm] = useState(() => {
    const wanted = mode === 'edit' && doc ? doc.__node : nodeId
    const start = nodeAt(tree, wanted)?.filable ? wanted : ''
    return mode === 'edit' && doc ? { ...doc, location: start } : emptyDoc(start, seed)
  })

  const choices = useMemo(() => fileChoices(tree), [tree])
  const lookups = useMemo(() => ({ sites, tree }), [sites, tree])

  // The full path, spelled out under the picker. A select can only indent, and
  // "Pre Launch" on its own is the same label under forty different sites.
  const here = form.location
    ? breadcrumbOf(tree, form.location).map((n) => n.name).join(' / ')
    : 'The folder decides who can see this document'

  const submit = (e) => {
    e.preventDefault()
    // Checked on the way IN as well as on render. A javascript: or data: URL
    // stored by one member and clicked by another is stored XSS with an
    // audience, and a library is a place people click things.
    if (form.source === SOURCE_LINK && !isSafeDocumentUrl(form.linkUrl)) {
      return onSubmit(null, new Error('The link must be an http or https address'))
    }
    // Either a File waiting to be uploaded, or an upload result already on an
    // edited record. Both count as attached; neither is checked for a url,
    // because a deferred pick has none yet.
    if (form.source === SOURCE_UPLOAD && !form.file) {
      return onSubmit(null, new Error('Attach the file, or switch to a link'))
    }
    if (!nodeAt(tree, form.location)?.filable) {
      return onSubmit(null, new Error('Choose a folder to file this in'))
    }

    const { location, __node: _node, ...rest } = form
    const classification = nodeClassification(tree, location, sites)

    // Re-filing an EXISTING document to another site drops the checklist row it
    // satisfied — see refiledKey, which owns that rule.
    //
    // `mode === 'edit'` is not decoration. A NEW document has no previous site
    // by definition, so there is nothing to re-file and nothing to compare
    // against: running the rule on a create asked whether '' equalled the site
    // being filed into, got no, and threw away the very key the placeholder had
    // just seeded. Every document added from a checklist row saved as an
    // ordinary file in the folder and left its row open — the feature, silently
    // off, on the one path it exists for.
    if (mode === 'edit' && rest.prelaunchKey) {
      const kept = refiledKey(rest.prelaunchKey, doc?.siteId, classification.siteId)
      if (kept) rest.prelaunchKey = kept
      else delete rest.prelaunchKey
    }

    return onSubmit({
      ...rest,
      // The folder decides who may see the document. nodeClassification writes
      // level / region / siteId / visibility and the siteRegion + siteEntity
      // snapshot, and the server reads siteId and visibility from the same
      // write, so the tree and the access rule never disagree.
      ...classification,
      folderId: location,
      // Recorded so the folder a file was filed under survives a later move:
      // the bytes do not move, and a record claiming a folder its file is not
      // in is worse than one that says where it went.
      folder: storageFolder(tree, location),
    })
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={mode === 'edit' ? 'Edit document' : 'Add a document'}
      subtitle={
        mode === 'edit' ? form.title
          // A seeded form is a checklist row being filled in, and the row's
          // title is already in the field below. Saying which handover item it
          // is beats repeating the generic invitation.
          : seed?.title || 'Upload a file, or link to one that already exists'
      }
      size="lg"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button type="submit" form="document-form" disabled={busy}>
            {busy ? 'Saving…' : mode === 'edit' ? 'Save changes' : 'Add document'}
          </Button>
        </>
      }
    >
      <form id="document-form" onSubmit={submit} className="space-y-4">
        <Field label="Location *" htmlFor="document-location" hint={here}>
          <Select
            id="document-location"
            required
            value={form.location}
            onChange={(e) => setForm((f) => ({ ...f, location: e.target.value }))}
          >
            {/* Only while nothing is chosen, so it cannot be re-selected. With
                `required`, the browser blocks the submit itself and says so on
                the control — which beats a toast fired after the fact. */}
            {!form.location && <option value="">Choose a folder…</option>}
            {choices.map((c) => (
              <option key={c.value} value={c.value}>
                {/* Non-breaking spaces, because a browser collapses ordinary
                    ones inside an option — and indentation is the only way a
                    select can show nesting at all. */}
                {'   '.repeat(c.depth)}{c.depth ? '└ ' : ''}{c.label}
              </option>
            ))}
          </Select>
        </Field>

        <RecordForm fields={FIELDS} value={form} onChange={setForm} lookups={lookups} />
      </form>
    </Modal>
  )
}
