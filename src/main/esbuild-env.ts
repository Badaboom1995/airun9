import { existsSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Must be imported BEFORE the esbuild module: esbuild snapshots
 * ESBUILD_BINARY_PATH when it loads. Packaged, its default resolution lands
 * inside app.asar, where the Go binary can't be spawned (spawn ENOTDIR) —
 * point it at the copy electron-builder unpacks next to the archive. In dev
 * the unpacked path doesn't exist and this is a no-op.
 */
if (!process.env.ESBUILD_BINARY_PATH) {
  const pkg = join(
    process.resourcesPath ?? '',
    'app.asar.unpacked',
    'node_modules',
    '@esbuild',
    `${process.platform}-${process.arch}`
  )
  const bin = process.platform === 'win32' ? join(pkg, 'esbuild.exe') : join(pkg, 'bin', 'esbuild')
  if (existsSync(bin)) process.env.ESBUILD_BINARY_PATH = bin
}
