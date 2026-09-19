/**
 * Lossless-JSON helpers for the fd-3 code-runtime wire.
 *
 * The seam's `CodeJsonValue` is depth-unbounded, so neither encoding nor
 * validation may recurse: `JSON.stringify` throws `RangeError` a few thousand
 * levels deep, and a hostile fd-3 frame is subject to no depth limit at all.
 * Every traversal here is iterative over an explicit stack.
 *
 * @module @yukitakasama/dsh-ptc-python/lib/json-wire
 */

/**
 * Exact UTF-8 byte length of one string's compact JSON form (quotes + escapes),
 * computed by a single non-allocating scan that stops the instant the running
 * total exceeds `maxBytes`. Mirrors what `JSON.stringify` emits: `"` and `\` and
 * the five short C0 escapes cost 2, other C0 controls `\uXXXX` cost 6, a valid
 * surrogate pair is one astral code point at 4 raw UTF-8 bytes, a LONE surrogate
 * becomes `\uXXXX` at 6, and any other code point costs its raw UTF-8 width.
 * @param text - the string to meter.
 * @param maxBytes - largest serialized size the caller can still admit.
 * @returns the exact serialized byte length, or `undefined` once it exceeds `maxBytes`.
 */
export function jsonStringBytesUpTo(text, maxBytes) {
  let bytes = 2 // the two quotes
  if (bytes > maxBytes) return undefined
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index)
    if (code === 0x22 || code === 0x5c || code === 0x08 || code === 0x09 || code === 0x0a || code === 0x0c || code === 0x0d) {
      bytes += 2
    } else if (code < 0x20) {
      bytes += 6
    } else if (code < 0x80) {
      bytes += 1
    } else if (code < 0x800) {
      bytes += 2
    } else if (code >= 0xd800 && code <= 0xdbff && index + 1 < text.length) {
      const next = text.charCodeAt(index + 1)
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4
        index++
      } else {
        bytes += 6
      }
    } else if (code >= 0xd800 && code <= 0xdfff) {
      bytes += 6
    } else {
      bytes += 3
    }
    if (bytes > maxBytes) return undefined
  }
  return bytes
}

/**
 * One scalar (null, boolean, finite number) as JSON text. A beyond-safe-range
 * integral double needs BigInt digits: `String(2 ** 60)` emits the ROUNDED
 * `...847000` form, and echoing that to the child would silently change the
 * integer the seam promised to carry losslessly.
 * @param value - a JSON-plain scalar.
 * @returns its JSON encoding.
 */
function scalarJson(value) {
  if (typeof value === 'number' && Number.isInteger(value) && !Number.isSafeInteger(value)) {
    return BigInt(value).toString()
  }
  return String(value)
}

/**
 * Serialize one JSON-parse-produced value without recursion. Callers must pass
 * a JSON-plain value (`null`, finite numbers, booleans, strings, dense arrays,
 * plain objects); this encoder validates nothing.
 * @param value - a JSON-plain value.
 * @returns the compact JSON encoding.
 */
export function encodeJsonPlain(value) {
  const chunks = []
  const tasks = [{ value }]
  for (let task = tasks.pop(); task !== undefined; task = tasks.pop()) {
    if ('text' in task) {
      chunks.push(task.text)
      continue
    }
    const current = task.value
    if (typeof current === 'string') {
      chunks.push(JSON.stringify(current))
    } else if (Array.isArray(current)) {
      chunks.push('[')
      tasks.push({ text: ']' })
      for (let index = current.length - 1; index >= 0; index--) {
        if (index < current.length - 1) tasks.push({ text: ',' })
        tasks.push({ value: current[index] })
      }
    } else if (typeof current === 'object' && current !== null) {
      const record = current
      chunks.push('{')
      tasks.push({ text: '}' })
      const keys = Object.keys(record)
      for (let index = keys.length - 1; index >= 0; index--) {
        const key = keys[index]
        if (index < keys.length - 1) tasks.push({ text: ',' })
        tasks.push({ value: record[key] })
        tasks.push({ text: `${JSON.stringify(key)}:` })
      }
    } else {
      chunks.push(scalarJson(current))
    }
  }
  return chunks.join('')
}

/**
 * Meter a JSON-parse-produced value's compact-JSON byte length AND its number
 * losslessness in one traversal, stopping the instant `maxBytes` is crossed.
 * Rejection happens BEFORE a string's escaped copy is materialized or an
 * array's/object's children are enqueued, so a forged frame within the inbound
 * byte cap cannot force those secondary allocations.
 * @param value - a JSON-plain value.
 * @param maxBytes - the completion-value budget in bytes.
 * @returns `{ ok: true, bytes }`, or `{ ok: false, reason }` where reason is
 *   `'over-budget'` or `'non-lossless'`; over-budget wins when both apply.
 */
export function checkDoneValue(value, maxBytes) {
  let bytes = 0
  let nonLossless = false
  const stack = [value]
  while (stack.length > 0) {
    const current = stack.pop()
    if (typeof current === 'number') {
      if (!Number.isFinite(current) || Object.is(current, -0)) nonLossless = true
      bytes += Buffer.byteLength(scalarJson(current), 'utf8')
    } else if (typeof current === 'string') {
      const stringBytes = jsonStringBytesUpTo(current, maxBytes - bytes)
      if (stringBytes === undefined) return { ok: false, reason: 'over-budget' }
      bytes += stringBytes
    } else if (Array.isArray(current)) {
      bytes += 2 + (current.length > 1 ? current.length - 1 : 0)
      if (bytes + current.length > maxBytes) return { ok: false, reason: 'over-budget' }
      for (const item of current) stack.push(item)
    } else if (typeof current === 'object' && current !== null) {
      const record = current
      let count = 0
      for (const key in record) if (Object.hasOwn(record, key)) count += 1
      bytes += 2 + (count > 1 ? count - 1 : 0)
      if (bytes + count * 4 > maxBytes) return { ok: false, reason: 'over-budget' }
      for (const key in record) {
        if (!Object.hasOwn(record, key)) continue
        const keyBytes = jsonStringBytesUpTo(key, maxBytes - bytes)
        if (keyBytes === undefined) return { ok: false, reason: 'over-budget' }
        bytes += keyBytes + 1
        stack.push(record[key])
      }
    } else {
      bytes += Buffer.byteLength(scalarJson(current), 'utf8')
    }
    if (bytes > maxBytes) return { ok: false, reason: 'over-budget' }
  }
  if (nonLossless) return { ok: false, reason: 'non-lossless' }
  return { ok: true, bytes }
}

/**
 * Lazily yield one plain object's own enumerable property values. A generator
 * rather than `Object.values` so a wide object does not cost a second
 * full-breadth copy before a single value is examined.
 * @param record - a JSON-parse-produced object.
 * @yields each own enumerable property value, in key order.
 */
function* ownValues(record) {
  for (const key in record) {
    if (Object.hasOwn(record, key)) yield record[key]
  }
}

/**
 * Whether a JSON-parse-produced value contains a number outside lossless JSON:
 * non-finite (`1e400` parses to `Infinity`) or negative zero. Holds ONE cursor
 * per NESTING LEVEL rather than one stack entry per member, so a forged flat
 * `args` at the top of the inbound frame cap cannot balloon the host heap.
 * @param value - a JSON-parse-produced value from an fd-3 frame.
 * @returns true when any contained number is non-finite or negative zero.
 */
export function hasNonLosslessNumber(value) {
  const cursors = [[value].values()]
  while (cursors.length > 0) {
    const cursor = cursors[cursors.length - 1]
    const step = cursor.next()
    if (step.done === true) {
      cursors.pop()
      continue
    }
    const current = step.value
    if (typeof current === 'number') {
      if (!Number.isFinite(current) || Object.is(current, -0)) return true
    } else if (Array.isArray(current)) {
      cursors.push(current.values())
    } else if (typeof current === 'object' && current !== null) {
      cursors.push(ownValues(current))
    }
  }
  return false
}
