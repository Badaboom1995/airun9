import { useEffect, useState } from 'react'
import Welcome from './components/Welcome'
import Workspace from './components/Workspace'
import { api, events } from './lib/api'
import { useWorkspaceStore } from './stores/workspace'

function App(): React.JSX.Element {
  const hasProjects = useWorkspaceStore((s) => s.projects.length > 0)
  const setProjects = useWorkspaceStore((s) => s.setProjects)
  const [loaded, setLoaded] = useState(false)

  // the switcher state lives above the Welcome/Workspace fork: opening the
  // first project swaps the screen, closing the last one swaps it back
  useEffect(() => {
    const off = events.onProjectChanged(setProjects)
    void api
      .listProjects()
      .then(setProjects)
      .finally(() => setLoaded(true))
    return off
  }, [setProjects])

  if (!loaded) return <div className="h-screen w-screen bg-[#0b0e0c]" />
  return hasProjects ? <Workspace /> : <Welcome />
}

export default App
