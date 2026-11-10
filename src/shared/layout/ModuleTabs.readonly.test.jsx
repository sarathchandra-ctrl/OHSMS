// @vitest-environment jsdom
import { render, screen, cleanup } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../auth/AuthContext', () => ({ useReadOnly: () => true }))
const { default: ModuleTabs } = await import('./ModuleTabs')

afterEach(cleanup)

describe('ModuleTabs for a view-only role', () => {
  it('leaves out the tabs that only write', () => {
    render(
      <MemoryRouter initialEntries={['/hira']}>
        <ModuleTabs
          tabs={[
            { to: '/hira', label: 'Assessments', end: true },
            { to: '/hira/bulk-import', label: 'Bulk Import', write: true },
          ]}
        />
      </MemoryRouter>
    )
    expect(screen.getByRole('link', { name: 'Assessments' })).toBeTruthy()
    expect(screen.queryByRole('link', { name: 'Bulk Import' })).toBeNull()
  })
})
