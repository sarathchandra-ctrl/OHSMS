// ─────────────────────────────────────────────────────────────────────────────
// An <img> for a stored file pointer, resolved by path.
//
// `useFileUrl` is the hook; this is the shape most call sites actually need,
// because they render inside a `.map()` — an inspection's findings, a LOTO
// procedure's isolation points — and a hook cannot be called in a loop. One
// component per row is how a list of pointers becomes a list of images without
// breaking the rules of hooks.
//
// Why any of this exists: uploads no longer mint a Firebase download URL (audit
// finding M-5, A.8.3 / A.5.14). That string was a permanent bearer credential
// filed in a Firestore document readable by every member of the tenant and by
// the external auditor, and it kept working after they left. The bytes now come
// through a fresh, expiring link issued to the signed-in person.
// ─────────────────────────────────────────────────────────────────────────────
import { safeSrc } from '../safeUrl'
import { useFileUrl } from './useFileUrl'

/**
 * @param pointer  `{ url, path }`, or a bare path/data: URL string
 * @param fallback rendered when there is nothing to show — pass a node, or
 *                 leave it out for nothing at all
 *
 * `restricted` is rendered distinctly from empty on purpose. A sealed file this
 * reader holds no key for is not a missing file, and showing a blank frame for
 * both is how an unreadable medical record and a deleted one came to look
 * identical.
 */
export function StoredImage({ pointer, collection, fallback = null, alt = '', ...imgProps }) {
  const { src, loading, restricted } = useFileUrl(pointer, { collection })

  if (restricted) {
    return (
      <span
        className="grid h-full w-full place-items-center rounded-xl bg-surface text-[10px] font-semibold text-ink-400"
        title="You do not have the key for this file"
      >
        Restricted
      </span>
    )
  }
  // Nothing yet and nothing to wait for.
  if (!src && !loading) return fallback
  // Mid-fetch: render the element with no src rather than swapping the layout,
  // so a gallery does not reflow as each image lands.
  return <img src={safeSrc(src) || undefined} alt={alt} {...imgProps} />
}

export default StoredImage
