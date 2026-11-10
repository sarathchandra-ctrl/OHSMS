// ─────────────────────────────────────────────────────────────────────────────
// A rejected permit, answered and sent back. Pure, so it is unit-testable.
//
// When Engineering or Operations rejects a permit's opening or its closure,
// the person who raised the permit answers the rejection with a counter
// comment and sends it back. The re-approval then goes to the one person who
// rejected it, not to every approver for that team. The server holds the
// same rule (stack/policy.mjs permitDecisionProblem); this is what the app
// writes and how it reads a block.
// ─────────────────────────────────────────────────────────────────────────────

/** The two stages a rejection can be answered on. Extensions are not part of it. */
export const ANSWERABLE_STAGES = ['permit', 'closure']

/** Keep in step with PERMIT_ANSWER_MAX in stack/policy.mjs. */
export const ANSWER_MAX = 2000

/** The decision block for a stage and team: the permit's own, or its closure's. */
export function stageBlock(permit, stage, team) {
  if (stage === 'permit') return permit?.[team] || null
  if (stage === 'closure') return permit?.closure?.[team] || null
  return null
}

/** Pending re-approval, pinned to one person: their uid, else ''. */
export function pinnedTo(block) {
  return block?.status === 'pending' && block.reapprover ? String(block.reapprover) : ''
}

/**
 * May this person answer this rejection? The raiser of the permit, or the
 * platform Administrator for a permit whose raiser has left; never the
 * person who rejected it. The server holds the same rule.
 */
export function canAnswer(profile, permit, block, { admin = false } = {}) {
  if (block?.status !== 'rejected' || !block.by || !profile?.uid) return false
  if (profile.uid === block.by) return false
  return admin || permit?.createdBy === profile.uid
}

/**
 * The block that answers a rejection: back to pending, pinned to the person
 * who rejected, carrying the rejection exactly as recorded and the answer.
 * Throws on an empty answer: sending it back with nothing to say is the
 * "whole department" re-submission this replaces.
 */
export function answerBlock(rejected, text, actor, at = new Date().toISOString()) {
  const answer = String(text || '').trim()
  if (!answer) throw new Error('Write an answer to the rejection before sending it back')
  if (answer.length > ANSWER_MAX) throw new Error(`The answer can be at most ${ANSWER_MAX} characters`)
  if (rejected?.status !== 'rejected' || !rejected.by) throw new Error('This decision is not a rejection')
  return {
    status: 'pending',
    by: null,
    byName: '',
    at: null,
    note: '',
    reapprover: rejected.by,
    reapproverName: rejected.byName || '',
    rejection: {
      by: rejected.by,
      byName: rejected.byName || '',
      at: rejected.at || null,
      note: rejected.note || '',
    },
    response: { by: actor?.uid || null, byName: actor?.name || '', at, text: answer },
  }
}
