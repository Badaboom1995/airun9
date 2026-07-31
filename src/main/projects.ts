import { EventEmitter } from 'node:events'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import type { ProjectInfo, ProjectsState } from '../shared/types'

const PROJECTS_FILE = join(homedir(), '.airun9', 'projects.json')

/**
 * Open projects (folders/repos) and which one is active. Several are open at
 * once; each owns its layout tree, terminals, browsers and agents — switching
 * is a view change, background projects keep running.
 *
 * Ids are derived from the realpath, so a closed-and-reopened folder gets the
 * same id and finds its persisted layout again. Worktrees later become child
 * projects (parentId) with their own equally-deterministic ids.
 */
export class ProjectManager extends EventEmitter {
  private projects = new Map<string, ProjectInfo>()
  private activeId: string | null = null

  constructor() {
    super()
    try {
      if (!existsSync(PROJECTS_FILE)) return
      const parsed = JSON.parse(readFileSync(PROJECTS_FILE, 'utf8')) as {
        projects?: ProjectInfo[]
        activeId?: string | null
      }
      for (const project of parsed.projects ?? []) {
        // folders can vanish between sessions; drop them silently
        if (project?.id && project?.path && existsSync(project.path)) {
          this.projects.set(project.id, project)
        }
      }
      this.activeId =
        parsed.activeId && this.projects.has(parsed.activeId)
          ? parsed.activeId
          : ([...this.projects.keys()][0] ?? null)
    } catch (error) {
      console.error('projects restore failed:', error)
    }
  }

  /** Open (or re-activate) the project at path; dedupes by realpath.
   * With parentId the path opens as a child workspace — how a worktree
   * becomes a context of its repo (ADR-0011) rather than a rail chip. */
  open(path: string, parentId: string | null = null): ProjectInfo {
    if (!existsSync(path) || !statSync(path).isDirectory()) {
      throw new Error(`Not a directory: ${path}`)
    }
    const real = realpathSync(path)
    const id = projectId(real)
    let project = this.projects.get(id)
    if (!project) {
      project = { id, path: real, name: basename(real), parentId, createdAt: Date.now() }
      this.projects.set(id, project)
    } else if (parentId && project.parentId !== parentId) {
      // a folder opened top-level earlier turns out to be a worktree — adopt
      project.parentId = parentId
    }
    this.activate(id)
    return project
  }

  /** Close a project; the caller is responsible for killing its sessions */
  close(id: string): void {
    // child workspaces (worktree contexts) die with their parent
    for (const child of this.list().filter((p) => p.parentId === id)) this.close(child.id)
    const project = this.get(id)
    this.projects.delete(id)
    if (this.activeId === id) {
      this.activeId = [...this.projects.keys()][0] ?? null
      if (this.activeId) this.emit('activated', this.projects.get(this.activeId))
    }
    this.emit('closed', project)
    this.changed()
  }

  activate(id: string): ProjectInfo {
    const project = this.get(id)
    if (this.activeId !== id) {
      this.activeId = id
      this.emit('activated', project)
    }
    this.changed()
    return project
  }

  list(): ProjectInfo[] {
    return [...this.projects.values()]
  }

  get(id: string): ProjectInfo {
    const project = this.projects.get(id)
    if (!project) throw new Error(`Unknown project: ${id}`)
    return project
  }

  active(): ProjectInfo | null {
    return this.activeId ? (this.projects.get(this.activeId) ?? null) : null
  }

  state(): ProjectsState {
    return { projects: this.list(), activeId: this.activeId }
  }

  private changed(): void {
    this.emit('changed', this.state())
    try {
      mkdirSync(dirname(PROJECTS_FILE), { recursive: true })
      writeFileSync(PROJECTS_FILE, JSON.stringify(this.state()))
    } catch (error) {
      console.error('projects save failed:', error)
    }
  }
}

/** Stable id for a folder: reopening it recovers layouts and storage */
export function projectId(realPath: string): string {
  return `proj_${createHash('sha1').update(realPath).digest('hex').slice(0, 10)}`
}
