import { describe, expect, it } from 'vitest'
import {
  VIEW_MODE_KEY,
  automaticViewMode,
  destinationForMode,
  isPhoneUserAgent,
  isShellHome,
  readSignals,
  readViewChoice,
  resolveViewMode,
  shellForMode,
  writeViewChoice,
} from './viewMode'

function memory(initial = {}) {
  const data = { ...initial }
  return {
    getItem: (key) => (Object.prototype.hasOwnProperty.call(data, key) ? data[key] : null),
    setItem: (key, value) => {
      data[key] = String(value)
    },
    removeItem: (key) => {
      delete data[key]
    },
  }
}

describe('automaticViewMode', () => {
  it('keeps the native shell on the phone home even when the window is wide', () => {
    expect(automaticViewMode({ native: true, width: 1400 })).toBe('mobile')
  })

  it('treats 1024px and up as a desktop, including a touch tablet', () => {
    expect(automaticViewMode({ width: 1024, coarsePointer: true, phoneUa: true })).toBe('desktop')
    expect(automaticViewMode({ width: 1280 })).toBe('desktop')
  })

  it('treats a phone user agent or a coarse pointer under 1024px as a phone', () => {
    expect(automaticViewMode({ width: 932, phoneUa: true })).toBe('mobile')
    expect(automaticViewMode({ width: 834, coarsePointer: true })).toBe('mobile')
    expect(automaticViewMode({ phoneUa: true })).toBe('mobile')
    expect(automaticViewMode({ coarsePointer: true })).toBe('mobile')
  })

  it('keeps a narrow mouse window on the old phone breakpoint and a laptop gap on the desktop', () => {
    expect(automaticViewMode({ width: 767 })).toBe('mobile')
    expect(automaticViewMode({ width: 768 })).toBe('desktop')
    expect(automaticViewMode({ width: 1023 })).toBe('desktop')
    expect(automaticViewMode({})).toBe('desktop')
  })
})

describe('isPhoneUserAgent', () => {
  it('recognises a phone and leaves a tablet to the width rule', () => {
    expect(isPhoneUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)')).toBe(true)
    expect(isPhoneUserAgent('Mozilla/5.0 (Linux; Android 13; Pixel 7) Mobile Safari')).toBe(true)
    expect(
      isPhoneUserAgent('Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) Mobile/15E148 Safari')
    ).toBe(false)
    expect(isPhoneUserAgent('Mozilla/5.0 (Linux; Android 13; Pixel Tablet)')).toBe(false)
    expect(isPhoneUserAgent('Mozilla/5.0 (Macintosh)')).toBe(false)
    expect(isPhoneUserAgent('')).toBe(false)
  })
})

describe('readSignals', () => {
  it('reads native, width, phone user agent and a coarse pointer off the window', () => {
    const wideTablet = {
      innerWidth: 1180,
      navigator: { userAgent: 'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) Mobile/15E148' },
      matchMedia: (query) => ({ matches: query === '(pointer: coarse)' }),
    }
    expect(automaticViewMode(readSignals(wideTablet))).toBe('desktop')

    const native = {
      innerWidth: 1400,
      navigator: { userAgent: 'Mozilla/5.0' },
      matchMedia: () => ({ matches: false }),
      Capacitor: { isNativePlatform: () => true },
    }
    expect(automaticViewMode(readSignals(native))).toBe('mobile')
  })

  it('survives a window that cannot answer', () => {
    expect(readSignals(undefined)).toEqual({
      native: false,
      width: null,
      phoneUa: false,
      coarsePointer: false,
    })
    const broken = {
      innerWidth: 800,
      navigator: { userAgent: 'Mozilla/5.0 (iPhone)' },
      matchMedia: () => {
        throw new Error('denied')
      },
      Capacitor: {
        isNativePlatform: () => {
          throw new Error('denied')
        },
      },
    }
    expect(readSignals(broken)).toMatchObject({
      native: false,
      coarsePointer: false,
      phoneUa: true,
    })
  })
})

describe('stored choice', () => {
  it('lets an explicit choice beat the device, and treats anything else as automatic', () => {
    const signals = { native: true, width: 390, phoneUa: true, coarsePointer: true }
    expect(resolveViewMode('desktop', signals)).toBe('desktop')
    expect(resolveViewMode('mobile', { width: 1400 })).toBe('mobile')
    expect(resolveViewMode('auto', { width: 1400 })).toBe('desktop')
    expect(resolveViewMode('tablet', { width: 400, phoneUa: true })).toBe('mobile')
  })

  it('persists mobile or desktop and clears on automatic', () => {
    const box = memory()
    expect(readViewChoice(box)).toBe('auto')
    writeViewChoice('mobile', box)
    expect(box.getItem(VIEW_MODE_KEY)).toBe('mobile')
    expect(readViewChoice(box)).toBe('mobile')
    writeViewChoice('nope', box)
    expect(readViewChoice(box)).toBe('mobile')
    writeViewChoice('auto', box)
    expect(box.getItem(VIEW_MODE_KEY)).toBeNull()
    expect(readViewChoice(memory({ [VIEW_MODE_KEY]: 'tablet' }))).toBe('auto')
  })

  it('does not throw when storage is blocked', () => {
    const box = {
      getItem() {
        throw new Error('private')
      },
      setItem() {
        throw new Error('private')
      },
      removeItem() {
        throw new Error('private')
      },
    }
    expect(readViewChoice(box)).toBe('auto')
    expect(() => writeViewChoice('desktop', box)).not.toThrow()
    expect(() => writeViewChoice('auto', box)).not.toThrow()
  })
})

describe('shellForMode', () => {
  it('points the chrome at the phone home or the portal', () => {
    const mobile = shellForMode('mobile')
    expect(mobile.homePath).toBe('/field')
    expect(mobile.showFieldNav).toBe(true)
    expect(mobile.listenForAlerts).toBe(true)
    expect(mobile.mainClassName).toContain('safe-area-inset-bottom')

    const desktop = shellForMode('desktop')
    expect(desktop.homePath).toBe('/portal')
    expect(desktop.showFieldNav).toBe(false)
    expect(desktop.listenForAlerts).toBe(false)
    expect(desktop.mainClassName).not.toContain('safe-area-inset-bottom')
    expect(desktop.mainClassName).toContain('pb-24')
  })
})

describe('isShellHome', () => {
  it('treats the phone grid routes as home and leaves the jobs alone', () => {
    expect(isShellHome('/field', '/field')).toBe(true)
    expect(isShellHome('/field/', '/field')).toBe(true)
    expect(isShellHome('/portal', '/field')).toBe(true)
    expect(isShellHome('/', '/field')).toBe(true)
    expect(isShellHome('/field/tasks', '/field')).toBe(false)
    expect(isShellHome('/field/scan', '/field')).toBe(false)
    expect(isShellHome('/portal/training', '/field')).toBe(false)
    expect(isShellHome('/dashboard', '/field')).toBe(false)
  })

  it('follows a desktop shell home without also claiming the phone grid', () => {
    expect(isShellHome('/portal', '/portal')).toBe(true)
    expect(isShellHome('/portal/', '/portal')).toBe(true)
    expect(isShellHome('/portal/training', '/portal')).toBe(false)
    expect(isShellHome('/field', '/portal')).toBe(false)
    expect(isShellHome('', '/field')).toBe(false)
  })
})

describe('destinationForMode', () => {
  it('leaves the phone routes when the desktop portal is what should be showing', () => {
    expect(destinationForMode('desktop', '/field')).toBe('/portal')
    expect(destinationForMode('desktop', '/field/scan')).toBe('/portal')
    expect(destinationForMode('desktop', '/portal')).toBeNull()
    expect(destinationForMode('mobile', '/field')).toBeNull()
    expect(destinationForMode('mobile', '/portal')).toBeNull()
  })
})
