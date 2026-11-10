import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath, URL } from 'node:url'

// /privacy and /terms are static documents in public/. Hosting rewrites those
// paths to the files (firebase.json) so a crawler gets the text without
// running the app. The dev and preview servers do the same rewrite, or a
// click from the sign-in page falls through to the signed-in shell.
function legalPages() {
  const pages = new Map([
    ['/privacy', '/privacy.html'],
    ['/privacy/', '/privacy.html'],
    ['/terms', '/terms.html'],
    ['/terms/', '/terms.html'],
  ])
  const rewrite = (req, _res, next) => {
    const path = String(req.url || '').split('?')[0]
    const target = pages.get(path)
    if (target) {
      const query = String(req.url || '').includes('?') ? `?${req.url.split('?')[1]}` : ''
      req.url = `${target}${query}`
    }
    next()
  }
  return {
    name: 'legal-pages',
    configureServer(server) {
      server.middlewares.use(rewrite)
    },
    configurePreviewServer(server) {
      server.middlewares.use(rewrite)
    },
  }
}

// https://vitejs.dev/config/
export default defineConfig({
  // The app is served from the root of its own address (the Cloudflare Worker).
  base: '/',
  plugins: [react(), legalPages()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    port: 5173,
    host: true,
  },
  build: {
    // Heavy libs (three.js, react-flow, xlsx, pdf) are lazy-loaded per module
    // route. Split the always-loaded vendors so the initial bundle stays lean.
    chunkSizeWarningLimit: 900,
    // Fonts are always emitted as files, never inlined. @fontsource ships
    // subsets (open-sans greek-ext) under the 4 KB inline limit, which Vite
    // turned into data:font/woff2 URIs inside the CSS, and the CSP's
    // `font-src 'self' https://fonts.gstatic.com` blocked every one of them
    // on the portal. Widening font-src to data: would fix the symptom by
    // weakening the policy; emitting the file keeps the policy as written.
    // `undefined` defers to the default limit for everything else.
    assetsInlineLimit: (filePath) =>
      /\.(?:woff2?|ttf|otf|eot)$/i.test(filePath) ? false : undefined,
    // Vite 8 builds with Rolldown, which accepts manualChunks only as a
    // function. Same split as the object form: the always-loaded vendors
    // leave the entry chunk.
    //
    // A service worker's scope is the directory it is served from. A hashed
    // file under /assets/ would only control /assets/, and
    // `new URL('./sw.js', import.meta.url)` is inlined as a data: URL (the
    // source is under the asset inline limit), which the CSP refuses and
    // which still contains an unresolved import. The root file is no-cache
    // in firebase.json so a deploy can replace it; the year-long immutable
    // rule on **/*.js would otherwise pin it.
    rolldownOptions: {
      input: {
        index: fileURLToPath(new URL('./index.html', import.meta.url)),
        sw: fileURLToPath(new URL('./src/shared/mobile/sw.js', import.meta.url)),
      },
      output: {
        entryFileNames: (chunk) => (chunk.name === 'sw' ? 'sw.js' : 'assets/[name]-[hash].js'),
        manualChunks(id) {
          const pkg = (name) => id.includes(`/node_modules/${name}/`)
          if (pkg('react') || pkg('react-dom') || pkg('react-router') || pkg('react-router-dom')) {
            return 'react'
          }
          if (
            pkg('firebase/app') ||
            pkg('firebase/auth') ||
            pkg('firebase/firestore') ||
            pkg('@firebase/app') ||
            pkg('@firebase/auth') ||
            pkg('@firebase/firestore')
          ) {
            return 'firebase'
          }
          if (pkg('recharts')) return 'charts'
          if (pkg('framer-motion')) return 'motion'
        },
      },
    },
  },
})
