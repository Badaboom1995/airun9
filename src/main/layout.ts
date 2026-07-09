import { EventEmitter } from 'node:events'
import { nanoid } from 'nanoid'
import type { LayoutNode, LayoutTabItem, PanePosition, TabsNode } from '../shared/types'

/**
 * Owns the single global layout (ADR-0001/0002): a split tree with tab-group
 * leaves. The renderer renders it, users and agents mutate it through the
 * API. In-memory for now; persistence arrives with the storage step.
 */
export class LayoutManager extends EventEmitter {
  private root: LayoutNode = emptyTabs()

  get(): LayoutNode {
    return this.root
  }

  set(node: LayoutNode): LayoutNode {
    validate(node)
    assignIds(node)
    this.root = normalize(node)
    this.changed()
    return this.root
  }

  /** Add a block instance; 'tab' joins the first tab group, right/down split the root */
  addItem(
    item: Omit<LayoutTabItem, 'id'>,
    position: PanePosition = 'tab',
    activate = true
  ): LayoutTabItem {
    const full: LayoutTabItem = { ...item, id: `item_${nanoid(8)}` }
    if (position === 'tab') {
      const tabs = firstTabs(this.root)
      tabs.items.push(full)
      if (activate || tabs.items.length === 1) tabs.active = full.id
    } else {
      const leaf: TabsNode = {
        type: 'tabs',
        id: `tabs_${nanoid(8)}`,
        active: full.id,
        items: [full]
      }
      this.root = {
        type: 'split',
        id: `split_${nanoid(8)}`,
        direction: position === 'right' ? 'row' : 'column',
        ratios: [0.65, 0.35],
        children: [this.root, leaf]
      }
    }
    this.changed()
    return full
  }

  removeItem(itemId: string): void {
    this.removeWhere((item) => item.id === itemId)
  }

  removeWhere(predicate: (item: LayoutTabItem) => boolean): void {
    let removed = false
    walkTabs(this.root, (tabs) => {
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
      this.root = normalize(this.root)
      this.changed()
    }
  }

  setActive(tabsId: string, itemId: string): void {
    let found = false
    walkTabs(this.root, (tabs) => {
      if (tabs.id === tabsId && tabs.items.some((i) => i.id === itemId)) {
        tabs.active = itemId
        found = true
      }
    })
    if (!found) throw new Error(`Unknown tab ${itemId} in group ${tabsId}`)
    this.changed()
  }

  setRatios(splitId: string, ratios: number[]): void {
    let found = false
    walk(this.root, (node) => {
      if (node.type === 'split' && node.id === splitId && node.ratios.length === ratios.length) {
        node.ratios = ratios
        found = true
      }
    })
    if (!found) throw new Error(`Unknown split: ${splitId}`)
    this.changed()
  }

  private changed(): void {
    this.emit('changed', this.root)
  }
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
  return { type: 'tabs', id: `tabs_${nanoid(8)}`, active: null, items: [] }
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
