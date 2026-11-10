// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import {
  POLICY,
  GENERAL,
  MEDICAL,
  KEY_CLASSES,
  policyFor,
  keyClassFor,
  sealsFiles,
  isHybridClass,
  fileLabel,
  leafRefs,
  mapSealed,
  cloneForEdit,
  OMIT,
} from './policy'

describe('the table itself', () => {
  it('gives every collection a key class that exists', () => {
    for (const [name, entry] of Object.entries(POLICY)) {
      expect(KEY_CLASSES, `${name} names an unknown key class`).toContain(entry.keyClass)
    }
  })

  it('names no field twice within one collection', () => {
    // A duplicate would seal the value, then see an envelope and pass it
    // through — harmless — but it means two people edited the same list without
    // seeing each other, which is how a field ends up in the wrong class.
    for (const [name, entry] of Object.entries(POLICY)) {
      const fields = entry.fields || []
      expect(new Set(fields).size, `${name} repeats a field`).toBe(fields.length)
    }
  })

  it('puts the health collections, and only those, in the medical class', () => {
    // These are exactly the collections stack/policy.mjs lets only managers
    // read (isMedical). If that list changes, this test is the reminder that the
    // key class has to move with it — a class stricter than its rule locks
    // people out, a class looser than its rule hands the data to the auditor.
    const medical = Object.entries(POLICY).filter(([, e]) => e.keyClass === MEDICAL).map(([k]) => k)
    expect(medical.sort()).toEqual(['illnesses', 'illnesses/files', 'injuries', 'injuries/records'])
  })

  it('seals nothing a query filters or orders on', () => {
    // Every where() in the app is on one of these, and every orderBy is on a
    // timestamp. Sealing one would turn a server-side filter into a full
    // client-side scan, silently, with no error anywhere.
    const queried = [
      'orgId', 'incidentId', 'personId', 'sessionId', 'permitId', 'employeeUid',
      'deletedAt', 'createdAt', 'updatedAt', 'uploadedAt', 'docId', 'refNo',
      'lifecycle', 'siteId', 'verified', 'status', 'kind', 'path', 'url',
    ]
    for (const [name, entry] of Object.entries(POLICY)) {
      for (const spec of entry.fields || []) {
        expect(queried, `${name} seals the query key ${spec}`).not.toContain(spec)
      }
    }
  })

  it('routes medical through the hybrid scheme and general through the symmetric one', () => {
    expect(isHybridClass(MEDICAL)).toBe(true)
    expect(isHybridClass(GENERAL)).toBe(false)
  })

  it('labels file bytes by class, not by collection', () => {
    // So confineMedicalRecords can move an object between collections without
    // making it unopenable, while a medical object replayed as a general one
    // still fails.
    expect(fileLabel(MEDICAL)).toBe('file:medical')
    expect(fileLabel(GENERAL)).toBe('file:general')
  })

  it('answers for collections it does not cover', () => {
    expect(policyFor('extinguishers')).toBe(null)
    expect(keyClassFor('extinguishers')).toBe(null)
    expect(sealsFiles('extinguishers')).toBe(false)
    expect(policyFor(undefined)).toBe(null)
  })

  it('seals the bytes of every collection that stores files', () => {
    // Setting this on a collection whose read path does not resolve sealed
    // objects renders ciphertext into an <img> — a broken picture in every
    // gallery and every exported PDF, with nothing on screen to say why.
    //   incidents/photos   subscribeIncidentPhotos
    //   illnesses/files    subscribeIllnessFiles
    //   mockDrills/photos  getMockDrillPhotos
    //
    // injuries/records is the exception and is listed separately on purpose:
    // NOTHING in the client reads those bytes back. Injuries.jsx shows the
    // COUNT of recordFileIds, not the files, and the reader this comment used
    // to name (useFileUrl) had already stopped being imported by anything.
    // Sealing it is still right — the bytes exist and the callable moves them —
    // but if a screen is ever built to display them, it has to resolve sealed
    // objects or it will render ciphertext.
    const sealing = Object.keys(POLICY).filter(sealsFiles).sort()
    expect(sealing).toEqual([
      'illnesses/files', 'incidents/photos', 'injuries/records', 'mockDrills/photos',
    ])
  })

  it('seals no bytes for a collection that stores none', () => {
    expect(sealsFiles('injuries')).toBe(false)
    expect(sealsFiles('incidents')).toBe(false)
    expect(sealsFiles('consultations')).toBe(false)
  })

  it('seals the inline dataUrl of EVERY collection that stores files', () => {
    // Found in production, not here, which is why this test exists.
    //
    // When the bucket is unavailable putFile returns null and the file is
    // written base64 INSIDE its pointer document. That copy has no Storage
    // object, so the object backfill skips it — correctly, there is nothing in
    // a bucket to seal. If `dataUrl` is also missing from the field policy,
    // NOTHING seals it: both migrations run, both report success, and the
    // photograph stays in the clear.
    //
    // incidents/photos was the one collection missing it. Every file-bearing
    // collection is checked here so the next one added cannot repeat it.
    for (const [name, entry] of Object.entries(POLICY)) {
      if (!entry.files) continue
      expect(entry.fields, `${name} stores files but does not seal its inline dataUrl`)
        .toContain('dataUrl')
    }
  })

  it('still seals the inline dataUrl of the galleries it leaves alone', () => {
    // Under the inline fallback the pointer IS the file, and that copy goes
    // through openDoc — so it can be sealed even where the bucket object cannot.
    expect(POLICY['illnesses/files'].fields).toContain('dataUrl')
    expect(POLICY['mockDrills/photos'].fields).toContain('dataUrl')
  })
})

describe('leafRefs', () => {
  it('finds a top-level field', () => {
    const doc = { narrative: 'Fell' }
    expect(leafRefs(doc, 'narrative')).toEqual([{ parent: doc, key: 'narrative' }])
  })

  it('finds a nested field', () => {
    const doc = { horizontal: { details: 'Checked other sites' } }
    const [ref] = leafRefs(doc, 'horizontal.details')
    expect(ref.parent).toBe(doc.horizontal)
    expect(ref.key).toBe('details')
  })

  it('finds a field on every element of an array', () => {
    const doc = { capa: [{ owner: 'A' }, { owner: 'B' }, { owner: 'C' }] }
    expect(leafRefs(doc, 'capa[].owner')).toHaveLength(3)
  })

  it('finds scalar array elements', () => {
    const doc = { commanders: ['A Kumar', 'B Singh'] }
    const refs = leafRefs(doc, 'commanders[]')
    expect(refs.map((r) => r.parent[r.key])).toEqual(['A Kumar', 'B Singh'])
  })

  it('descends through two levels of array', () => {
    const doc = { capa: [{ assignees: [{ name: 'A' }, { name: 'B' }] }, { assignees: [{ name: 'C' }] }] }
    expect(leafRefs(doc, 'capa[].assignees[].name')).toHaveLength(3)
  })

  it('creates nothing that is not already there', () => {
    // A policy naming horizontal.details must not add a `horizontal` to a
    // document that has none, or every save would grow the document with empty
    // scaffolding for fields nobody filled in.
    const doc = { narrative: 'x' }
    expect(leafRefs(doc, 'horizontal.details')).toEqual([])
    expect(leafRefs(doc, 'capa[].owner')).toEqual([])
    expect(doc).toEqual({ narrative: 'x' })
  })

  it('skips a field whose parent is the wrong type', () => {
    expect(leafRefs({ capa: 'not an array' }, 'capa[].owner')).toEqual([])
    expect(leafRefs({ horizontal: 'not an object' }, 'horizontal.details')).toEqual([])
    expect(leafRefs({ capa: [null, 3, { owner: 'A' }] }, 'capa[].owner')).toHaveLength(1)
  })

  it('finds a field that is present and empty', () => {
    // Present-and-empty is a real answer and must be sealed like any other;
    // `key in node` rather than a truthiness test is what makes that work.
    expect(leafRefs({ medication: '' }, 'medication')).toHaveLength(1)
    expect(leafRefs({ daysToReturnToWork: 0 }, 'daysToReturnToWork')).toHaveLength(1)
    expect(leafRefs({ medication: null }, 'medication')).toHaveLength(1)
  })
})

describe('cloneForEdit', () => {
  it('does not modify the original', () => {
    const doc = { capa: [{ owner: 'A' }] }
    const copy = cloneForEdit(doc)
    copy.capa[0].owner = 'B'
    expect(doc.capa[0].owner).toBe('A')
  })

  it('carries class instances across by reference, not by copy', () => {
    // A Firestore Timestamp flattened to a plain object loses .toDate(), and
    // three sorts in this app compare .seconds directly — which then returns 0
    // for every pair and leaves the list in its original order, looking sorted.
    class Timestamp {
      constructor(seconds) { this.seconds = seconds }
      toDate() { return new Date(this.seconds * 1000) }
    }
    const stamp = new Timestamp(1700000000)
    const copy = cloneForEdit({ createdAt: stamp, nested: { at: stamp } })
    expect(copy.createdAt).toBe(stamp)
    expect(copy.nested.at).toBe(stamp)
    expect(typeof copy.createdAt.toDate).toBe('function')
  })

  it('carries a write sentinel across untouched', () => {
    // serverTimestamp() is an opaque FieldValue; a copy of it is not one.
    const sentinel = Object.create({ _methodName: 'serverTimestamp' })
    expect(cloneForEdit({ createdAt: sentinel }).createdAt).toBe(sentinel)
  })
})

describe('mapSealed', () => {
  const upper = async (path, value) => (typeof value === 'string' ? value.toUpperCase() : value)

  it('transforms exactly the fields the policy names', async () => {
    const doc = { narrative: 'fell', location: 'bay 3', refNo: 'IRA-1' }
    const out = await mapSealed('incidents', doc, upper)
    expect(out.narrative).toBe('FELL')
    expect(out.location).toBe('bay 3')
    expect(out.refNo).toBe('IRA-1')
  })

  it('passes the SPEC path, not the concrete index', async () => {
    // The property that lets an array be reordered without losing the values in
    // it: every element binds to `capa[].owner`, so element 0 and element 3 are
    // interchangeable.
    const seen = []
    await mapSealed('incidents', { capa: [{ owner: 'A' }, { owner: 'B' }] }, async (path, v) => {
      seen.push(path)
      return v
    })
    expect(seen).toEqual(['capa[].owner', 'capa[].owner'])
  })

  it('leaves the input document alone', async () => {
    const doc = { narrative: 'fell' }
    await mapSealed('incidents', doc, upper)
    expect(doc.narrative).toBe('fell')
  })

  it('returns the document unchanged for an uncovered collection', async () => {
    const doc = { narrative: 'fell' }
    expect(await mapSealed('extinguishers', doc, upper)).toBe(doc)
  })

  it('survives null and non-objects', async () => {
    expect(await mapSealed('incidents', null, upper)).toBe(null)
    expect(await mapSealed('incidents', undefined, upper)).toBe(undefined)
  })

  it('removes an object field on OMIT', async () => {
    const out = await mapSealed('injuries', { medication: 'x', personId: 'p1' }, async () => OMIT)
    expect('medication' in out).toBe(false)
    expect(out.personId).toBe('p1')
  })

  it('compacts an array rather than leaving holes', async () => {
    // Splicing during the transform would shift indices while other jobs still
    // hold one; the holes are filled with undefined and removed at the end.
    const out = await mapSealed(
      'mockDrills',
      { commanders: ['A', 'B', 'C'] },
      async (path, v) => (v === 'B' ? OMIT : v),
    )
    expect(out.commanders).toEqual(['A', 'C'])
  })

  it('omits a redacted field so renderers fall back rather than throw', async () => {
    // `(injury.bodyParts || []).map(...)` is the shape all over this codebase.
    // A null would throw; an envelope string would print base64.
    const out = await mapSealed('injuries', { bodyParts: ['Left hand'] }, async () => OMIT)
    expect(out.bodyParts).toBe(undefined)
    expect((out.bodyParts || []).map((x) => x)).toEqual([])
  })
})
