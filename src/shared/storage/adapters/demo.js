// Files for the GitHub Pages demo (VITE_STORAGE_DRIVER=demo): kept in this
// tab's memory and shown through blob: URLs. Gone when the tab closes, like
// the rest of the demo's data. Never a store for real files.
const files = new Map()

export default {
  async put(path, blob) {
    files.set(path, blob)
    return { url: '' }
  },
  async remove(path) {
    files.delete(path)
  },
  async resolve(path) {
    const blob = files.get(path)
    return blob ? URL.createObjectURL(blob) : null
  },
  async resolveBlob(path) {
    return files.get(path) || null
  },
}
