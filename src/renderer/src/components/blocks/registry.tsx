import { z } from 'zod'
import type { ComponentType } from 'react'
import TerminalBlock from './TerminalBlock'
import CustomBlockHost from './CustomBlockHost'
import HelloBlock from './HelloBlock'
import WorkersBlock from './WorkersBlock'
import ProjectsBlock from './ProjectsBlock'
import ArchitectureBlock from './ArchitectureBlock'
import FilesBlock from './FilesBlock'
import FileBlock from './FileBlock'
import BrowserBlock from './BrowserBlock'

/**
 * Block registry (build-plan step 1): a block type is a component plus a
 * validated config schema. Layout items reference these by type; PaneHost
 * instantiates them.
 */

export interface BlockPaneProps<C = Record<string, unknown>> {
  config: C
  itemId: string
  /** whether this pane's tab is the active one in its group */
  active: boolean
}

export interface BlockDefinition {
  configSchema: z.ZodType<Record<string, unknown>>
  component: ComponentType<BlockPaneProps>
}

export const blockRegistry: Record<string, BlockDefinition> = {
  hello: {
    configSchema: z.object({}).passthrough(),
    component: HelloBlock as ComponentType<BlockPaneProps>
  },
  workers: {
    configSchema: z.object({}).passthrough(),
    component: WorkersBlock as ComponentType<BlockPaneProps>
  },
  projects: {
    configSchema: z.object({}).passthrough(),
    component: ProjectsBlock as ComponentType<BlockPaneProps>
  },
  architecture: {
    configSchema: z.object({}).passthrough(),
    component: ArchitectureBlock as ComponentType<BlockPaneProps>
  },
  files: {
    configSchema: z.object({}).passthrough(),
    component: FilesBlock as ComponentType<BlockPaneProps>
  },
  file: {
    configSchema: z.object({ path: z.string() }),
    component: FileBlock as ComponentType<BlockPaneProps>
  },
  terminal: {
    configSchema: z.object({ terminalId: z.string() }),
    component: TerminalBlock as ComponentType<BlockPaneProps>
  },
  browser: {
    configSchema: z.object({ browserId: z.string() }),
    component: BrowserBlock as ComponentType<BlockPaneProps>
  },
  custom: {
    configSchema: z.object({ name: z.string() }),
    component: CustomBlockHost as ComponentType<BlockPaneProps>
  }
}
