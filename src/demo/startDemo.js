// Started by main.jsx in a demo build only. See demoMode.js.
import { doc, setDoc } from '../shared/data/client.js'
import { db } from '../shared/db'
import { installDemoFetch } from './demoMode'
import { seedDemo } from './seed'

export async function startDemo() {
  installDemoFetch({
    // Employees → Add employee, in the demo: the profile goes straight into
    // the in-browser data, already approved, with no password to change.
    createUser: (uid, { email, name, role }) =>
      setDoc(doc(db, 'users', uid), {
        name: name || email,
        email,
        role,
        status: 'approved',
        mustChangePassword: false,
        access: { sites: [], regions: [], entities: [] },
      }),
  })
  await seedDemo()
}
