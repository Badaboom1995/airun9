import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { nanoid } from 'nanoid'
import type { LayoutNode, LayoutTabItem, PanePosition, SplitNode, TabsNode } from '../shared/types'

/** One layout file per project, keyed by its stable id; survives close/reopen */
const LAYOUTS_DIR = join(homedir(), '.airun9', 'layouts')

/**
 * The layout template: the user's pane arrangement (splits, ratios, tab
 * groups, tool blocks) continuously mirrored from whatever layout they last
 * edited, and applied to any project that has no layout yet — so new
 * projects open with the familiar shape instead of a lone terminal.
 * Session panes are templated down to ONE fresh placeholder each (a pane
 * with 4 terminal tabs templates as 1 — the shape carries, the multiplicity
 * and content don't); project-content panes (open file readers) are
 * dropped entirely.
 */
const TEMPLATE_FILE = join(homedir(), '.airun9', 'layout-template.json')
const PLACEHOLDER_BLOCKS = new Set(['terminal', 'browser'])
const CONTENT_BLOCKS = new Set(['file'])

/**
 * Owns the layout trees (ADR-0001/0002): one split-tree-with-tab-leaves per
 * project. The renderer renders the active project's tree; users and agents
 * mutate trees through the API. Persisted as JSON per project (ADR-0010:
 * layout stays in files, SQLite owns relational data). Terminal/browser
 * panes reference sessions that don't survive a restart; they are kept
 * anyway — dropping them collapsed their splits and merged surviving panes
 * into one tab group — and index.ts respawns fresh sessions into them when
 * their project is activated (lazy pane adoption).
 */
export class LayoutManager extends EventEmitter {
  private trees = new Map<string, LayoutNode>()
  private saveTimers = new Map<string, NodeJS.Timeout>()
  private templateTimer: NodeJS.Timeout | null = null
  private templateSource: string | null = null

  get(projectId: string): LayoutNode {
    return this.tree(projectId)
  }

  set(projectId: string, node: LayoutNode): LayoutNode {
    validate(node)
    assignIds(node)
    this.trees.set(projectId, ensurePrimary(normalize(node)))
    this.changed(projectId)
    return this.tree(projectId)
  }

  /** Every tab item in a project's tree, in walk order */
  items(projectId: string): LayoutTabItem[] {
    const all: LayoutTabItem[] = []
    walkTabs(this.tree(projectId), (tabs) => all.push(...tabs.items))
    return all
  }

  /**
   * Add a block instance; 'tab' joins the first tab group, the rest split
   * the root. `share` is the new pane's fraction of the window.
   */
  addItem(
    projectId: string,
    item: Omit<LayoutTabItem, 'id'>,
    position: PanePosition = 'tab',
    activate = true,
    share = 0.35
  ): LayoutTabItem {
    const root = this.tree(projectId)
    const full: LayoutTabItem = { ...item, id: `item_${nanoid(8)}` }
    if (position === 'tab') {
      const tabs = primaryTabs(root)
      tabs.items.push(full)
      if (activate || tabs.items.length === 1) tabs.active = full.id
    } else {
      const leaf: TabsNode = {
        type: 'tabs',
        id: `tabs_${nanoid(8)}`,
        active: full.id,
        items: [full]
      }
      const before = position === 'left' || position === 'up'
      this.trees.set(projectId, {
        type: 'split',
        id: `split_${nanoid(8)}`,
        direction: position === 'right' || position === 'left' ? 'row' : 'column',
        ratios: before ? [share, 1 - share] : [1 - share, share],
        children: before ? [leaf, root] : [root, leaf]
      })
    }
    this.changed(projectId)
    return full
  }

  /**
   * Place a new one-item leaf beside the tab group holding refItemId. When
   * that group already sits in a row split, the leaf joins it as a sibling
   * with `share` of the whole split (so a slim reference pane doesn't cramp
   * the new one); otherwise the group's slot is split in two.
   */
  openBeside(
    projectId: string,
    refItemId: string,
    item: Omit<LayoutTabItem, 'id'>,
    side: 'left' | 'right',
    share = 0.35
  ): LayoutTabItem {
    const root = this.tree(projectId)
    const tabs = findTabsContaining(root, refItemId)
    if (!tabs) throw new Error(`Unknown layout item: ${refItemId}`)
    const full: LayoutTabItem = { ...item, id: `item_${nanoid(8)}` }
    const leaf: TabsNode = { type: 'tabs', id: `tabs_${nanoid(8)}`, active: full.id, items: [full] }
    const parent = findParentSplit(root, tabs)
    if (parent && parent.direction === 'row') {
      const at = parent.children.indexOf(tabs) + (side === 'right' ? 1 : 0)
      const total = parent.ratios.reduce((a, b) => a + b, 0) || 1
      const ratios = parent.ratios.map((ratio) => (ratio / total) * (1 - share))
      ratios.splice(at, 0, share)
      parent.children.splice(at, 0, leaf)
      parent.ratios = ratios
    } else {
      const split: SplitNode = {
        type: 'split',
        id: `split_${nanoid(8)}`,
        direction: 'row',
        ratios: side === 'right' ? [1 - share, share] : [share, 1 - share],
        children: side === 'right' ? [tabs, leaf] : [leaf, tabs]
      }
      this.replaceNode(projectId, tabs, split)
    }
    this.changed(projectId)
    return full
  }

  /** Replace an item's config in place (e.g. rebind a pane to a fresh session) */
  updateItemConfig(
    projectId: string,
    itemId: string,
    config: Record<string, unknown>
  ): LayoutTabItem {
    let found: LayoutTabItem | null = null
    walkTabs(this.tree(projectId), (tabs) => {
      const item = tabs.items.find((i) => i.id === itemId)
      if (item) {
        item.config = config
        found = item
      }
    })
    if (!found) throw new Error(`Unknown layout item: ${itemId}`)
    this.changed(projectId)
    return found
  }

  removeItem(projectId: string, itemId: string): void {
    this.removeWhere(projectId, (item) => item.id === itemId)
  }

  removeWhere(projectId: string, predicate: (item: LayoutTabItem) => boolean): void {
    let removed = false
    walkTabs(this.tree(projectId), (tabs) => {
      const before = tabs.items.length
      tabs.items = tabs.items.filter((item) => !predicate(item))
      if (tabs.items.length !== before) {
        removed = true
        if (tabs.active && !tabs.items.some((i) => i.id === tabs.active)) {
          tabs.active = tabs.items[tabs.items.length - 1]?.id ?? null
        }
      }
    })
    if (removed) {
      this.trees.set(projectId, ensurePrimary(normalize(this.tree(projectId))))
      this.changed(projectId)
    }
  }

  setActive(projectId: string, tabsId: string, itemId: string): void {
    let found = false
    walkTabs(this.tree(projectId), (tabs) => {
      if (tabs.id === tabsId && tabs.items.some((i) => i.id === itemId)) {
        tabs.active = itemId
        found = true
      }
    })
    if (!found) throw new Error(`Unknown tab ${itemId} in group ${tabsId}`)
    this.changed(projectId)
  }

  setRatios(projectId: string, splitId: string, ratios: number[]): void {
    let found = false
    walk(this.tree(projectId), (node) => {
      if (node.type === 'split' && node.id === splitId && node.ratios.length === ratios.length) {
        node.ratios = ratios
        found = true
      }
    })
    if (!found) throw new Error(`Unknown split: ${splitId}`)
    this.changed(projectId)
  }

  /** Drop a closed project's tree from memory; its file stays for reopening */
  unload(projectId: string): void {
    const timer = this.saveTimers.get(projectId)
    if (timer) {
      clearTimeout(timer)
      this.saveTimers.delete(projectId)
      this.save(projectId)
    }
    this.trees.delete(projectId)
  }

  /** Flush pending saves (call on app quit) */
  dispose(): void {
    for (const [projectId, timer] of this.saveTimers) {
      clearTimeout(timer)
      this.save(projectId)
    }
    this.saveTimers.clear()
    if (this.templateTimer) {
      clearTimeout(this.templateTimer)
      this.templateTimer = null
      if (this.templateSource) this.saveTemplate(this.templateSource)
    }
  }

  /** Lazy-load a project's tree from disk; a project seen for the first
   * time starts from the template (the user's usual pane arrangement) */
  private tree(projectId: string): LayoutNode {
    let root = this.trees.get(projectId)
    if (root) return root
    root = emptyTabs()
    const file = layoutFile(projectId)
    try {
      if (existsSync(file)) {
        const parsed = JSON.parse(readFileSync(file, 'utf8')) as LayoutNode
        validate(parsed)
        assignIds(parsed)
        root = normalize(parsed)
      } else {
        root = this.loadTemplate() ?? root
      }
    } catch (error) {
      console.error(`layout restore failed for ${projectId}:`, error)
    }
    root = ensurePrimary(root)
    this.trees.set(projectId, root)
    return root
  }

  private loadTemplate(): LayoutNode | null {
    try {
      if (!existsSync(TEMPLATE_FILE)) return null
      const parsed = JSON.parse(readFileSync(TEMPLATE_FILE, 'utf8')) as LayoutNode
      // the template stores no ids; materialize fresh ones for this tree
      const materialized = materializeTemplate(parsed)
      validate(materialized)
      const root = normalize(materialized)
      return root.type === 'tabs' && root.items.length === 0 ? null : root
    } catch (error) {
      console.error('layout template load failed:', error)
      return null
    }
  }

  /** Mirror the just-edited layout's shape into the template (debounced —
   * adoption rebinds and drag-resizes fire changed() in bursts) */
  private saveTemplate(projectId: string): void {
    const root = this.trees.get(projectId)
    if (!root) return
    const template = toTemplate(root)
    // a transient empty workspace must not blank a useful template
    if (countItems(template) === 0) return
    try {
      mkdirSync(dirname(TEMPLATE_FILE), { recursive: true })
      writeFileSync(TEMPLATE_FILE, JSON.stringify(template))
    } catch (error) {
      console.error('layout template save failed:', error)
    }
  }

  /**
   * Swap a node (matched by identity) for another. Stops at the first match
   * and never descends into the replacement — the replacement may contain
   * the target (openBeside re-parents the tabs node under a new split), and
   * replacing there again would make the split its own child.
   */
  private replaceNode(projectId: string, target: LayoutNode, replacement: LayoutNode): void {
    const root = this.tree(projectId)
    if (root === target) {
      this.trees.set(projectId, replacement)
      return
    }
    const visit = (node: LayoutNode): boolean => {
      if (node.type !== 'split') return false
      const index = node.children.indexOf(target)
      if (index >= 0) {
        node.children[index] = replacement
        return true
      }
      return node.children.some(visit)
    }
    visit(root)
  }

  private changed(projectId: string): void {
    this.emit('changed', { projectId, root: this.tree(projectId) })
    const pending = this.saveTimers.get(projectId)
    if (pending) clearTimeout(pending)
    this.saveTimers.set(
      projectId,
      setTimeout(() => {
        this.saveTimers.delete(projectId)
        this.save(projectId)
      }, 300)
    )
    // whatever layout the user edits last IS the template for new projects
    this.templateSource = projectId
    if (this.templateTimer) clearTimeout(this.templateTimer)
    this.templateTimer = setTimeout(() => {
      this.templateTimer = null
      this.saveTemplate(projectId)
    }, 500)
  }

  private save(projectId: string): void {
    const root = this.trees.get(projectId)
    if (!root) return
    try {
      mkdirSync(LAYOUTS_DIR, { recursive: true })
      writeFileSync(layoutFile(projectId), JSON.stringify(root))
    } catch (error) {
      console.error(`layout save failed for ${projectId}:`, error)
    }
  }
}

function layoutFile(projectId: string): string {
  // ids are proj_<hex>, safe as file names; encode defensively anyway
  return join(LAYOUTS_DIR, `${encodeURIComponent(projectId)}.json`)
}

/** Agents may omit node ids / active markers — fill them in */
function assignIds(node: LayoutNode): void {
  walk(node, (n) => {
    if (!n.id) n.id = `${n.type}_${nanoid(8)}`
    if (n.type === 'tabs') {
      if (n.active === undefined || (n.active && !n.items.some((i) => i.id === n.active))) {
        n.active = n.items[0]?.id ?? null
      }
    }
  })
}

function emptyTabs(): TabsNode {
  return { type: 'tabs', id: `tabs_${nanoid(8)}`, active: null, primary: true, items: [] }
}

/**
 * A layout's template: same splits/ratios/groups, but panes hold only what
 * transfers to another project — tool blocks keep their config, session
 * panes reduce to one id-less placeholder each (adoption spawns a fresh
 * session into it), open-file readers drop. Ids are stripped; each
 * application materializes fresh ones.
 */
function toTemplate(node: LayoutNode): LayoutNode {
  if (node.type === 'tabs') {
    const items: LayoutTabItem[] = []
    const placed = new Set<string>()
    for (const item of node.items) {
      if (CONTENT_BLOCKS.has(item.block)) continue
      if (PLACEHOLDER_BLOCKS.has(item.block)) {
        if (!placed.has(item.block)) {
          placed.add(item.block)
          items.push({ id: '', block: item.block, config: {} })
        }
      } else {
        items.push({ id: '', block: item.block, config: { ...item.config } })
      }
    }
    return {
      type: 'tabs',
      id: '',
      active: null,
      ...(node.primary ? { primary: true } : {}),
      items
    }
  }
  return {
    type: 'split',
    id: '',
    direction: node.direction,
    ratios: [...node.ratios],
    children: node.children.map(toTemplate)
  }
}

/** Fresh node/item ids for a template instance; first tab becomes active */
function materializeTemplate(template: LayoutNode): LayoutNode {
  const clone = JSON.parse(JSON.stringify(template)) as LayoutNode
  walk(clone, (n) => {
    n.id = `${n.type}_${nanoid(8)}`
    if (n.type === 'tabs') {
      for (const item of n.items) item.id = `item_${nanoid(8)}`
      n.active = n.items[0]?.id ?? null
    }
  })
  return clone
}

function countItems(node: LayoutNode): number {
  let count = 0
  walkTabs(node, (tabs) => {
    count += tabs.items.length
  })
  return count
}

/** The group new 'tab' panes join; falls back to the first group when no
 * flag survives (pre-flag layout files, agent-written trees) */
function primaryTabs(node: LayoutNode): TabsNode {
  let found: TabsNode | null = null
  walkTabs(node, (tabs) => {
    if (!found && tabs.primary) found = tabs
  })
  return found ?? firstTabs(node)
}

/** Exactly one primary group per tree: the flag survives structural edits,
 * duplicates (agent-written) collapse to the first. When no flag exists
 * (pre-flag layout file, or the primary group was closed), promote the
 * group with the most terminals — the de-facto main group — over blind
 * tree order, which would crown a panel merely opened on the left. */
function ensurePrimary(node: LayoutNode): LayoutNode {
  let seen = false
  walkTabs(node, (tabs) => {
    if (tabs.primary) {
      if (seen) delete tabs.primary
      seen = true
    }
  })
  if (!seen) {
    let best: TabsNode | null = null
    let bestCount = -1
    walkTabs(node, (tabs) => {
      const count = tabs.items.filter((item) => item.block === 'terminal').length
      if (count > bestCount) {
        best = tabs
        bestCount = count
      }
    })
    ;(best ?? firstTabs(node)).primary = true
  }
  return node
}

function walk(node: LayoutNode, visit: (node: LayoutNode) => void): void {
  visit(node)
  if (node.type === 'split') node.children.forEach((child) => walk(child, visit))
}

function walkTabs(node: LayoutNode, visit: (tabs: TabsNode) => void): void {
  walk(node, (n) => {
    if (n.type === 'tabs') visit(n)
  })
}

function firstTabs(node: LayoutNode): TabsNode {
  if (node.type === 'tabs') return node
  return firstTabs(node.children[0])
}

function findParentSplit(node: LayoutNode, target: LayoutNode): SplitNode | null {
  if (node.type !== 'split') return null
  if (node.children.includes(target)) return node
  for (const child of node.children) {
    const found = findParentSplit(child, target)
    if (found) return found
  }
  return null
}

function findTabsContaining(node: LayoutNode, itemId: string): TabsNode | null {
  let found: TabsNode | null = null
  walkTabs(node, (tabs) => {
    if (tabs.items.some((item) => item.id === itemId)) found = tabs
  })
  return found
}

/** Drop empty tab groups and collapse single-child splits */
function normalize(node: LayoutNode): LayoutNode {
  if (node.type === 'tabs') return node
  const kept: { child: LayoutNode; ratio: number }[] = []
  node.children.forEach((rawChild, i) => {
    const child = normalize(rawChild)
    const empty = child.type === 'tabs' && child.items.length === 0
    if (!empty) kept.push({ child, ratio: node.ratios[i] ?? 1 / node.children.length })
  })
  if (kept.length === 0) return emptyTabs()
  if (kept.length === 1) return kept[0].child
  const total = kept.reduce((sum, k) => sum + k.ratio, 0)
  return {
    ...node,
    children: kept.map((k) => k.child),
    ratios: kept.map((k) => k.ratio / total)
  }
}

function validate(node: LayoutNode, depth = 0): void {
  if (depth > 16) throw new Error('Layout tree too deep')
  if (node.type === 'tabs') {
    if (!Array.isArray(node.items)) throw new Error('tabs.items must be an array')
    for (const item of node.items) {
      if (!item.id || !item.block) throw new Error('tab items need id and block')
    }
    return
  }
  if (node.type === 'split') {
    if (!Array.isArray(node.children) || node.children.length < 2) {
      throw new Error('split needs at least 2 children')
    }
    if (node.ratios.length !== node.children.length) {
      throw new Error('split.ratios must match children length')
    }
    node.children.forEach((child) => validate(child, depth + 1))
    return
  }
  throw new Error(`Unknown layout node type: ${(node as { type?: string }).type}`)
}
