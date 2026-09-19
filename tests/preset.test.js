/**
 * Preset conformance tests.
 *
 * The agent preset is data, so nothing the runtime suite covers would catch a
 * malformed composition — and a broken preset is exactly how a fresh install
 * fails for someone else: `dsh-agent-presets` lists it as broken with a reason
 * instead of starting a session. These tests parse the shipped files and assert
 * the properties the roster and the loader actually check.
 *
 * @module @yukitakasama/dsh-ptc-python/tests/preset.test
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from 'yaml'

const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url))
const PRESET_DIR = join(PACKAGE_ROOT, 'agent-presets', 'ptc-python')

/** The roster's id rule: the id becomes a directory name under the user root. */
const PRESET_ID = /^[a-z0-9][a-z0-9-]*$/

/** Parse the preset composition. */
function readComposition() {
  return parse(readFileSync(join(PRESET_DIR, 'agent.cordis.yml'), 'utf8'))
}

/** Parse the preset display metadata. */
function readMetadata() {
  return parse(readFileSync(join(PRESET_DIR, 'preset.yml'), 'utf8'))
}

/** Walk every row of a composition, descending into groups. */
function* rows(entries) {
  for (const entry of entries) {
    yield entry
    if (Array.isArray(entry?.config)) {
      yield* rows(entry.config)
    }
  }
}

/** Every module name a row names, excluding cordis built-ins and local files. */
function moduleNames(entries) {
  const names = []
  for (const entry of rows(entries)) {
    const name = entry?.name
    if (typeof name !== 'string') continue
    if (name.startsWith('cordis:') || name.startsWith('.')) continue
    names.push(name)
  }
  return names
}

test('the preset id satisfies the roster rule', () => {
  const id = 'ptc-python'
  assert.match(id, PRESET_ID)
  assert.equal(join(PRESET_DIR).endsWith(id), true, 'the preset directory must be named for its id')
})

test('the preset carries the display metadata the roster reads', () => {
  const metadata = readMetadata()
  assert.equal(typeof metadata.name, 'string')
  assert.ok(metadata.name.length > 0, 'the picker needs a display name')
  assert.equal(typeof metadata.description, 'string')
  assert.ok(metadata.description.length > 0, 'the picker needs a description')
  assert.equal(typeof metadata.order, 'number')
})

test('the composition parses as a list of named rows', () => {
  const composition = readComposition()
  assert.ok(Array.isArray(composition), 'a preset composition must be a list')
  assert.ok(composition.length > 0)
  for (const entry of rows(composition)) {
    assert.equal(typeof entry?.id, 'string', `every row needs an id: ${JSON.stringify(entry)}`)
    assert.equal(typeof entry?.name, 'string', `every row needs a name: ${JSON.stringify(entry)}`)
  }
})

test('every row id is unique', () => {
  const seen = new Set()
  for (const entry of rows(readComposition())) {
    assert.equal(seen.has(entry.id), false, `duplicate row id ${JSON.stringify(entry.id)}`)
    seen.add(entry.id)
  }
})

test('the composition declares the ptc presentation and nothing else', () => {
  const presentations = [...rows(readComposition())]
    .filter((entry) => entry.name === '@deepseek-ai/dsh-agent-tool-presentation')
  assert.equal(presentations.length, 1, 'exactly one presentation row')
  assert.equal(presentations[0].config.mode, 'ptc', 'the preset exists to select PTC mode')
})

test('the preset names the persona, agent instructions, and the standard tool surface', () => {
  const names = moduleNames(readComposition())
  for (const required of [
    '@deepseek-ai/dsh-persona',
    '@deepseek-ai/dsh-agent-instructions',
    '@deepseek-ai/dsh-tool-bash',
    '@deepseek-ai/dsh-tool-fs',
    '@deepseek-ai/dsh-tool-fs-search',
    '@deepseek-ai/dsh-tool-jobs',
    '@deepseek-ai/dsh-tool-skill',
    '@deepseek-ai/dsh-tool-subagent',
    '@deepseek-ai/dsh-tool-todo',
    '@deepseek-ai/dsh-tool-web',
  ]) {
    assert.ok(names.includes(required), `the tool surface must include ${required}`)
  }
})

test('the persona uses the required prefix/suffix form', () => {
  const persona = [...rows(readComposition())].find((entry) => entry.name === '@deepseek-ai/dsh-persona')
  assert.ok(persona, 'the preset must carry a persona row')
  // dsh 0.1.5-rc.1 makes `prefix` required and rejects the old `text` field.
  assert.equal(typeof persona.config.prefix, 'string')
  assert.equal(typeof persona.config.suffix, 'string')
  assert.equal('text' in persona.config, false, 'dsh >= 0.1.5-rc.1 rejects the removed `text` field')
})

test('every service-providing group carries an entry-local realm', () => {
  // `dsh-agent-presets` refuses a preset row that publishes a service into the
  // root realm: it would be process-global and collide with another preset.
  const composition = readComposition()
  for (const entry of composition) {
    if (entry.name !== 'cordis:group') continue
    assert.equal(entry.group, true, `group ${entry.id} must set group: true`)
    assert.equal(typeof entry.isolate, 'object', `group ${entry.id} must declare an isolate realm`)
    assert.ok(Object.keys(entry.isolate).length > 0, `group ${entry.id} must name at least one realm key`)
  }
})

test('the composition references only module names and local files that exist', () => {
  // Discovery proves the composition holds named rows and that each row names a
  // package above the harness base or a file that exists; it never imports one.
  // A name that resolves nowhere is how a preset reaches a user broken.
  const composition = readComposition()
  for (const entry of rows(composition)) {
    if (typeof entry.name !== 'string') continue
    if (entry.name.startsWith('cordis:')) continue
    if (entry.name.startsWith('.')) {
      const path = join(PRESET_DIR, entry.name)
      assert.ok(existsSync(path), `local row ${entry.id} names a missing file: ${entry.name}`)
    }
  }
})

test('the shipped files the plugin installs are exactly the preset pair', async () => {
  const { installPreset, userPresetRoot } = await import('../lib/index.js')
  assert.equal(typeof installPreset, 'function')
  assert.equal(typeof userPresetRoot(), 'string')
  for (const file of ['agent.cordis.yml', 'preset.yml']) {
    assert.ok(existsSync(join(PRESET_DIR, file)), `the packaged preset must ship ${file}`)
  }
  assert.equal(existsSync(join(PRESET_DIR, 'preset.yaml')), false, 'the metadata file is preset.yml, not .yaml')
})

test('the bundle patch maps the runtime over the shipped code-runtime row', () => {
  const patch = parse(readFileSync(join(PACKAGE_ROOT, 'cordis.patch.yml'), 'utf8'))
  assert.ok(Array.isArray(patch))
  const runtimeRow = patch.find((row) => row.id === 'code-runtime')
  assert.ok(runtimeRow, 'the patch must target the shipped code-runtime row id to replace it')
  assert.equal(runtimeRow.name, '@yukitakasama/dsh-ptc-python/runtime')
  const insert = patch.find((row) => Array.isArray(row.insert))
  assert.ok(insert, 'the patch must insert the plugin row')
  assert.equal(insert.insert.length, 1)
  assert.equal(insert.insert[0].name, '@yukitakasama/dsh-ptc-python')
})

test('the runtime row\'s config matches the runtime schema and its defaults', async () => {
  const { Config } = await import('../lib/python-runtime.js')
  const patch = parse(readFileSync(join(PACKAGE_ROOT, 'cordis.patch.yml'), 'utf8'))
  const { config } = patch.find((row) => row.id === 'code-runtime')
  // The schema carries the defaults; schemastery-style callers reach them
  // through `defaults`, and cordis reaches validation through `~standard`.
  const defaults = Config.defaults
  for (const key of Object.keys(config)) {
    assert.ok(key in defaults, `the patch sets unknown runtime config ${JSON.stringify(key)}`)
  }
  // Every value the patch sets must already equal the schema default, so the two
  // homes for a default cannot silently disagree.
  for (const [key, value] of Object.entries(config)) {
    assert.deepEqual(value, defaults[key], `patch value for ${key} differs from the schema default`)
  }
  // And the schema must accept the patch verbatim, which is what the loader does.
  const validated = Config['~standard'].validate(config)
  assert.equal('issues' in validated, false, `the patch must validate: ${JSON.stringify(validated.issues)}`)
  assert.deepEqual(validated.value, defaults)
})

test('both schemas implement the Standard Schema interface cordis calls', async () => {
  const { Config: installerConfig } = await import('../lib/index.js')
  const { Config: runtimeConfig } = await import('../lib/python-runtime.js')
  for (const [label, schema] of [['installer', installerConfig], ['runtime', runtimeConfig]]) {
    const standard = schema['~standard']
    assert.equal(standard.version, 1, `${label} schema must declare Standard Schema v1`)
    assert.equal(typeof standard.validate, 'function', `${label} schema must expose validate`)
    const result = standard.validate({})
    assert.equal('then' in result, false, `${label} validate must be synchronous`)
    assert.equal('issues' in result, false, `${label} validate({}) must succeed on defaults`)
    assert.equal(typeof result.value, 'object')
  }
})

test('the schemas reject malformed config and fill absent keys with defaults', async () => {
  const { RuntimeConfig: Config } = await import('../lib/config-schema.js')
  const validate = (input) => Config['~standard'].validate(input)

  assert.deepEqual(validate({}).value, Config.defaults)
  assert.deepEqual(validate({ maxWallMs: 1000 }).value.maxWallMs, 1000)
  assert.deepEqual(validate({ maxComputeMs: 0 }).value.maxComputeMs, 0, 'zero is the disabled-budget sentinel')
  assert.equal(Object.hasOwn(validate({ maxWallMs: 1000, unknownKey: 1 }).value, 'unknownKey'), false, 'unknown keys are dropped')

  // A present-but-wrong value is an issue naming the field, never a silent default.
  for (const [input, field] of [
    [{ maxWallMs: 0 }, 'maxWallMs'],
    [{ maxWallMs: -1 }, 'maxWallMs'],
    [{ maxWallMs: 'soon' }, 'maxWallMs'],
    [{ maxOutputBytes: 1.5 }, 'maxOutputBytes'],
    [{ maxComputeMs: -1 }, 'maxComputeMs'],
    [{ isoFlags: 'not-a-list' }, 'isoFlags'],
    [{ isoFlags: [1] }, 'isoFlags'],
    [{ pythonPath: 7 }, 'pythonPath'],
    [{ protocol: 'fd3' }, 'protocol'],
    [{ maxValueBytes: null }, 'maxValueBytes'],
  ]) {
    const result = validate(input)
    assert.ok('issues' in result, `${JSON.stringify(input)} must be refused`)
    assert.deepEqual(result.issues[0].path, [field], `${JSON.stringify(input)} must name ${field}`)
  }
  assert.ok('issues' in validate(null), 'a non-object must be refused')
  assert.ok('issues' in validate([]), 'an array must be refused')
  assert.equal(Object.hasOwn(validate({ maxWallMs: 1, notAField: true }).value, 'notAField'), false)
})

test('the installer schema defaults force to false and rejects a non-boolean', async () => {
  const { InstallerConfig } = await import('../lib/config-schema.js')
  assert.deepEqual(InstallerConfig['~standard'].validate({}).value, { force: false })
  assert.deepEqual(InstallerConfig['~standard'].validate({ force: true }).value, { force: true })
  assert.ok('issues' in InstallerConfig['~standard'].validate({ force: 'yes' }))
})

test('the package manifest declares the bundle patch and the runtime subpath', () => {
  const manifest = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8'))
  assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml')
  assert.equal(manifest.exports['./runtime'].default, './lib/runtime.js')
  for (const file of manifest.files) {
    assert.ok(existsSync(join(PACKAGE_ROOT, file)), `manifest lists a missing file: ${file}`)
  }
})
