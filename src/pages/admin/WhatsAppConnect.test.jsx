// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { AUDIT } from '../../shared/audit/audit'

const fns = vi.hoisted(() => ({
  whatsAppOrgStatus: vi.fn(),
  setWhatsAppOrgEnabled: vi.fn(),
  addWhatsAppOrgNumber: vi.fn(),
  removeWhatsAppOrgNumber: vi.fn(),
  sendWhatsAppOrgTest: vi.fn(),
}))

vi.mock('../../shared/functions', () => fns)
vi.mock('../../shared/org/orgData', () => ({
  subscribeOrgUsers: vi.fn((cb) => {
    cb([
      {
        uid: 'u1',
        name: 'Asha Example',
        email: 'asha@example.com',
        status: 'approved',
        role: 'member',
      },
      {
        uid: 'pending1',
        name: 'Pending Person',
        email: 'pending@example.com',
        status: 'pending',
        role: 'member',
      },
    ])
    return () => {}
  }),
  logAudit: vi.fn(),
}))
vi.mock('qrcode.react', () => ({
  QRCodeSVG: ({ value }) => <svg data-testid="qr" data-value={value} />,
}))
vi.mock('react-hot-toast', () => ({ default: { success: vi.fn(), error: vi.fn() } }))

const { default: WhatsAppConnect } = await import('./WhatsAppConnect.jsx')
const { logAudit } = await import('../../shared/org/orgData')

const status = {
  platformReady: true,
  number: '+91 98000 00000',
  chatLink: 'https://wa.me/919800000000',
  enabled: true,
  truncated: false,
  links: [
    {
      phone: '919000000001',
      masked: '•••• 0001',
      uid: 'u1',
      active: true,
      linkedAt: 1,
      source: 'admin',
    },
  ],
}

beforeEach(() => {
  fns.whatsAppOrgStatus.mockReset()
  fns.setWhatsAppOrgEnabled.mockReset()
  fns.addWhatsAppOrgNumber.mockReset()
  fns.removeWhatsAppOrgNumber.mockReset()
  fns.sendWhatsAppOrgTest.mockReset()
  logAudit.mockReset()
  fns.whatsAppOrgStatus.mockResolvedValue(status)
  fns.setWhatsAppOrgEnabled.mockImplementation(async (enabled) => ({ enabled }))
  fns.addWhatsAppOrgNumber.mockResolvedValue({
    phone: '919000000002',
    masked: '•••• 0002',
    uid: 'u1',
    mapped: 'chosen',
  })
  fns.removeWhatsAppOrgNumber.mockResolvedValue({ masked: '•••• 0001' })
  fns.sendWhatsAppOrgTest.mockResolvedValue({ sent: true, masked: '•••• 0001' })
  Object.assign(navigator, {
    clipboard: { writeText: vi.fn().mockResolvedValue(undefined) },
  })
})

function renderSection() {
  return render(<WhatsAppConnect actor={{ uid: 'admin1', name: 'Ada Admin' }} />)
}

describe('Connect with WhatsApp', () => {
  it('shows the shared number, the org switch, and the linked employee', async () => {
    renderSection()
    expect(await screen.findByRole('heading', { name: 'Connect with WhatsApp' })).toBeTruthy()
    expect(screen.getByText('The shared number is switched on')).toBeTruthy()
    expect(
      screen.getByRole('link', { name: 'https://wa.me/919800000000' }).getAttribute('href')
    ).toBe('https://wa.me/919800000000')
    expect(screen.getByText('919000000001')).toBeTruthy()
    expect(screen.getAllByText(/Asha Example/).length).toBeGreaterThan(0)
    expect(screen.getByRole('button', { name: 'Turn off for this organisation' })).toBeTruthy()
    expect(screen.queryByRole('link', { name: /t\.me/i })).toBeNull()
    expect(screen.queryByText(/telegram/i)).toBeNull()
  })

  it('shows the WhatsApp link and QR, and copies it', async () => {
    renderSection()
    const link = await screen.findByRole('link', { name: 'https://wa.me/919800000000' })
    expect(link.getAttribute('href')).toBe('https://wa.me/919800000000')
    const codes = screen.getAllByTestId('qr').map((node) => node.getAttribute('data-value'))
    expect(codes).toContain('https://wa.me/919800000000')
    expect(codes.some((value) => /t\.me|telegram/i.test(value || ''))).toBe(false)

    fireEvent.click(screen.getByRole('button', { name: 'Copy WhatsApp link' }))
    await waitFor(() =>
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith('https://wa.me/919800000000')
    )
  })

  it('does not render a chat link the server did not make a wa.me URL', async () => {
    fns.whatsAppOrgStatus.mockResolvedValue({
      ...status,
      chatLink: 'javascript:alert(1)',
      number: 'javascript:alert(1)',
      links: [],
    })
    renderSection()
    expect(await screen.findByText(/not published yet/)).toBeTruthy()
    expect(screen.queryByRole('link', { name: /javascript/i })).toBeNull()
    expect(document.body.innerHTML).not.toContain('javascript:alert')
  })

  it('turns lookup off, adds a number for an employee, removes it, and sends a test', async () => {
    renderSection()
    fireEvent.click(await screen.findByRole('button', { name: 'Turn off for this organisation' }))
    await waitFor(() => expect(fns.setWhatsAppOrgEnabled).toHaveBeenCalledWith(false))
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Add number' }).hasAttribute('disabled')).toBe(
        false
      )
    )
    expect(logAudit).toHaveBeenCalledWith({ uid: 'admin1', name: 'Ada Admin' },
      AUDIT.ORG_SETTINGS,
      expect.objectContaining({ module: 'core', target: 'whatsapp' })
    )

    fireEvent.change(screen.getByLabelText('WhatsApp number'), {
      target: { value: '+91 90000 00002' },
    })
    fireEvent.change(screen.getByLabelText('Employee'), { target: { value: 'u1' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add number' }))
    await waitFor(() =>
      expect(fns.addWhatsAppOrgNumber).toHaveBeenCalledWith({ phone: '+91 90000 00002', uid: 'u1' })
    )
    expect(screen.queryByRole('option', { name: /Pending Person/ })).toBeNull()

    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Remove/ }).hasAttribute('disabled')).toBe(false)
    )
    fireEvent.click(screen.getByRole('button', { name: /Remove/ }))
    await waitFor(() => expect(fns.removeWhatsAppOrgNumber).toHaveBeenCalledWith('919000000001'))

    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Send test message' }).hasAttribute('disabled')
      ).toBe(false)
    )
    expect(screen.getByText(/last 24 hours/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Send test message' }))
    await waitFor(() => expect(fns.sendWhatsAppOrgTest).toHaveBeenCalledWith('919000000001'))
  })

  it('keeps a 131047 refusal on the page', async () => {
    fns.sendWhatsAppOrgTest.mockRejectedValue(
      new Error(
        'WhatsApp could not deliver the test (131047). The recipient must have messaged this number within the last 24 hours. Ask them to send any message to the number, then try again.'
      )
    )
    renderSection()
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Send test message' }).hasAttribute('disabled')
      ).toBe(false)
    )
    fireEvent.click(screen.getByRole('button', { name: 'Send test message' }))
    expect(await screen.findByRole('alert')).toBeTruthy()
    expect(screen.getByRole('alert').textContent).toMatch(/131047/)
    expect(screen.getByRole('alert').textContent).toMatch(/24 hours/)
  })

  it('does not show a Telegram link when WhatsApp settings cannot be loaded', async () => {
    fns.whatsAppOrgStatus.mockRejectedValue(new Error('offline'))
    renderSection()
    expect(await screen.findByText('Could not load WhatsApp settings.')).toBeTruthy()
    expect(screen.queryByRole('link', { name: /t\.me/i })).toBeNull()
    expect(screen.queryByText(/telegram/i)).toBeNull()
    expect(screen.queryByText(/WA_ACCESS_TOKEN/)).toBeNull()
  })
})
