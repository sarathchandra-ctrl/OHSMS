import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Camera, QrCode } from 'lucide-react'
import QrPreview from '../../shared/mobile/QrPreview'
import { parseQrPayload, routeForScan } from '../../shared/mobile/qrPayload'
import { isNativePlatform } from '../../shared/mobile/native'
import {
  cameraErrorMessage,
  cameraUnavailableReason,
  openScanner,
} from '../../shared/mobile/webScan'

const UNKNOWN =
  'This QR code is not a Cult Fit SMS label. Nothing was opened. Equipment labels start with /qr/, permits with /permit/.'

const STARTING = 'Starting the camera…'
const SCANNING = 'Scanning. Point the camera at the code.'

export default function Scan() {
  const navigate = useNavigate()
  const videoRef = useRef(null)
  const acceptRef = useRef(() => {})
  const handled = useRef(false)
  const [error, setError] = useState('')
  const [status, setStatus] = useState('')
  const [live, setLive] = useState(false)
  const [pasted, setPasted] = useState('')
  // 0 is off. Each Start increments it so a second tap restarts the stream
  // after the previous effect has released the camera.
  const [session, setSession] = useState(0)

  const stop = useCallback(() => {
    setLive(false)
    setStatus('')
    setSession(0)
  }, [])

  const accept = useCallback(
    (raw) => {
      if (handled.current) return
      const to = routeForScan(parseQrPayload(raw))
      if (!to) {
        setError(UNKNOWN)
        setStatus(SCANNING)
        return
      }
      handled.current = true
      stop()
      navigate(to)
    },
    [navigate, stop]
  )

  useEffect(() => {
    acceptRef.current = accept
  })

  useEffect(() => {
    if (!session) return undefined
    const ac = new AbortController()
    let halt = () => {}
    const mine = session
    ;(async () => {
      try {
        const stopScan = await openScanner({
          video: videoRef.current,
          elementId: 'field-qr-reader',
          onCode: (raw) => acceptRef.current(raw),
          signal: ac.signal,
        })
        if (ac.signal.aborted) {
          await stopScan()
          return
        }
        halt = stopScan
        setLive(true)
        setStatus(SCANNING)
      } catch (err) {
        if (ac.signal.aborted || err?.name === 'AbortError') return
        setError(cameraErrorMessage(err))
        setStatus('')
        setLive(false)
        setSession((current) => (current === mine ? 0 : current))
      }
    })()
    return () => {
      ac.abort()
      setLive(false)
      try {
        const result = halt()
        if (result && typeof result.then === 'function') result.catch(() => {})
      } catch {
        // The camera is already gone. The page still has to be usable.
      }
    }
  }, [session])

  const start = () => {
    setError('')
    handled.current = false
    if (isNativePlatform()) {
      setStatus(STARTING)
      ;(async () => {
        try {
          const { scanWithNativeCamera } = await import('../../shared/mobile/nativeScan')
          const raw = await scanWithNativeCamera({ onStatus: setStatus })
          setStatus('')
          if (!raw) return
          accept(raw)
        } catch (err) {
          setStatus('')
          setError(err?.message || 'The camera scanner could not start. Paste the code instead.')
        }
      })()
      return
    }
    const blocked = cameraUnavailableReason()
    if (blocked) {
      setStatus('')
      setError(blocked)
      return
    }
    // Paint the preview first. openScanner runs in the effect above, after
    // this commit, when the video or the html5-qrcode box has a width.
    setStatus(STARTING)
    setSession((n) => n + 1)
  }

  const submitPasted = (event) => {
    event.preventDefault()
    setError('')
    accept(pasted)
  }

  return (
    <div className="mx-auto max-w-md">
      <h1 className="text-[22px] font-extrabold tracking-[-0.02em] text-ink-900">Scan QR</h1>
      <p className="mt-1 text-sm text-ink-500">
        Point the camera at an extinguisher, AED or fire-alarm label. A code from somewhere else is
        left alone.
      </p>

      <QrPreview
        active={session > 0}
        videoRef={videoRef}
        readerId="field-qr-reader"
        status={session > 0 ? status : ''}
        className="mt-4 rounded-3xl"
        idle={
          <div className="absolute inset-0 grid place-items-center text-white/80">
            <QrCode size={48} aria-hidden="true" />
          </div>
        }
      />

      <div className="mt-4 flex flex-col gap-2">
        <button
          type="button"
          className="btn-primary min-h-12 w-full"
          onClick={start}
          disabled={session > 0 && !live}
        >
          <Camera size={18} aria-hidden="true" /> {live ? 'Scan again' : 'Start camera'}
        </button>
        {session > 0 && (
          <button type="button" className="btn-ghost min-h-12 w-full" onClick={stop}>
            Stop camera
          </button>
        )}
      </div>

      {status && session === 0 && (
        <p role="status" className="mt-3 text-sm font-medium text-ink-700">
          {status}
        </p>
      )}
      {error && (
        <p role="alert" className="mt-3 rounded-2xl bg-amber-50 px-3 py-3 text-sm text-amber-950">
          {error}
        </p>
      )}

      <form onSubmit={submitPasted} className="mt-6">
        <label htmlFor="pasted-code" className="label">
          Or paste the code
        </label>
        <input
          id="pasted-code"
          className="input"
          value={pasted}
          onChange={(event) => setPasted(event.target.value)}
          placeholder="https://…/qr/…"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck="false"
        />
        <button type="submit" className="btn-ghost mt-2 min-h-12 w-full">
          Open code
        </button>
      </form>
    </div>
  )
}
