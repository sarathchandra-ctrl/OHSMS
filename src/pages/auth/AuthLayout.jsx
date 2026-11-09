import { motion, useReducedMotion } from 'framer-motion'
import BrandMark from '../../shared/branding/BrandMark'
import LoginFloatLogos from './LoginFloatLogos'

/**
 * Shared chrome for public auth screens (sign-in, register, forgot password).
 *
 * `showcase` is the optional right-hand / below column — the sign-in page uses
 * it for the module roster. Other auth routes stay the narrow centred card so
 * a password reset is not buried under seventeen glass tiles.
 *
 * With a showcase, the pair is a compact block centred in the viewport: the
 * form stays narrow and the line list sits beside it, so neither stretches
 * across the page.
 */
export default function AuthLayout({ title, subtitle, children, footer, showcase }) {
  const reduce = useReducedMotion()
  const brand = (
    <div
      className={`flex flex-col items-center px-1 text-center ${showcase ? 'mb-3' : 'mb-4 sm:mb-6'}`}
    >
      <BrandMark className="mb-2.5 sm:mb-3" size="lg" alt="Cult Fit SMS" />
      <h1 className="text-[22px] font-bold tracking-[-0.02em] text-ink-900 sm:text-2xl">{title}</h1>
      {subtitle && (
        <p className="mt-1 max-w-[28ch] text-[13px] leading-snug text-ink-500 sm:max-w-none sm:text-sm sm:leading-normal">
          {subtitle}
        </p>
      )}
    </div>
  )
  const panel = (
    <>
      {brand}
      <div className="card p-5 sm:p-8">{children}</div>
      {footer && (
        <div className="mt-4 px-1 text-center text-[13px] leading-relaxed text-ink-600 sm:mt-5 sm:text-sm">
          {footer}
        </div>
      )}
    </>
  )

  return (
    <div
      className={`aurora min-h-screen px-3.5 sm:px-4 ${
        showcase ? 'flex items-center py-6' : 'px-3.5 pb-10 pt-6 sm:py-12'
      }`}
    >
      <motion.div
        className={`mx-auto w-full ${showcase ? 'max-w-[920px]' : 'max-w-md'}`}
        initial={reduce ? { opacity: 0 } : { opacity: 0, y: 12, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ duration: 0.35, ease: [0.23, 1, 0.32, 1] }}
      >
        {showcase ? (
          <div className="login-stage grid items-center gap-6 lg:grid-cols-[20rem_minmax(0,1fr)] lg:gap-8">
            <LoginFloatLogos />
            <span aria-hidden="true" className="login-orb login-orb-a" />
            <span aria-hidden="true" className="login-orb login-orb-b" />
            <span aria-hidden="true" className="login-orb login-orb-c" />
            <div className="relative z-[1] mx-auto w-full max-w-md lg:mx-0">
              {brand}
              <div className="login-glass card p-5 sm:p-6">{children}</div>
              {footer && (
                <div className="mt-3 px-1 text-center text-[13px] leading-relaxed text-ink-600">
                  {footer}
                </div>
              )}
            </div>
            <div className="relative z-[1]">{showcase}</div>
          </div>
        ) : (
          <div className="mx-auto w-full max-w-md">{panel}</div>
        )}
      </motion.div>
    </div>
  )
}
