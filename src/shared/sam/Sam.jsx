import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { motion, AnimatePresence, useReducedMotion } from 'framer-motion'
import { Send, X } from 'lucide-react'
import { useAuth } from '../auth/AuthContext'
import { useDeferredMount } from '../lib/useDeferredMount'
import { answer, isoMap } from './brain'
import { getStats } from './liveStats'
import SamCharacter3D from './SamCharacter3D'

// Sam is a modelled character now rather than a flat badge — at 76px the vest
// tape, the badge and the clipboard were all sub-pixel. Every position on
// screen derives from this, so the ground line and the drag bounds follow.
const AVATAR = 124
const MARGIN = 16

// Sam walks; he does not fly. Travel is along a single ground line at a constant
// pace, because those two things together are what make motion read as walking:
// a character that changes height mid-journey, or that eases in and out like a
// spring, reads as floating no matter how well the legs are animated.
const GROUND_GAP = 76           // clear of the bottom edge and the "Sam" badge
const FIELD_NAV = 72            // the phone bar he would otherwise walk through
const SPEED = 90                // px per second — an unhurried stroll
const MIN_STROLL = 160          // don't bother shuffling a few pixels

const groundGap = () => {
  const narrow = typeof window.matchMedia === 'function' && window.matchMedia('(max-width: 767px)').matches
  return GROUND_GAP + (narrow ? FIELD_NAV : 0)
}
const groundY = () => Math.max(MARGIN, window.innerHeight - AVATAR - groundGap())
const maxX = () => Math.max(MARGIN, window.innerWidth - AVATAR - MARGIN)

/**
 * Where Sam walks next: somewhere along the ground, far enough from where he is
 * to be worth the trip. Direction is chosen from whichever side has room, so he
 * paces the width of the screen instead of fidgeting in one corner.
 */
function nextStop(fromX) {
  const min = MARGIN
  const max = maxX()
  if (max - min < MIN_STROLL) return min
  const reach = Math.min(max - min, MIN_STROLL)
  const roomLeft = fromX - reach - min
  const roomRight = max - (fromX + reach)
  const goRight = roomRight > 0 && (roomLeft <= 0 || Math.random() < 0.5)
  if (goRight) return fromX + reach + Math.random() * roomRight
  if (roomLeft > 0) return min + Math.random() * roomLeft
  return fromX > (min + max) / 2 ? min : max
}

/** Render **bold** spans + newlines in Sam's text parts. */
function SamText({ text }) {
  const chunks = text.split('**')
  return (
    <p className="whitespace-pre-line text-sm leading-relaxed text-ink-800">
      {chunks.map((c, i) => (i % 2 ? <b key={i}>{c}</b> : <span key={i}>{c}</span>))}
    </p>
  )
}

function SamParts({ parts }) {
  return (
    <div className="space-y-2">
      {parts.map((p, i) => {
        if (p.type === 'text') return <SamText key={i} text={p.text} />
        if (p.type === 'modules')
          return (
            <div key={i}>
              <p className="mb-1 text-xs font-semibold text-ink-500">{p.label}</p>
              <div className="flex flex-wrap gap-1.5">
                {p.modules.map((m) => (
                  <Link key={m.path + m.label} to={m.path} className="chip bg-brand-50 text-brand-700 hover:bg-brand-100">
                    {m.label}
                  </Link>
                ))}
              </div>
            </div>
          )
        if (p.type === 'map')
          return (
            <div key={i} className="max-h-64 overflow-y-auto rounded-xl bg-surface-100/70 p-2">
              <table className="w-full text-xs">
                <tbody>
                  {isoMap().map((row) => (
                    <tr key={row.clause} className="border-b border-surface-200/60 last:border-0">
                      <td className="whitespace-nowrap py-1 pr-2 font-bold text-brand-700">{row.clause}</td>
                      <td className="py-1 pr-2 text-ink-700">{row.title}</td>
                      <td className="py-1">
                        {row.modules.map((m) => (
                          <Link key={m.path + m.label} to={m.path} className="mr-1 text-brand-600 hover:underline">
                            {m.label.split(' (')[0]}
                          </Link>
                        ))}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        return null
      })}
    </div>
  )
}

const SUGGESTIONS = ['What is clause 5.4?', '8.2 emergency', 'How is our training compliance?', 'ISO map']

export default function Sam() {
  const { isApproved, profile } = useAuth()
  const reduce = useReducedMotion()
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState(() => ({ x: maxX(), y: groundY() }))
  const [messages, setMessages] = useState([
    {
      role: 'sam',
      parts: [{ type: 'text', text: 'Hi, I’m **Sam** — your ISO 45001 buddy! 🦺 Ask me about any clause, or how your Cult Fit SMS modules stack up against the standard.' }],
    },
  ])
  const [input, setInput] = useState('')
  const [thinking, setThinking] = useState(false)
  // Walk state drives the limb swing and which way Sam faces while strolling.
  const [walking, setWalking] = useState(false)
  const [facing, setFacing] = useState(1)
  // How long the current journey takes. Derived from distance so Sam covers
  // ground at one speed — a fixed duration would make him sprint across a wide
  // screen and crawl across a narrow one, at the same leg cadence either way.
  const [travel, setTravel] = useState(0)
  const dragging = useRef(false)
  const listRef = useRef(null)
  // Framer animates to `pos` on its own clock, so the last committed target is
  // the only reliable "where is Sam" — reading state here would lag a journey.
  const posRef = useRef(pos)
  const walkTimer = useRef(null)

  /** Walk to a spot, facing the way he is going, legs moving for exactly the trip. */
  const strollTo = useCallback((next) => {
    const from = posRef.current
    const distance = Math.hypot(next.x - from.x, next.y - from.y)
    if (distance < 4) return
    posRef.current = next
    if (next.x !== from.x) setFacing(next.x > from.x ? 1 : -1)
    const seconds = reduce ? 0 : Math.min(8, distance / SPEED)
    setTravel(seconds)
    setPos(next)
    if (reduce) return
    setWalking(true)
    clearTimeout(walkTimer.current)
    walkTimer.current = setTimeout(() => setWalking(false), seconds * 1000)
  }, [reduce])

  useEffect(() => () => clearTimeout(walkTimer.current), [])

  // Sam does not render in the same commit as the page he floats over: `drag`
  // below makes framer-motion measure scroll offsets the moment it attaches its
  // listeners, which forces the layout of the whole screen that was just built
  // (see useDeferredMount). Waiting for an idle moment costs the same
  // measurement against a settled layout, and a mascot arriving a beat after the
  // content is the right order anyway.
  const awake = useDeferredMount({ idle: true })

  // Idle wander: when the chat is closed, walk somewhere new every 25–45 s.
  useEffect(() => {
    if (open || reduce) return undefined
    let timer
    const schedule = () => {
      timer = setTimeout(() => {
        if (!dragging.current) strollTo({ x: nextStop(posRef.current.x), y: groundY() })
        schedule()
      }, 25_000 + Math.random() * 20_000)
    }
    schedule()
    return () => clearTimeout(timer)
  }, [open, reduce, strollTo])

  // Walk over to the panel when the chat opens. Sam stops to the left of it
  // rather than climbing up beside it, so he stays standing on the ground.
  useEffect(() => {
    if (!open) return
    const panel = Math.min(384, window.innerWidth - 2 * MARGIN)
    strollTo({ x: Math.max(MARGIN, window.innerWidth - panel - MARGIN - AVATAR - 12), y: groundY() })
  }, [open, strollTo])

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: 'smooth' })
  }, [messages, thinking, open])

  const ask = async (raw) => {
    const q = (raw ?? input).trim()
    if (!q) return
    setInput('')
    setMessages((m) => [...m, { role: 'user', parts: [{ type: 'text', text: q }] }])
    setThinking(true)
    let stats = {}
    try {
      stats = await getStats()
    } catch {
      /* stats are optional */
    }
    setMessages((m) => [...m, { role: 'sam', parts: answer(q, stats) }])
    setThinking(false)
  }

  const greeting = useMemo(
    () => (profile?.name ? `Sam · here to help, ${profile.name.split(' ')[0]}!` : 'Sam · ISO 45001 buddy'),
    [profile]
  )

  if (!isApproved || !awake) return null

  return (
    <div className="pointer-events-none fixed inset-0 z-40 print:hidden" aria-live="polite">
      {/* The buddy */}
      <motion.button
        type="button"
        aria-label="Sam — ISO 45001 assistant"
        className="pointer-events-auto absolute left-0 top-0 grid cursor-grab place-items-center rounded-2xl active:cursor-grabbing"
        style={{ width: AVATAR, height: AVATAR, touchAction: 'none' }}
        animate={{ x: pos.x, y: pos.y }}
        // A walk is constant-speed, so the tween is linear. A spring was what
        // made Sam look like he was drifting: it eases out and overshoots,
        // which is how something floating settles, not how someone walking stops.
        transition={reduce ? { duration: 0 } : { type: 'tween', ease: 'linear', duration: travel }}
        drag
        dragMomentum={false}
        onDragStart={() => { dragging.current = true }}
        onDragEnd={(e, info) => {
          dragging.current = false
          const dropped = {
            x: Math.min(Math.max(8, posRef.current.x + info.offset.x), window.innerWidth - AVATAR - 8),
            y: Math.min(Math.max(8, posRef.current.y + info.offset.y), window.innerHeight - AVATAR - 8),
          }
          // Land where dropped, instantly — the drag already moved him there, so
          // animating would drag him a second time. His next stroll walks him
          // back down to the ground line.
          posRef.current = dropped
          setTravel(0)
          setPos(dropped)
        }}
        onClick={() => { if (!dragging.current) setOpen((o) => !o) }}
        whileHover={{ scale: 1.08 }}
        whileTap={{ scale: 0.95 }}
      >
        {/* Soft ground shadow — anchors the character instead of leaving it floating */}
        <span
          aria-hidden="true"
          className="absolute bottom-1 left-1/2 h-1.5 -translate-x-1/2 rounded-[50%] bg-black/40 blur-[2px]"
          style={{ width: AVATAR * 0.42 }}
        />
        <SamCharacter3D
          size={AVATAR}
          walking={walking}
          facing={facing}
          talking={thinking || open}
          reduce={reduce}
        />
        <span className="absolute -bottom-1 rounded-full bg-brand-600 px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-white shadow-elev-sm">
          Sam
        </span>
      </motion.button>

      {/* Chat panel */}
      <AnimatePresence>
        {open && (
          <motion.div
            initial={reduce ? { opacity: 0 } : { opacity: 0, y: 16, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={reduce ? { opacity: 0 } : { opacity: 0, y: 12, scale: 0.97 }}
            transition={{ duration: 0.2, ease: [0.23, 1, 0.32, 1] }}
            className="card pointer-events-auto absolute bottom-24 right-4 flex h-[min(28rem,70vh)] w-[24rem] max-w-[calc(100vw-2rem)] flex-col overflow-hidden !rounded-2xl p-0 shadow-elev-lg md:bottom-4"
          >
            <div className="flex items-center justify-between border-b border-surface-200/70 bg-brand-600 px-4 py-3 text-white">
              <p className="text-sm font-bold">🦺 {greeting}</p>
              <button onClick={() => setOpen(false)} aria-label="Close Sam" className="rounded-lg p-1 hover:bg-white/15">
                <X size={16} />
              </button>
            </div>

            <div ref={listRef} className="flex-1 space-y-3 overflow-y-auto p-3">
              {messages.map((m, i) => (
                <div key={i} className={m.role === 'user' ? 'flex justify-end' : 'flex justify-start'}>
                  <div className={
                    m.role === 'user'
                      ? 'max-w-[85%] rounded-2xl rounded-br-md bg-brand-600 px-3 py-2 text-sm text-white'
                      : 'max-w-[92%] rounded-2xl rounded-bl-md bg-surface-100 px-3 py-2 shadow-elev-sm'
                  }>
                    {m.role === 'user' ? m.parts[0].text : <SamParts parts={m.parts} />}
                  </div>
                </div>
              ))}
              {thinking && (
                <div className="flex items-center gap-1 pl-2 text-ink-400">
                  {[0, 1, 2].map((i) => (
                    <motion.span key={i} className="h-1.5 w-1.5 rounded-full bg-ink-400"
                      animate={{ opacity: [0.3, 1, 0.3] }} transition={{ repeat: Infinity, duration: 0.9, delay: i * 0.15 }} />
                  ))}
                </div>
              )}
            </div>

            <div className="flex flex-wrap gap-1.5 px-3 pb-2">
              {SUGGESTIONS.map((s) => (
                <button key={s} onClick={() => ask(s)} className="chip bg-surface-100 text-ink-600 transition hover:bg-brand-50 hover:text-brand-700">
                  {s}
                </button>
              ))}
            </div>

            <form
              className="flex items-center gap-2 border-t border-surface-200/70 p-3"
              onSubmit={(e) => { e.preventDefault(); ask() }}
            >
              <input
                className="input !py-2 text-sm"
                placeholder="Ask about an ISO clause…"
                value={input}
                onChange={(e) => setInput(e.target.value)}
              />
              <button type="submit" className="btn-primary !px-3 !py-2" aria-label="Send">
                <Send size={16} />
              </button>
            </form>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
