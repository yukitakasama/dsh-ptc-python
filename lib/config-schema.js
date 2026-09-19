/**
 * Config schemas for the plugin's two rows, built on the Standard Schema
 * interface that cordis actually consumes.
 *
 * Cordis resolves a plugin's config through `runtime.Config['~standard'].validate(raw)`
 * (see its `resolveConfig`), so a schema is any object exposing that one method —
 * it does not have to come from a schema library. Building it here keeps the
 * plugin free of a `schemastery` import, which matters because the alternative
 * is worse than it looks:
 *
 *   - `@deepseek-ai/schemastery` is a peer of the ecosystem's profile plugins, and
 *     pnpm's hoisted linker only lifts it to `<profile>/node_modules` when enough
 *     other plugins declare it. On a fresh profile it is absent, and a plugin that
 *     imports it fails to load with `ERR_MODULE_NOT_FOUND` before it can do
 *     anything — the worst possible failure for an installable plugin.
 *   - Declaring it as a regular dependency would nest a second copy of a package
 *     the profile's `.npmrc` says must come from the CLI dependency tree.
 *
 * `~standard` is Standard Schema v1: `validate` returns `{ value }` on success or
 * `{ issues }` on failure, and must not be async (cordis throws on a thenable).
 *
 * @module @yukitakasama/dsh-ptc-python/lib/config-schema
 */

/**
 * One field's validator: a `read` that returns a result, with `undefined`
 * meaning "this value is acceptable", for fields that need no normalization.
 */
const ok = { ok: true, value: undefined }

/** Build a successful result for `value`. */
function accept(value) {
  return { ok: true, value }
}

/** Build a failure result naming the offending path. */
function reject(path, message) {
  return { ok: false, issue: { message, path: [path] } }
}

/** A string field with an optional default. */
function stringField(defaultValue) {
  return {
    read: (value) => (typeof value === 'string' ? accept(value) : reject('', 'Expected string')),
    default: defaultValue,
  }
}

/**
 * A positive-number field. Zero is permitted only where `allowZero` is set, and
 * negative zero is always refused: it would collide with `0` once serialized.
 */
function numberField(defaultValue, options = {}) {
  return {
    read: (value) => {
      if (typeof value !== 'number' || !Number.isFinite(value)) return reject('', 'Expected number')
      if (Object.is(value, -0)) return reject('', 'Expected a number, not negative zero')
      if (value < 0) return reject('', 'Expected a non-negative number')
      if (value === 0 && options.allowZero !== true) return reject('', 'Expected a positive number')
      return accept(value)
    },
    default: defaultValue,
  }
}

/** A byte-count field, which must additionally be a safe integer. */
function byteField(defaultValue) {
  const inner = numberField(defaultValue)
  return {
    read: (value) => {
      const result = inner.read(value)
      if (!result.ok) return result
      const number = result.value === undefined ? value : result.value
      if (!Number.isSafeInteger(number)) return reject('', 'Expected a safe integer')
      return accept(number)
    },
    default: defaultValue,
  }
}

/** A boolean field with a default. */
function booleanField(defaultValue) {
  return {
    read: (value) => (typeof value === 'boolean' ? accept(value) : reject('', 'Expected boolean')),
    default: defaultValue,
  }
}

/** An array-of-strings field with a default. */
function stringArrayField(defaultValue) {
  return {
    read: (value) => {
      if (!Array.isArray(value)) return reject('', 'Expected an array')
      for (const item of value) {
        if (typeof item !== 'string') return reject('', 'Expected every element to be a string')
      }
      return accept([...value])
    },
    default: defaultValue,
  }
}

/** A field restricted to one literal value. */
function literalField(allowed, defaultValue) {
  return {
    read: (value) => (value === allowed
      ? accept(value)
      : reject('', `Expected ${JSON.stringify(allowed)}`)),
    default: defaultValue,
  }
}

/**
 * Build a Standard Schema object from a field table.
 *
 * Defaults apply only to a value that is ABSENT (`undefined`), never to `null`:
 * a caller that explicitly passed `null` gets a type error, because silently
 * replacing it would hide a real configuration mistake.
 * @param fields - field name to validator.
 * @returns the schema object, carrying every defaulted value in `defaults`.
 */
export function makeSchema(fields) {
  const defaults = {}
  for (const [name, field] of Object.entries(fields)) {
    defaults[name] = field.default
  }

  const validate = (input) => {
    if (typeof input !== 'object' || input === null || Array.isArray(input)) {
      return { issues: [{ message: 'Expected an object', path: [] }] }
    }
    const value = {}
    for (const [name, field] of Object.entries(fields)) {
      const raw = Object.hasOwn(input, name) ? input[name] : undefined
      if (raw === undefined) {
        // An absent key takes the default (possibly `undefined`, for a field
        // that has none); a present key must satisfy its validator.
        if (field.default !== undefined) value[name] = field.default
        continue
      }
      const result = field.read(raw)
      if (!result.ok) {
        return { issues: [{ message: result.issue.message, path: [name] }] }
      }
      value[name] = result.value === undefined ? raw : result.value
    }
    // Unknown keys are dropped rather than rejected, matching how a schema
    // library projects its declared fields.
    return { value }
  }

  return { '~standard': { version: 1, vendor: 'dsh-ptc-python', validate }, defaults }
}

/** The installer row's config. */
export const InstallerConfig = makeSchema({
  force: booleanField(false),
})

/**
 * The `code-runtime` row's config: every execution cap this backend enforces.
 * The table is the single source of truth for the defaults — `cordis.patch.yml`
 * restates them, and `tests/preset.test.js` asserts the two agree.
 */
export const RuntimeConfig = makeSchema({
  pythonPath: stringField(''),
  isoFlags: stringArrayField(['-I']),
  maxWallMs: numberField(300_000),
  maxComputeMs: numberField(0, { allowZero: true }),
  maxOutputBytes: byteField(67_108_864),
  maxFrameBytes: byteField(8_388_608),
  cpuSeconds: numberField(60),
  addressSpaceBytes: byteField(2_147_483_648),
  maxLogBytes: byteField(1_048_576),
  maxValueBytes: byteField(4_194_304),
  bootTimeoutMs: numberField(30_000),
  protocol: literalField('stdin-stdout', 'stdin-stdout'),
})
