import { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebglAddon } from '@xterm/addon-webgl'
import '@xterm/xterm/css/xterm.css'
import type { TerminalDataEvent } from '../../../shared/types'
import { api, events } from '../lib/api'

const THEME = {
  background: '#0b0e0c',
  foreground: '#d6d8d6',
  cursor: '#d6d8d6',
  cursorAccent: '#0b0e0c',
  selectionBackground: 'rgba(255, 255, 255, 0.22)',
  black: '#1c1f1d',
  red: '#e06c75',
  green: '#98c379',
  yellow: '#e5c07b',
  blue: '#61afef',
  magenta: '#c678dd',
  cyan: '#56b6c2',
  white: '#d6d8d6',
  brightBlack: '#5c6370',
  brightRed: '#ef7680',
  brightGreen: '#a5d283',
  brightYellow: '#f0ca85',
  brightBlue: '#6fb9f5',
  brightMagenta: '#d182e3',
  brightCyan: '#63c5d0',
  brightWhite: '#f0f0f0'
}

interface TerminalViewProps {
  id: string
  active: boolean
}

function TerminalView({ id, active }: TerminalViewProps): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const term = new Terminal({
      theme: THEME,
      fontSize: 13,
      fontFamily: 'SF Mono, Menlo, ui-monospace, monospace',
      lineHeight: 1.25,
      cursorBlink: true,
      scrollback: 10_000,
      macOptionIsMeta: true,
      allowProposedApi: true
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(container)
    try {
      term.loadAddon(new WebglAddon())
    } catch {
      // WebGL unavailable — the DOM renderer is a fine fallback
    }
    termRef.current = term
    fitRef.current = fit

    // Replay protocol: buffer live events until the snapshot lands, then
    // apply only what the snapshot doesn't already contain (seq ordering).
    let snapshotSeq: number | null = null
    const queued: TerminalDataEvent[] = []

    const offData = events.onTerminalData((event) => {
      if (event.id !== id) return
      if (snapshotSeq === null) queued.push(event)
      else if (event.seq > snapshotSeq) term.write(event.data)
    })

    const offExit = events.onTerminalExit((event) => {
      if (event.id !== id) return
      term.write(`\r\n\x1b[2m[process exited with code ${event.exitCode}]\x1b[0m\r\n`)
    })

    let disposed = false
    void api.snapshotTerminal(id).then((snapshot) => {
      if (disposed) return
      if (snapshot.data) term.write(snapshot.data)
      for (const event of queued) {
        if (event.seq > snapshot.seq) term.write(event.data)
      }
      queued.length = 0
      snapshotSeq = snapshot.seq
      fit.fit()
    })

    const onDataDisposable = term.onData((data) => void api.writeTerminal(id, data))
    const onResizeDisposable = term.onResize(({ cols, rows }) => {
      void api.resizeTerminal(id, cols, rows)
    })

    const resizeObserver = new ResizeObserver(() => {
      if (container.clientWidth > 0 && container.clientHeight > 0) fit.fit()
    })
    resizeObserver.observe(container)

    return () => {
      disposed = true
      offData()
      offExit()
      onDataDisposable.dispose()
      onResizeDisposable.dispose()
      resizeObserver.disconnect()
      term.dispose()
      termRef.current = null
      fitRef.current = null
    }
  }, [id])

  useEffect(() => {
    if (active) {
      fitRef.current?.fit()
      termRef.current?.focus()
    }
  }, [active])

  return (
    <div className={active ? 'absolute inset-0 px-3 py-2' : 'hidden'}>
      <div ref={containerRef} className="h-full w-full" />
    </div>
  )
}

export default TerminalView
