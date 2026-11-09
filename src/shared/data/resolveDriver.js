// Which VITE_DATA_DRIVER name is allowed to boot.
//
// supabase (the Supabase client / Realtime flavor) stays reserved until that
// adapter exists; a Supabase Postgres uses postgres. Selecting a reserved name
// throws instead of silently selecting the default: the app would keep
// writing safety records into a database the operator thought they had left.
//
// A registered adapter wins over this list.

export const RESERVED_DATA_DRIVERS = ['supabase']

export class UnimplementedDataDriverError extends Error {
  constructor(driver) {
    super(`VITE_DATA_DRIVER=${driver} has no adapter. The app will not fall back to another database.`)
    this.name = 'UnimplementedDataDriverError'
    this.driver = driver
  }
}

/**
 * @param {string | undefined} raw  VITE_DATA_DRIVER, as the deployment supplied it
 * @param {Record<string, unknown>} drivers  the registered adapter map
 * @returns {string} a key of `drivers`, or 'postgres' for an unknown name
 */
export function resolveDataDriver(raw, drivers) {
  const name = String(raw || 'postgres')
    .trim()
    .toLowerCase()
  if (name && Object.hasOwn(drivers, name)) return name
  if (RESERVED_DATA_DRIVERS.includes(name)) throw new UnimplementedDataDriverError(name)
  return 'postgres'
}
