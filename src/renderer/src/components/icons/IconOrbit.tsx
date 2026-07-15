import { motion } from 'motion/react'

/**
 * Orbit mark for workers (animate-ui's Orbit geometry, self-contained).
 * `spinning` starts/stops the rotation — stopping eases back to rest.
 * Color follows currentColor, so the usual text-* classes apply.
 */
function IconOrbit({
  spinning = false,
  stroke = 2,
  className
}: {
  spinning?: boolean
  stroke?: number
  className?: string
}): React.JSX.Element {
  return (
    <motion.svg
      xmlns="http://www.w3.org/2000/svg"
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={stroke}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      animate={spinning ? { rotate: 360 } : { rotate: 0 }}
      transition={
        spinning
          ? { duration: 2, ease: 'linear', repeat: Infinity, repeatType: 'loop' }
          : { duration: 0.3, ease: 'easeOut' }
      }
    >
      <path d="M20.341 6.484A10 10 0 0 1 10.266 21.85" />
      <path d="M3.659 17.516A10 10 0 0 1 13.74 2.152" />
      <circle cx="12" cy="12" r="3" />
      <circle cx="19" cy="5" r="2" />
      <circle cx="5" cy="19" r="2" />
    </motion.svg>
  )
}

export default IconOrbit
