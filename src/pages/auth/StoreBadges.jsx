import { useEffect, useId, useState } from 'react'
import { isNativePlatform } from '../../shared/mobile/native'
import {
  DEFAULT_APK_URL,
  DEFAULT_APK_VERSION,
  loadApkRelease,
  loadPublicStoreConfig,
  resolveStoreLinks,
} from '../../shared/mobile/storeLinks'

// Official artwork, unmodified, and only once that store has a listing.
// Google's PNG already includes its clear space and is shown at 60px tall.
// Apple's black "Download on the App Store" lockup is the 40px-tall US-UK
// badge. The gap between them is at least a quarter of that 40px.
//
// Until those listings exist the marks are not drawn. A "Coming soon" badge
// is a link that goes nowhere, which is what this row used to be. Android
// downloads the APK this site hosts. An iPhone cannot install an app file
// from the browser, so that button opens the Home Screen steps instead.

const BADGES = [
  {
    key: 'play',
    src: '/badges/google-play-badge.png',
    alt: 'Get it on Google Play',
    width: 155,
    height: 60,
    className: 'h-[60px] w-auto',
  },
  {
    key: 'appStore',
    src: '/badges/app-store-badge.svg',
    alt: 'Download on the App Store',
    width: 120,
    height: 40,
    className: 'h-10 w-auto',
  },
]

export default function StoreBadges({
  native,
  links,
  release,
  load = loadPublicStoreConfig,
  loadRelease = loadApkRelease,
}) {
  const hidden = native ?? isNativePlatform()
  const titleId = useId()
  const [guide, setGuide] = useState(false)
  const [resolved, setResolved] = useState(() =>
    links ? resolveStoreLinks({ env: envFrom(links) }) : resolveStoreLinks({ env: import.meta.env })
  )
  const [apk, setApk] = useState(
    () => release || { version: DEFAULT_APK_VERSION, url: DEFAULT_APK_URL }
  )

  useEffect(() => {
    if (hidden || links) return undefined
    const fromEnv = resolveStoreLinks({ env: import.meta.env })
    if (fromEnv.play && fromEnv.appStore && fromEnv.testFlight) return undefined
    let cancel = false
    load().then((config) => {
      if (!cancel) setResolved(resolveStoreLinks({ env: import.meta.env, config }))
    })
    return () => {
      cancel = true
    }
  }, [hidden, links, load])

  useEffect(() => {
    if (hidden || release) return undefined
    let cancel = false
    loadRelease().then((next) => {
      if (!cancel) setApk(next)
    })
    return () => {
      cancel = true
    }
  }, [hidden, release, loadRelease])

  useEffect(() => {
    if (!guide) return undefined
    const onKey = (e) => {
      if (e.key === 'Escape') setGuide(false)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [guide])

  if (hidden) return null

  const storeBadges = BADGES.filter((badge) => resolved[badge.key])

  return (
    <div className="mt-4">
      <div className="space-y-2">
        <a href={apk.url} className="btn btn-primary w-full" aria-describedby="apk-install-note">
          Download APK
        </a>
        <p id="apk-install-note" className="text-center text-[11px] leading-snug text-ink-600">
          Version {apk.version}. After it downloads, open the file. Android asks you to allow this
          browser to install unknown apps.
        </p>
        <button
          type="button"
          className="btn btn-ghost w-full"
          aria-haspopup="dialog"
          aria-expanded={guide}
          onClick={() => setGuide(true)}
        >
          Install on iPhone
        </button>
        {resolved.testFlight && (
          <a
            href={resolved.testFlight}
            target="_blank"
            rel="noopener noreferrer"
            className="block text-center text-[13px] font-semibold text-brand-700 underline-offset-2 hover:underline"
          >
            Join the TestFlight
            <span className="sr-only"> (opens in a new tab)</span>
          </a>
        )}
      </div>

      {storeBadges.length > 0 && (
        <ul
          className="mt-4 flex flex-wrap items-center justify-center gap-x-4 gap-y-3"
          aria-label="Store listings"
        >
          {storeBadges.map((badge) => (
            <li key={badge.key} className="flex justify-center">
              <a
                href={resolved[badge.key]}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex rounded-md focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-brand-400 focus-visible:ring-offset-2"
              >
                <img
                  src={badge.src}
                  alt={badge.alt}
                  width={badge.width}
                  height={badge.height}
                  draggable="false"
                  className={badge.className}
                />
                <span className="sr-only"> (opens in a new tab)</span>
              </a>
            </li>
          ))}
        </ul>
      )}

      {guide && (
        <div className="fixed inset-0 z-[70] grid place-items-center bg-ink-900/40 px-4">
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            className="w-full max-w-sm rounded-3xl bg-white p-5 text-left shadow-elev-lg"
          >
            <h2 id={titleId} className="text-base font-bold text-ink-900">
              Install on iPhone
            </h2>
            <p className="mt-2 text-sm leading-snug text-ink-700">
              An iPhone cannot install an app file from the browser. Add this site to the Home
              Screen. It opens full screen.
            </p>
            <ol className="mt-3 list-decimal space-y-1.5 pl-5 text-sm text-ink-800">
              <li>Open this page in Safari.</li>
              <li>Tap the Share button.</li>
              <li>Tap Add to Home Screen, then Add.</li>
              <li>Open Cult Fit SMS from the Home Screen.</li>
            </ol>
            {resolved.testFlight && (
              <p className="mt-3 text-sm text-ink-700">
                A TestFlight build is separate.{' '}
                <a
                  href={resolved.testFlight}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="font-semibold text-brand-700 underline-offset-2 hover:underline"
                >
                  Join the TestFlight
                  <span className="sr-only"> (opens in a new tab)</span>
                </a>
                .
              </p>
            )}
            <button
              type="button"
              className="btn btn-primary mt-4 w-full"
              onClick={() => setGuide(false)}
            >
              Close
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

function envFrom(links) {
  return {
    VITE_PLAY_STORE_URL: links.play || '',
    VITE_APP_STORE_URL: links.appStore || '',
    VITE_TESTFLIGHT_URL: links.testFlight || '',
  }
}
