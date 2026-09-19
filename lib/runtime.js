/**
 * `dsh-ptc-python/runtime` — the profile-level row that mounts the CPython code
 * runtime as `ctx.codeRuntime`.
 *
 * The bundle patch maps this entry over the shipped `code-runtime` row, so
 * mounting the plugin REPLACES the TypeScript worker backend rather than adding
 * a second runtime. That is required, not incidental: `ctx.codeRuntime` is a
 * single host-plane service, one process serves one language, and `dsh-tools`
 * PTC mode reads `codeRuntime.language` to decide which `run_code` schema and
 * which SDK block the model sees.
 *
 * @module @yukitakasama/dsh-ptc-python/runtime
 */

import { fileURLToPath } from 'node:url'
import { Config, PythonCodeRuntime, defaultPythonPath } from './python-runtime.js'

export { Config }

/** Cordis plugin name used by loader diagnostics. */
export const name = 'dsh-ptc-python-runtime'

/**
 * The bundled Python bootstrap, resolved from this module's own URL so the row
 * works wherever the package is installed.
 */
export const bootstrapPath = fileURLToPath(new URL('../py/dsh_bootstrap.py', import.meta.url))

/**
 * Mount the CPython runtime.
 * @param ctx - the row's context; the service registration unwinds with it.
 * @param config - the validated cap set.
 * @returns the registered runtime.
 */
export function apply(ctx, config) {
  const executable = config.pythonPath !== '' ? config.pythonPath : defaultPythonPath()
  if (executable === undefined) {
    console.warn(
      `[${name}] no Python interpreter found on PATH or in DSH_PYTHON; the ptc-python preset will report it at its first run_code. `
      + 'Set `runtime.pythonPath` on the code-runtime row to pin one now.',
    )
  } else {
    console.log(`[${name}] python code runtime -> ${executable} (language "python", isolation "process")`)
  }
  return new PythonCodeRuntime(ctx, config, { bootstrapPath, executable })
}

export default apply
