import Welcome from './components/Welcome'
import Workspace from './components/Workspace'
import { useWorkspaceStore } from './stores/workspace'

function App(): React.JSX.Element {
  const project = useWorkspaceStore((s) => s.project)
  return project ? <Workspace /> : <Welcome />
}

export default App
