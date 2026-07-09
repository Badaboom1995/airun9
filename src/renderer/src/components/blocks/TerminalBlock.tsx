import TerminalView from '../TerminalView'
import type { BlockPaneProps } from './registry'

function TerminalBlock({
  config,
  active
}: BlockPaneProps<{ terminalId: string }>): React.JSX.Element {
  return <TerminalView id={config.terminalId} active={active} />
}

export default TerminalBlock
