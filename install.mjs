#!/usr/bin/env node
/**
 * Source-tree installer for `dsh-ptc-python`.
 *
 * Use this instead of `dsh plugin add` when the checkout is already on disk: it
 * performs the same three effects the bundle patch would, without a network
 * round trip or a pnpm install:
 *
 *   1. copy the packaged `ptc-python` preset into `<DSH_HOME>/.agent-presets/`;
 *   2. copy this package into `<DSH_HOME>/profiles/<profile>/node_modules/`;
 *   3. add the plugin's bundle entry to that profile's `package.json` so the
 *      loader applies `cordis.patch.yml`.
 *
 * Flags:
 *   --home DIR     DSH home (default: $DSH_HOME, else ~/.dsh)
 *   --profile NAME profile to install into (default: web)
 *   --force        overwrite an existing preset installation
 *   --dry-run      print what would happen, change nothing
 *
 * @module dsh-ptc-python/install
 */

import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const PACKAGE_JSON = 'package.json'
const BUNDLE_NAME = '@yukitakasama/dsh-ptc-python'
const PRESET_ID = 'ptc-python'
const PRESET_FILES = ['agent.cordis.yml', 'preset.yml']
const RUNTIME_MODULE = 'lib/runtime.js'
const BOOTSTRAP_MODULE = 'py/dsh_bootstrap.py'

const here = dirname(fileURLToPath(import.meta.url))

/** Parse the command line into options. */
function parseArgs(argv) {
  const options = { home: undefined, profile: 'web', force: false, dryRun: false }
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    switch (arg) {
      case '--home':
      case '--dir':
        options.home = argv[++index]
        break
      case '--profile':
        options.profile = argv[++index]
        break
      case '--force':
        options.force = true
        break
      case '--dry-run':
        options.dryRun = true
        break
      case '--help':
      case '-h':
        options.help = true
        break
      default:
        console.error(`install.mjs: unknown option ${JSON.stringify(arg)} (try --help)`)
        process.exit(2)
    }
  }
  return options
}

const USAGE = `dsh-ptc-python source installer

  node install.mjs [--home DIR] [--profile NAME] [--force] [--dry-run]

  --home DIR      DSH home directory (default: $DSH_HOME, else ~/.dsh)
  --profile NAME  profile to install into (default: web)
  --force         overwrite an existing preset installation
  --dry-run       print the plan without changing anything
`

const options = parseArgs(process.argv.slice(2))
if (options.help) {
  process.stdout.write(USAGE)
  process.exit(0)
}

const home = resolve(options.home ?? process.env.DSH_HOME ?? join(homedir(), '.dsh'))
const presetRoot = join(home, '.agent-presets')
const presetTarget = join(presetRoot, PRESET_ID)
const profileDir = join(home, 'profiles', options.profile)
const profileManifestPath = join(profileDir, PACKAGE_JSON)

const plan = []
const problems = []

if (!existsSync(profileDir)) problems.push(`profile directory not found: ${profileDir}`)
for (const required of ['package.json', RUNTIME_MODULE, BOOTSTRAP_MODULE, ...PRESET_FILES.map((file) => join('agent-presets', PRESET_ID, file))]) {
  if (!existsSync(join(here, required))) problems.push(`package is missing ${required}`)
}

plan.push(`install preset -> ${presetTarget}`)
plan.push(`copy package   -> ${join(profileDir, 'node_modules', BUNDLE_NAME)}`)
plan.push(`register bundle ${BUNDLE_NAME} in ${profileManifestPath}`)

if (problems.length > 0) {
  console.error('install.mjs: cannot continue:')
  for (const problem of problems) console.error(`  - ${problem}`)
  process.exit(1)
}

console.log(`dsh home:  ${home}`)
console.log(`profile:   ${options.profile}`)
for (const step of plan) console.log(`  - ${step}`)
if (options.dryRun) {
  console.log('dry run: nothing was changed')
  process.exit(0)
}

// 1. The preset. `force` mirrors the plugin row's own switch.
const presetInstalled = PRESET_FILES.every((file) => existsSync(join(presetTarget, file)))
if (presetInstalled && !options.force) {
  console.log(`preset already installed at ${presetTarget} (pass --force to overwrite)`)
} else {
  mkdirSync(presetTarget, { recursive: true })
  for (const file of PRESET_FILES) {
    cpSync(join(here, 'agent-presets', PRESET_ID, file), join(presetTarget, file), { force: true })
  }
  console.log(`installed preset -> ${presetTarget}`)
}

// 2. The package itself, into the profile's node_modules so the loader's bare
//    module name resolves to it.
const packageTarget = join(profileDir, 'node_modules', BUNDLE_NAME)
rmSync(packageTarget, { recursive: true, force: true })
mkdirSync(dirname(packageTarget), { recursive: true })
cpSync(here, packageTarget, {
  recursive: true,
  filter: (source) => !/[/\\](node_modules|\.git|__pycache__)([/\\]|$)/.test(source),
})
console.log(`copied package -> ${packageTarget}`)

// 3. The bundle registration, which is what makes the loader apply the patch.
const manifest = JSON.parse(readFileSync(profileManifestPath, 'utf8'))
manifest.dsh ??= {}
manifest.dsh.profile ??= {}
const bundles = manifest.dsh.profile.bundles ?? []
if (!bundles.includes(BUNDLE_NAME)) {
  bundles.push(BUNDLE_NAME)
  manifest.dsh.profile.bundles = bundles
  writeFileSync(profileManifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  console.log(`registered ${BUNDLE_NAME} in ${profileManifestPath}`)
} else {
  console.log(`${BUNDLE_NAME} already registered in ${profileManifestPath}`)
}

console.log('')
console.log('Restart DSH, then pick "PTC Python 模式" (PTC Python mode) when creating a session.')
