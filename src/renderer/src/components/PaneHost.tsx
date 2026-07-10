import { Component, type ReactNode } from 'react'
import type { LayoutTabItem } from '../../../shared/types'
import { blockRegistry } from './blocks/registry'
import CustomBlockHost from './blocks/CustomBlockHost'

function ErrorPane({ message }: { message: string }): React.JSX.Element {
  return (
    <div className="flex h-full items-center justify-center p-6 text-center text-[12px] text-red-400/80">
      {message}
    </div>
  )
}

class PaneErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null }
  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error }
  }
  render(): ReactNode {
    if (this.state.error)
      return <ErrorPane message={`Block crashed: ${this.state.error.message}`} />
    return this.props.children
  }
}

/** Instantiates a layout item through the registry: validate config, contain errors */
function PaneHost({ item, active }: { item: LayoutTabItem; active: boolean }): React.JSX.Element {
  const definition = blockRegistry[item.block]
  // built-in and custom blocks are addressed alike: any type not in the
  // registry is treated as a custom block name (the host reports unknown ones)
  if (!definition) {
    return (
      <PaneErrorBoundary>
        <CustomBlockHost config={{ name: item.block }} itemId={item.id} active={active} />
      </PaneErrorBoundary>
    )
  }
  const parsed = definition.configSchema.safeParse(item.config)
  if (!parsed.success) {
    return <ErrorPane message={`Invalid config for ${item.block}: ${parsed.error.message}`} />
  }
  const BlockComponent = definition.component
  return (
    <PaneErrorBoundary>
      <BlockComponent config={parsed.data} itemId={item.id} active={active} />
    </PaneErrorBoundary>
  )
}

export default PaneHost
