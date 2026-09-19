/**
 * dsh-ptc-python host plugin: installs the `ptc-python` agent preset.
 *
 * This entry owns ONE responsibility — copying the packaged preset into the
 * user preset root so the roster can list it. The `ctx.codeRuntime` service the
 * preset's `mode: ptc` row injects is mounted by the sibling `./runtime` entry,
 * which the bundle patch maps over the shipped `code-runtime` row. Keeping the
 * two on separate rows is what stops either from being mounted twice: a package
 * referenced by two rows would be two registrations, and `ctx.provide` refuses a
 * second one for the same service name.
 *
 * Installation is idempotent: when the preset already exists at the target, the
 * row logs a note and returns — unless `force: true` is configured, in which
 * case the packaged preset files overwrite the installed ones (any extra local
 * files are kept).
 *
 * @module @yukitakasama/dsh-ptc-python
 */

import { cpSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { InstallerConfig } from './config-schema.js'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'dsh-ptc-python'

/** The preset id this plugin installs. */
const PRESET_ID = 'ptc-python'

/** Package-local preset source directory. */
const SOURCE_DIR = fileURLToPath(new URL('../agent-presets/ptc-python/', import.meta.url))

/** The packaged preset files that define the preset. */
const PRESET_FILES = ['agent.cordis.yml', 'preset.yml']

/**
 * The row's config. `force` is the only knob: every runtime cap belongs to the
 * `code-runtime` row's own schema.
 */
export const Config = InstallerConfig

/** The user preset root: `${DSH_HOME:-~/.dsh}/.agent-presets`. */
export function userPresetRoot() {
  const home = process.env.DSH_HOME !== undefined && process.env.DSH_HOME !== ''
    ? process.env.DSH_HOME
    : join(homedir(), '.dsh')
  return join(home, '.agent-presets')
}

/**
 * Install the packaged preset into the user preset root.
 * @param force - whether to overwrite an existing installation.
 * @returns the directory the preset was installed into.
 */
export function installPreset(force) {
  const targetDir = join(userPresetRoot(), PRESET_ID)
  const alreadyInstalled = PRESET_FILES.every((file) => existsSync(join(targetDir, file)))

  if (alreadyInstalled && !force) {
    const outOfDate = PRESET_FILES.some((file) => !filesEqual(join(SOURCE_DIR, file), join(targetDir, file)))
    console.log(
      `[${name}] preset "${PRESET_ID}" already installed at ${targetDir}`
      + (outOfDate
        ? '; packaged files differ — set `force: true` in the plugin row config to overwrite'
        : ''),
    )
    return targetDir
  }

  mkdirSync(targetDir, { recursive: true })
  for (const file of PRESET_FILES) {
    cpSync(join(SOURCE_DIR, file), join(targetDir, file), { force: true })
  }
  console.log(`[${name}] installed preset "${PRESET_ID}" -> ${targetDir}`)
  return targetDir
}

/**
 * Install the packaged preset on boot.
 * @param ctx - the row's context; the installer is a pure filesystem effect and
 *   registers nothing on it.
 * @param config - the validated row config.
 */
export function apply(ctx, config) {
  installPreset(config.force)
}

/** Byte-compare two files; false when either is unreadable. */
function filesEqual(a, b) {
  try {
    return readFileSync(a).equals(readFileSync(b))
  } catch {
    return false
  }
}
