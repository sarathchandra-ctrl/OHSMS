// The one-line summary under the home page's Region / Entity / Site pickers.
//
// It used to list every region, entity and site name inside the selection, so
// "All sites" spelled out each site the viewer can see. The owner asked for it
// to say what is selected instead: "All sites" when nothing is narrowed, the
// one picked name when something is. The pickers still list every option; this
// line only restates the choice.

/**
 * @param {object} o
 * @param {string} o.region    'all' or the picked region
 * @param {string} o.entity    'all' or the picked entity
 * @param {string} [o.siteName] the picked site's name; absent for all sites
 * @returns {Array<[string, string]>} [label, value] rows
 */
export function scopeSummary({ region, entity, siteName }) {
  return [
    ['Regions', region && region !== 'all' ? region : 'All regions'],
    ['Entities', entity && entity !== 'all' ? entity : 'All entities'],
    ['Sites', siteName || 'All sites'],
  ]
}
