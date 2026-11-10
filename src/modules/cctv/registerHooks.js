// ─────────────────────────────────────────────────────────────────────────────
// Wire CCTV into site creation.
//
// Imported from App.jsx rather than from the module's own index, because the
// module is lazy-loaded: registering inside it would mean a site added by
// someone who never opens the CCTV tab silently gets no Meraki, which is the
// exact gap this is meant to close.
//
// The cost of importing it eagerly is this file plus provision.js and the
// module's firestore helpers — no React pages, and the Firebase SDK is already
// in the main bundle.
// ─────────────────────────────────────────────────────────────────────────────

import { onSiteCreated } from '../../shared/org/siteHooks'
import { provisionMerakisForNewSites } from './lib/data'

onSiteCreated('cctv', async (sites, actor) => {
  await provisionMerakisForNewSites(sites, actor)
})
