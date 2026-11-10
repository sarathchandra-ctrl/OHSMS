// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import ActionOwnerField from './ActionOwnerField'

afterEach(cleanup)

const users = [
  { id: '1', name: 'Ada' },
  { id: '2', name: 'Bea' },
]

describe('ActionOwnerField', () => {
  it('records who the person is, so the server can tell them of the action', () => {
    const onChange = vi.fn()
    render(<ActionOwnerField users={users} value={{ ownerKind: 'person', owner: '' }} onChange={onChange} />)
    fireEvent.change(screen.getByRole('combobox', { name: 'Person' }), { target: { value: 'Bea' } })
    expect(onChange).toHaveBeenCalledWith({ ownerKind: 'person', owner: 'Bea', department: '', ownerUid: '2' })
  })

  it('offers the org departments, and only that side', () => {
    const onChange = vi.fn()
    render(
      <ActionOwnerField
        users={users}
        departments={['Housekeeping', 'Safety']}
        value={{ ownerKind: 'person', owner: 'Ada', department: '' }}
        onChange={onChange}
        name="row-1"
      />,
    )
    expect(screen.getByRole('combobox', { name: 'Person' }).value).toBe('Ada')
    expect(screen.queryByRole('combobox', { name: 'Department' })).toBeNull()

    fireEvent.click(screen.getByRole('radio', { name: 'Department' }))
    expect(onChange).toHaveBeenCalledWith({
      ownerKind: 'department',
      department: '',
      owner: '',
      ownerUid: '',
    })
  })

  it('uses a text field when the org has no department list', () => {
    const onChange = vi.fn()
    render(
      <ActionOwnerField
        users={users}
        departments={[]}
        value={{ ownerKind: 'department', department: '', owner: '' }}
        onChange={onChange}
        name="row-2"
      />,
    )
    fireEvent.change(screen.getByRole('textbox', { name: 'Department name' }), {
      target: { value: 'Yard' },
    })
    expect(onChange).toHaveBeenCalledWith({
      ownerKind: 'department',
      department: 'Yard',
      owner: '',
      ownerUid: '',
    })
    expect(screen.queryByRole('combobox', { name: 'Person' })).toBeNull()
  })

  it('keeps a stored person who is no longer in the member list', () => {
    render(
      <ActionOwnerField
        users={users}
        departments={['Safety']}
        value={{ owner: 'Cara' }}
        onChange={() => {}}
        name="row-3"
      />,
    )
    expect(screen.getByRole('combobox', { name: 'Person' }).value).toBe('Cara')
    expect(screen.getByRole('radio', { name: 'Person' }).checked).toBe(true)
  })
})
