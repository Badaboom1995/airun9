import type { SVGProps } from 'react'

/**
 * Astronaut helmet — the worker mark. Drawn on the Tabler 24px grid with the
 * same props contract (`stroke` = stroke width) so it drops in anywhere a
 * @tabler/icons-react icon is used.
 */
function IconAstronaut({
  stroke = 2,
  ...props
}: Omit<SVGProps<SVGSVGElement>, 'stroke'> & { stroke?: number }): React.JSX.Element {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={stroke}
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      <path d="M4.5 12a7.5 7.5 0 0 1 15 0v1.5a6 6 0 0 1-6 6h-3a6 6 0 0 1-6-6z" />
      <path d="M8 8.5h8v2.5a4 4 0 0 1-4 4 4 4 0 0 1-4-4z" />
      <path d="M9 21.5h6" />
    </svg>
  )
}

export default IconAstronaut
