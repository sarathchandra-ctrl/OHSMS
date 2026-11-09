# Mobile app

The phone app is this repository. There is no second codebase. A browser can
install the hosted site, and the iOS project wraps the same
`npm run build` output.

Nothing in the native project is a secret. Provisioning
profiles and App Check debug tokens stay off git. `.gitignore` refuses the
usual filenames; it cannot refuse one that was renamed.

## Two ways it runs

**Installed site (PWA).** Chrome and Safari offer "Add to Home Screen" once
hosting is serving `manifest.webmanifest`. The installed icon opens `/field`.
A device that has chosen the desktop portal is sent on to `/portal`;
otherwise this is the phone home. That home is two labelled groups: Technical
(the field registers) and Admin (settings, employees, maintenance, the audit log).
Admin is omitted when this role cannot open any of those. The service
worker caches the app shell — HTML, the hashed
scripts and styles, the icons — so a page that has loaded once can paint in a
dead spot. It does not cache Firebase Auth, Firestore, Storage or App Check.
Those requests leave this origin, and the worker's decision function
(`shellCacheDecision` in `src/shared/mobile/shellCache.js`) passes them
through. Firebase's own offline cache stays off unless `VITE_OFFLINE_CACHE`
is set, which this change does not set.

The worker is registered in a production **browser** only. It is not
registered inside the Capacitor shell. The shell's origin is
`https://localhost` and does not change when the store ships a new binary, so
a worker there would keep serving the previous shell after an update. The
hosted worker is `/sw.js`, at the root because a worker's scope is the
directory it is served from — a file under `/assets/` would not control the
app. Hosting's year-long cache on `*.js` does not apply to it: `firebase.json`
sets `/sw.js` to `no-cache`, after that rule, so a deploy can replace the
worker. The HTML that registers it is also `no-cache`.

**Store apps.** `capacitor.config.json` sets `appId` to `org.weehs.ohsms`,
`appName` to `WEEHS OHSMS`, and `webDir` to `dist`. iOS stays on
`capacitor://localhost`. Capacitor will not serve the iOS shell over `https`;
setting `iosScheme` to `https` is rejected by the tool.

`server.url` is absent on purpose. That key points the WebView at a live
host for reload-while-developing. A store build that used it would ship an
empty shell that only works when that host is up, and would skip the review
binary entirely. Do not add it for a release.

## What a hosting deploy has to include

The phone site does not exist until hosting serves this build. The files that
matter, beyond the usual `dist/`:

- `manifest.webmanifest` and `public/icons/` (copied into `dist` by Vite).
- `/sw.js`, the shell worker built from `src/shared/mobile/sw.js`.
- The `firebase.json` header changes in this change:
  - `Permissions-Policy` is `camera=(self)`. It was `camera=()`, which
    forbids `getUserMedia` for every origin including our own, so the PWA
    scanner could not open a camera no matter what the page asked for.
    Microphone stays off.
  - `/manifest.webmanifest` is served as `application/manifest+json` and is
    not given the year-long immutable cache. A stale manifest is how an
    installed icon keeps the old start URL.
  - `/sw.js` is `no-cache`. It is a `.js` file, so without this later rule
    the immutable `*.js` header would pin the worker for a year and a
    deploy would not replace the shell.
- `public/badges/` and `public/store.json`. The login page shows the
  official App Store badge only when those URLs are set.
  `store.json` is `no-cache`, and the shell worker does not cache it.

Deploy hosting from a checkout of this commit after `npm run build`, and
deploy the Firestore rules in the same release. The rules gained
`organizations/{orgId}/alertReads/{uid}` — the phone's per-user "already
opened" cursor. Without that deploy, marking an alert read is refused and
every row stays unread. Functions are unchanged. Until hosting lands,
suite.weehs.org is still the previous site: no manifest, no scanner, and
the camera policy still blocks the page.

The boot splash is in `index.html`, so the same hosting deploy is what a
phone browser and an installed PWA show on start. The Capacitor splash is
not part of hosting. It ships inside the store binary (`@capacitor/splash-screen`,
`launchAutoHide: false`, background `#f6e3bb`, the existing `splash` drawable).
A binary built before this commit still shows the old launch screen and
never calls `SplashScreen.hide()`.

## Splash

A phone (under 768px) and the native shells paint a cream screen and the
mark before the bundle. The mark scales in once. `prefers-reduced-motion`
drops that scale. A desktop browser does not see it: the splash is
`display: none` from the first style block, and the bundle removes the node.

The native splash stays up until the page calls `SplashScreen.hide()` with
a short fade. It uses the same cream, so the fade reveals the HTML splash
rather than a white WebView, and the HTML splash then fades into the app.
`launchAutoHide` is false on purpose. The plugin's own timer hides on a
clock, which is how the native screen disappears before the HTML has
painted and the handoff flashes white. The cost is the one named above: if
the bundle never runs, the native splash has nothing to dismiss it. The
HTML splash removes itself after eight seconds so a failed script is not a
permanent cream screen. A stored desktop choice hides the splash on a phone
the same way a wide browser does (`html.desktop-view`).

## View mode

The phone home and the desktop portal are two modes. The first visit picks
one and stores nothing: the native app is the phone home; a viewport of
1024px or wider is the desktop portal, including a large tablet; a phone
user agent, a coarse pointer under that width, or a window under 768px is
the phone home. A laptop window between 768 and 1023 stays the desktop
portal, which is what that width already was.

Both homes show a switch, "Switch to desktop view" or "Switch to mobile
view". The choice is stored on this device (`ohsms.viewMode` in
localStorage), so the phone and the office PC can differ. "Use automatic"
clears it and the next paint follows the device again. Desktop view on a
phone is the existing portal, scrolled, without the field bar. Mobile view
on a desktop is the phone home, centred, with the field bar centred under it.

## Alerts

The Alerts tab reads collections the product already has: defect reports,
incidents, committee meetings and mock drills, scoped to the sites the
signed-in person can see. Weather is not one of those collections. The
digest is a mail, and the screen reads current conditions the same way the
weather page does. A weather row is a site at Medium or worse, and its id
includes the digest's six-hour slot, so the next window is unread again.

Web push (FCM) is not part of this. Nothing buzzes when the app is closed.
The badge is the unread count while it is open. It pulses. The home icons
keep a small loop after they arrive — a float, a sway, a pulse or a fade,
each on its own beat. The desktop module logos play their own motion the
whole time, shifted so a row is not in step, instead of waiting for a
hover. The entrance, the press, those loops and the badge all stop when
the OS asks for reduced motion. The loops are transform and opacity only.

## Signing in, inside the WebView

Email and password (`signInWithEmailAndPassword`) does not consult the
authorised-domain list. It works in the iOS shell with no
console change.

The browser keeps using session persistence, so a shared workstation signs
out when the window closes. The native shells use local persistence. The
failure that motivated that split: opening the camera or locking the phone
tears the WebView down, session persistence treats that as the window
closing, and the person standing at a cylinder is back on the login screen.
`IdleGuard` still ends a session that sits unused.

**iOS.** The origin is `capacitor://localhost`. Authorised domains are web
origins Firebase can put on an `https` allow-list, and this one cannot be
added. A redirect would leave the person on a page the WebView cannot come
back from. The app does not attempt it: when the popup is blocked it throws
`auth/native-sso-unsupported` and the login screen says to use email and
password. That is a platform limit, not a missing toggle.

Password reset keeps using the hosted auth handler. It does not depend on
the WebView's origin.

## App Check

reCAPTCHA v3 tokens are minted for hostnames listed on the site key. The
day the site moved to suite.weehs.org, tokens failed until that host was
added; `https://localhost` and `capacitor://localhost` fail the same way
until they are listed, and the `capacitor://` origin cannot be listed.
Enforcement is off (see the comment in `src/shared/firebase.js`). Leave it
off until you have decided what a native shell should present. Turning it
on first locks the store apps out of Firestore while the website keeps
working, which is a hard outage to diagnose from a field report.

Do not put `VITE_APPCHECK_DEBUG_TOKEN` in a store build. A debug token in
the binary is an attestation bypass for anyone who unpacks the app. A debug
token for a single developer machine belongs in that machine's untracked
env file.

## Scanning a label

Equipment labels encode `<origin>/qr/<token>`. The origin on a sticker
already in the field is either `https://suite.weehs.org` or
`https://weehs-4eb28.web.app`. Permits encode `/permit/<token>`, isolation
procedures `/p/<id>`, tags `/t/<id>/<point>`. `parseQrPayload` /
`routeForScan` (`src/shared/mobile/qrPayload.js`) accept those paths and
nothing else. A code from another system, a `javascript:` URL, or a path
that climbs out of the route is not followed — the scan screen says the
code was not opened. The route it does produce is always an in-app path.
A scan cannot become a navigation to someone else's host.

The signed-in page is `/field/asset/<token>`. It reads the world-readable
`qr/{token}` mirror and then offers only what `can()` already allows on
the registers: inspect and raise for a member, close for a manager, nothing
for an auditor. A mirror whose `orgId` is another organisation, or is
missing, gets an explanation and no write button. The mirror being readable
is not permission to write the asset.

On iOS the camera is `@capacitor-mlkit/barcode-scanning`
(`BarcodeScanner.scan`, QR only), using ML Kit through CocoaPods.
The plugin does not support Swift Package Manager — do not switch the iOS
project to SPM or the scanner pod will not link.

In the browser and the installed PWA the same screen uses `BarcodeDetector`
where the browser has it, and `html5-qrcode` where it does not. Both need
the camera permission and the `camera=(self)` header above.

The native projects carry the platform strings that make those cameras
legal to open:

- `ios/App/App/Info.plist` — `NSCameraUsageDescription`.
- `ios/App/Podfile` — `platform :ios, '15.5'`, which is ML Kit's floor.

## Installing on a phone

Android uses the website or installed PWA. There is no Android native project,
APK build workflow, sideload download, or Google Play listing in this repository.
In Chrome, open the website and use the browser's Install app or Add to Home Screen option.

On iPhone, the sign-in page's **Install on iPhone** button explains Safari's
Share → Add to Home Screen flow. The optional App Store and TestFlight links
appear only when `VITE_APP_STORE_URL` and `VITE_TESTFLIGHT_URL` (or their keys
in `public/store.json`) name valid Apple listings. These links are hidden
inside the native iOS shell.

## Building iOS

The iOS project in this repository was generated without CocoaPods. Pods
are not committed. The archive has to be made on a Mac.

```bash
npm ci
npm run mobile:sync
cd ios/App && pod install && cd ../..
npm run mobile:ios      # opens Xcode
```

`pod install` is required after every `cap sync` that changes plugins. The
workspace to open is `ios/App/App.xcworkspace`, which `pod install` creates.
Opening the `.xcodeproj` instead builds without ML Kit and the scanner does
not link.

Needs Xcode (current stable), CocoaPods, and an Apple Developer Program
membership (an annual fee; Apple publishes the current amount). The bundle
id is `org.weehs.ohsms`.

**Signing.** Xcode → the App target → Signing & Capabilities. Pick the
team. Automatic signing is enough for a device and for TestFlight.
Distribution uses an Apple Distribution certificate and a provisioning
profile; Xcode creates both when the account has the Admin or
App Manager role and automatic signing is on. Do not export a `.p12` into
this repository.

**Archive.** Product → Archive, then Distribute App → App Store Connect.
TestFlight is the first place a build should go. App Store review is a
later promotion of a build you have already installed on a phone.

The version and build numbers are the target's Marketing Version and
Current Project Version in Xcode. The build number has to increase for
every upload.

The minimum deployment target is iOS 15.5. Do not lower it to match an
older device: the ML Kit pod will not build.

## Accounts and machines this repository cannot supply

| Need                                           | Who creates it                          | Used for                       |
| ---------------------------------------------- | --------------------------------------- | ------------------------------ |
| Apple Developer Program membership             | The organisation                        | Signing, TestFlight, App Store |
| A Mac with Xcode and CocoaPods                 | Whoever runs the iOS build              | `pod install` and the archive  |

The website and installed PWA do not require a store account. Native iOS
builds still require the Apple tools and account listed above.
