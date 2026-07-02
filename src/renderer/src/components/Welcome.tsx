import { IconFolderOpen, IconGitBranch, IconTerminal2 } from '@tabler/icons-react'

import SpaceShader from './SpaceShader'

const actions = [
  { icon: IconFolderOpen, label: 'Open project' },
  { icon: IconGitBranch, label: 'Clone repo' },
  { icon: IconTerminal2, label: 'Connect via SSH' }
]

// Placeholder rows until real recents are wired up
const recentProjects = [
  { name: 'agentic-ide', path: '~/projects/agentic-ide' },
  { name: 'weern-kids', path: '~/projects/weern-kids' },
  { name: 'auth', path: '~/projects/weern-kids/app' },
  { name: 'encode_test', path: '~/Downloads/weern/functions' },
  { name: 'resources', path: '~/projects/resources' }
]

function Welcome(): React.JSX.Element {
  return (
    <div className="relative flex h-screen w-screen items-center justify-center overflow-hidden bg-[#0b0e0c] text-neutral-200 antialiased">
      <SpaceShader />

      {/* draggable strip replacing the hidden title bar */}
      <div
        className="absolute inset-x-0 top-0 z-10 h-10"
        style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
      />

      <div className="relative w-[540px]">
        <h1 className="font-michroma text-base tracking-[0.25em] text-neutral-100">AIRUN9</h1>
        <p className="mt-1 text-[13px] text-neutral-500">What are we building today?</p>

        <div className="mt-6 grid grid-cols-3 gap-3">
          {actions.map(({ icon: Icon, label }) => (
            <button
              key={label}
              type="button"
              className="flex h-[76px] flex-col items-start justify-between rounded-xl border border-white/10 bg-white/[0.04] p-3.5 text-left backdrop-blur-[3px] transition-colors hover:bg-white/[0.08] focus-visible:bg-white/[0.08] focus-visible:outline-none"
            >
              <Icon className="size-[18px] text-neutral-400" stroke={1.75} />
              <span className="text-[13px] text-neutral-200">{label}</span>
            </button>
          ))}
        </div>

        <div className="mt-8">
          <div className="flex items-baseline justify-between px-1">
            <h2 className="text-[13px] text-neutral-500">Recent projects</h2>
            <button
              type="button"
              className="text-[13px] text-neutral-500 transition-colors hover:text-neutral-300"
            >
              View all ({recentProjects.length})
            </button>
          </div>

          <ul className="mt-1.5">
            {recentProjects.map(({ name, path }) => (
              <li key={path}>
                <button
                  type="button"
                  className="flex w-full items-baseline justify-between rounded-md px-1 py-[5px] text-left transition-colors hover:bg-white/[0.05] focus-visible:bg-white/[0.05] focus-visible:outline-none"
                >
                  <span className="text-[13px] text-neutral-200">{name}</span>
                  <span className="text-xs text-neutral-500">{path}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  )
}

export default Welcome
