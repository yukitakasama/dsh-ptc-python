/**
 * Real-subprocess tests for the CPython code-runtime backend.
 *
 * Every test that executes a program spawns a genuine `python -I` child and
 * drives it over fd 3, so the wire codec, the resource caps, the binding bridge,
 * and the traceback rendering are all exercised against the real substrate
 * rather than a fake. Run with: `node --test tests/` (Node 20+).
 *
 * @module @yukitakasama/dsh-ptc-python/tests/runtime.test
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { PythonCodeRuntime, Config, defaultPythonPath, validateChildFrame } from '../lib/python-runtime.js'

const BOOTSTRAP = fileURLToPath(new URL('../py/dsh_bootstrap.py', import.meta.url))
const EXECUTABLE = defaultPythonPath()
const SKIP = EXECUTABLE === undefined ? 'no Python interpreter on this host' : false

/** Default caps for a test run; individual tests override what they exercise. */
function caps(overrides = {}) {
  return { ...Config.defaults, ...overrides }
}

/**
 * Build a runtime whose teardown rides a captured effect function, mirroring how
 * the plugin row registers it while keeping the test free of a cordis context.
 * @param overrides - config overrides.
 * @returns the runtime plus a `teardown` that runs the captured effect's disposer.
 */
function makeRuntime(overrides = {}) {
  let effect
  const ctx = {
    effect: (fn) => { effect = fn; return () => {} },
    provide: () => () => {},
    logger: { warn: () => {} },
  }
  const runtime = new PythonCodeRuntime(ctx, caps(overrides), {
    bootstrapPath: BOOTSTRAP,
    executable: EXECUTABLE,
  })
  // The registered effect returns the disposer the loader would call on unload.
  return { runtime, teardown: () => effect()() }
}

/** One namespace with the given functions, keyed as PTC mode supplies them. */
function toolsNamespace(functions, globalName = 'tools') {
  return { global: globalName, functions }
}

test('reports the seam vocabulary the PTC presentation switches on', () => {
  const { runtime } = makeRuntime()
  assert.equal(runtime.language, 'python')
  assert.equal(runtime.isolation, 'process')
})

test('rejects a config cap that is not a positive number', () => {
  const ctx = { effect: () => () => {}, provide: () => () => {} }
  assert.throws(
    () => new PythonCodeRuntime(ctx, caps({ maxWallMs: 0 }), { bootstrapPath: BOOTSTRAP, executable: 'python' }),
    /maxWallMs must be a positive number/,
  )
})

test('rejects a config maxWallMs beyond the Node timer ceiling', () => {
  const ctx = { effect: () => () => {}, provide: () => () => {} }
  assert.throws(
    () => new PythonCodeRuntime(ctx, caps({ maxWallMs: 3_000_000_000 }), { bootstrapPath: BOOTSTRAP, executable: 'python' }),
    /maxWallMs must be at most/,
  )
})

test('accepts maxComputeMs of zero as the disabled budget', () => {
  const ctx = { effect: () => () => {}, provide: () => () => {} }
  assert.doesNotThrow(
    () => new PythonCodeRuntime(ctx, caps({ maxComputeMs: 0 }), { bootstrapPath: BOOTSTRAP, executable: 'python' }),
  )
  assert.throws(
    () => new PythonCodeRuntime(ctx, caps({ maxComputeMs: -1 }), { bootstrapPath: BOOTSTRAP, executable: 'python' }),
    /maxComputeMs must be zero \(disabled\) or a positive number/,
  )
})

test('rejects a config maxOutputBytes below the representable minimum', () => {
  const ctx = { effect: () => () => {}, provide: () => () => {} }
  assert.throws(
    () => new PythonCodeRuntime(ctx, caps({ maxOutputBytes: 2 }), { bootstrapPath: BOOTSTRAP, executable: 'python' }),
    /maxOutputBytes must be a safe integer of at least/,
  )
})

test('rejects run() after disposal', async () => {
  const { runtime, teardown } = makeRuntime()
  await teardown()
  await assert.rejects(() => runtime.run({ program: 'pass', bindings: [] }), /run\(\) after disposal/)
})

test('rejects a binding global that is not a portable identifier', async () => {
  const { runtime } = makeRuntime()
  await assert.rejects(
    () => runtime.run({ program: 'pass', bindings: [{ global: '$tools', functions: {} }] }),
    /not a usable identifier/,
  )
  await assert.rejects(
    () => runtime.run({ program: 'pass', bindings: [{ global: 'lambda', functions: {} }] }),
    /not a usable identifier/,
  )
  await assert.rejects(
    () => runtime.run({ program: 'pass', bindings: [{ global: 'console', functions: {} }] }),
    /reserved binding global/,
  )
})

test('rejects an unusable binding error-member property', async () => {
  const { runtime } = makeRuntime()
  await assert.rejects(
    () => runtime.run({
      program: 'pass',
      bindings: [toolsNamespace({}, 'tools')].map((namespace) => ({
        ...namespace,
        errorClass: { name: 'ToolError', memberNameProperty: '__class__' },
      })),
    }),
    /error member property .* is not usable/,
  )
})

test('reports a configured interpreter path that does not exist as a program failure', { skip: SKIP }, async () => {
  const ctx = { effect: () => () => {}, provide: () => () => {}, logger: { warn: () => {} } }
  const runtime = new PythonCodeRuntime(ctx, caps({ pythonPath: '/nonexistent/python-does-not-exist' }), {
    bootstrapPath: BOOTSTRAP,
    executable: undefined,
  })
  const result = await runtime.run({ program: 'pass', bindings: [] })
  assert.ok(result.error !== undefined, 'a run with no usable interpreter must fail')
  assert.ok(
    /ENOENT|no such file|did not acknowledge boot/i.test(result.error.message),
    `unexpected failure message: ${result.error.message}`,
  )
})

test('refuses discovery when neither PATH nor the platform fallbacks offer an interpreter', async () => {
  const savedPython = process.env.DSH_PYTHON
  const savedPath = process.env.PATH
  delete process.env.DSH_PYTHON
  process.env.PATH = ''
  try {
    // On Windows the conventional install locations are consulted last, so the
    // assertion only holds where those do not exist; the run-level failure for a
    // missing interpreter is covered by the explicit-path test above.
    const found = defaultPythonPath()
    if (found !== undefined) {
      assert.ok(found.length > 0)
      return
    }
    const ctx = { effect: () => () => {}, provide: () => () => {}, logger: { warn: () => {} } }
    const runtime = new PythonCodeRuntime(ctx, caps(), { bootstrapPath: BOOTSTRAP, executable: undefined })
    const result = await runtime.run({ program: 'pass', bindings: [] })
    assert.equal(result.error.kind, 'exception')
    assert.match(result.error.message, /no Python interpreter found/)
  } finally {
    if (savedPython === undefined) delete process.env.DSH_PYTHON
    else process.env.DSH_PYTHON = savedPython
    process.env.PATH = savedPath
  }
})

test('reports a missing bootstrap as a program failure', { skip: SKIP }, async () => {
  const ctx = { effect: () => () => {}, provide: () => () => {} }
  const runtime = new PythonCodeRuntime(ctx, caps(), {
    bootstrapPath: fileURLToPath(new URL('./does-not-exist.py', import.meta.url)),
    executable: EXECUTABLE,
  })
  const result = await runtime.run({ program: 'pass', bindings: [] })
  assert.equal(result.error.kind, 'exception')
  assert.match(result.error.message, /python bootstrap not found/)
})

test('runs a program and captures print output in order', { skip: SKIP }, async () => {
  const { runtime } = makeRuntime()
  const result = await runtime.run({
    program: 'print("first")\nprint("second", 2)\nreturn "ok"',
    bindings: [],
  })
  assert.deepEqual(result.logs, ['first\n', 'second 2\n'])
  assert.equal(result.value, 'ok')
  assert.equal(result.error, undefined)
})

test('supports top-level await inside the program', { skip: SKIP }, async () => {
  const { runtime } = makeRuntime()
  const result = await runtime.run({
    program: [
      'import asyncio',
      'async def tick():',
      '    await asyncio.sleep(0)',
      '    return 7',
      'await tick()',
      'return await tick()',
    ].join('\n'),
    bindings: [],
  })
  assert.equal(result.value, 7, result.error?.message)
  assert.equal(result.error, undefined)
})

test('bridges tool calls to host bindings and returns their value', { skip: SKIP }, async () => {
  const seen = []
  const { runtime } = makeRuntime()
  const result = await runtime.run({
    program: 'a = await tools.echo({"text": "hi", "n": 2})\nprint(a["echoed"])\nreturn a["n"] * 2',
    bindings: [toolsNamespace({
      echo: async (args) => { seen.push(args); return { echoed: args.text, n: args.n } },
    })],
  })
  assert.equal(result.error, undefined, result.error?.message)
  assert.deepEqual(seen, [{ text: 'hi', n: 2 }])
  assert.deepEqual(result.logs, ['hi\n'])
  assert.equal(result.value, 4)
})

test('overlaps concurrent binding calls and settles them by id', { skip: SKIP }, async () => {
  const { runtime } = makeRuntime()
  const result = await runtime.run({
    program: [
      'import asyncio',
      'results = await asyncio.gather(*[tools.slow({"i": i}) for i in range(5)])',
      'return sorted(r["i"] for r in results)',
    ].join('\n'),
    bindings: [toolsNamespace({
      slow: async (args) => {
        await new Promise((resolve) => setTimeout(resolve, 5))
        return { i: args.i }
      },
    })],
  })
  assert.equal(result.error, undefined, result.error?.message)
  assert.deepEqual(result.value, [0, 1, 2, 3, 4])
})

test('keeps an integer exact up to the JavaScript safe range', { skip: SKIP }, async () => {
  const { runtime } = makeRuntime()
  const safe = '9007199254740991' // Number.MAX_SAFE_INTEGER: the seam's exact-integer bound
  const result = await runtime.run({
    program: `v = await tools.ident({"v": ${safe}})\nreturn v["v"]`,
    bindings: [toolsNamespace({ ident: async (args) => args })],
  })
  assert.equal(result.error, undefined, result.error?.message)
  assert.equal(String(result.value), safe)
})

test('carries a beyond-safe-range integer as the nearest double, not a lossy token', { skip: SKIP }, async () => {
  const { runtime } = makeRuntime()
  // 2**60 is integral and exactly representable as a double, so the frame must
  // carry its exact digits rather than JSON.stringify's rounded spelling.
  const result = await runtime.run({
    program: 'v = await tools.ident({"v": 1152921504606846976})\nreturn v["v"]',
    bindings: [toolsNamespace({ ident: async (args) => args })],
  })
  assert.equal(result.error, undefined, result.error?.message)
  assert.equal(BigInt(result.value).toString(2), (2n ** 60n).toString(2))
})

test('nests a deep payload past the Python and JavaScript encoder recursion limits', { skip: SKIP }, async () => {
  const { runtime } = makeRuntime()
  const depth = 2_000
  const result = await runtime.run({
    program: [
      'payload = 0',
      `for i in range(${depth}):`,
      '    payload = {"n": i, "v": payload}',
      'count = 0',
      'cursor = await tools.deep(payload)',
      'while isinstance(cursor, dict):',
      '    count += 1',
      '    cursor = cursor["v"]',
      'return count',
    ].join('\n'),
    bindings: [toolsNamespace({ deep: async (args) => args })],
  })
  assert.equal(result.error, undefined, result.error?.message)
  assert.equal(result.value, depth)
})

test('returns a deep completion value to the caller without truncating it', { skip: SKIP }, async () => {
  const { runtime } = makeRuntime()
  const depth = 2_000
  const result = await runtime.run({
    program: [
      'payload = 0',
      `for i in range(${depth}):`,
      '    payload = {"n": i, "v": payload}',
      'return payload',
    ].join('\n'),
    bindings: [],
  })
  assert.equal(result.error, undefined, result.error?.message)
  let cursor = result.value
  let seen = 0
  while (cursor !== null && typeof cursor === 'object') {
    seen += 1
    cursor = cursor.v
  }
  assert.equal(seen, depth)
  assert.equal(cursor, 0)
})

test('rejects a program exception with the model line number and no bootstrap frames', { skip: SKIP }, async () => {
  const { runtime } = makeRuntime()
  const result = await runtime.run({
    program: 'print("before")\nraise ValueError("boom")',
    bindings: [],
  })
  assert.equal(result.error.kind, 'exception')
  assert.match(result.error.message, /ValueError: boom/)
  assert.match(result.error.message, /line 2/)
  assert.doesNotMatch(result.error.message, /dsh_bootstrap/)
  assert.deepEqual(result.logs, ['before\n'])
})

test('reports a syntax error as an exception result', { skip: SKIP }, async () => {
  const { runtime } = makeRuntime()
  const result = await runtime.run({ program: 'def (:', bindings: [] })
  assert.equal(result.error.kind, 'exception')
  assert.match(result.error.message, /SyntaxError/)
})

test('surfaces a binding rejection inside the program', { skip: SKIP }, async () => {
  const { runtime } = makeRuntime()
  const result = await runtime.run({
    program: [
      'try:',
      '    await tools.fail({})',
      'except ToolError as error:',
      '    return ["caught", error.member, str(error)]',
    ].join('\n'),
    bindings: [{
      global: 'tools',
      functions: { fail: async () => { throw new Error('denied by policy') } },
      errorClass: { name: 'ToolError', memberNameProperty: 'member' },
    }],
  })
  assert.equal(result.error, undefined, result.error?.message)
  assert.deepEqual(result.value, ['caught', 'fail', 'denied by policy'])
})

test('rejects an unknown binding name rather than hanging', { skip: SKIP }, async () => {
  const { runtime } = makeRuntime()
  const result = await runtime.run({
    program: 'try:\n    await tools.nope({})\nexcept Exception as error:\n    return str(error)',
    bindings: [toolsNamespace({ present: async () => null })],
  })
  // The bootstrap only materializes declared names, so an undeclared name is an
  // AttributeError inside the program — never a host round trip.
  assert.equal(result.error, undefined, result.error?.message)
  assert.match(String(result.value), /nope/)
})

test('rejects a completion value that is not lossless JSON', { skip: SKIP }, async () => {
  const { runtime } = makeRuntime()
  const result = await runtime.run({ program: 'return float("nan")', bindings: [] })
  assert.equal(result.error.kind, 'invalid-output')
})

test('enforces the value byte budget', { skip: SKIP }, async () => {
  const { runtime } = makeRuntime({ maxValueBytes: 64 })
  const result = await runtime.run({ program: 'return "x" * 4096', bindings: [] })
  assert.equal(result.error.kind, 'output-limit')
})

test('enforces the wall-clock ceiling and leaves captured output in the result', { skip: SKIP }, async () => {
  const { runtime } = makeRuntime({ maxWallMs: 700 })
  const started = Date.now()
  const result = await runtime.run({
    program: 'print("ticking")\nimport time\ntime.sleep(30)\nreturn "never"',
    bindings: [],
  })
  assert.equal(result.error.kind, 'timeout')
  assert.deepEqual(result.logs, ['ticking\n'])
  assert.ok(Date.now() - started < 15_000, 'the run must not wait for the child to finish sleeping')
})

test('aborts a run through the request signal', { skip: SKIP }, async () => {
  const { runtime } = makeRuntime()
  const controller = new AbortController()
  setTimeout(() => controller.abort(new Error('user cancelled')), 200)
  const result = await runtime.run({
    program: 'import time\ntime.sleep(30)\nreturn "never"',
    bindings: [],
    signal: controller.signal,
  })
  assert.equal(result.error.kind, 'abort')
})

test('reports an already-aborted signal without spawning a program result', { skip: SKIP }, async () => {
  const { runtime } = makeRuntime()
  const controller = new AbortController()
  controller.abort('too late')
  const result = await runtime.run({ program: 'return 1', bindings: [], signal: controller.signal })
  assert.equal(result.error.kind, 'abort')
  assert.deepEqual(result.logs, [])
})

test('truncates captured output at the log budget and says so in band', { skip: SKIP }, async () => {
  const { runtime } = makeRuntime({ maxLogBytes: 200 })
  const result = await runtime.run({
    program: 'for i in range(50):\n    print("line-%02d" % i)\nreturn "done"',
    bindings: [],
  })
  assert.equal(result.error, undefined, result.error?.message)
  assert.equal(result.value, 'done')
  assert.ok(result.logs.length > 0)
  assert.match(result.logs[result.logs.length - 1], /log capture truncated at 200 bytes/)
})

test('drives the program without blocking on the harness stdin', { skip: SKIP }, async () => {
  const { runtime } = makeRuntime()
  const result = await runtime.run({
    program: 'try:\n    input()\nexcept EOFError:\n    return "eof"',
    bindings: [],
  })
  assert.equal(result.error, undefined, result.error?.message)
  assert.equal(result.value, 'eof')
})

test('disposal aborts an in-flight run and waits for the child', { skip: SKIP }, async () => {
  const { runtime, teardown } = makeRuntime()
  const pending = runtime.run({ program: 'import time\ntime.sleep(30)\nreturn 1', bindings: [] })
  await new Promise((resolve) => setTimeout(resolve, 400))
  await teardown()
  const result = await pending
  assert.equal(result.error.kind, 'abort')
  assert.match(result.error.message, /runtime disposed/)
})

test('stops the child when the program calls sys.exit', { skip: SKIP }, async () => {
  const { runtime } = makeRuntime()
  const result = await runtime.run({ program: 'print("bye")\nimport sys\nsys.exit(0)', bindings: [] })
  assert.ok(result.error !== undefined || result.value === undefined)
  assert.ok(result.logs.includes('bye\n') || result.logs.some((line) => line.includes('bye')))
})

test('drops junk on the wire instead of crashing the host', () => {
  for (const raw of [null, 42, 'text', [], { type: 'unknown' }, { type: 'log' }, { type: 'log', text: 5 }]) {
    assert.equal(validateChildFrame(raw), undefined)
  }
})

test('rebuilds frames field by field and never echoes a malformed call id', () => {
  assert.deepEqual(validateChildFrame({ type: 'boot-ack', extra: 'dropped' }), { type: 'boot-ack' })
  assert.deepEqual(validateChildFrame({ type: 'log', text: 'x' }), { type: 'log', text: 'x' })
  assert.deepEqual(
    validateChildFrame({ type: 'log', text: 'x', truncated: 'yes' }),
    { type: 'log', text: 'x' },
    'only the literal true counts as truncated',
  )
  assert.equal(validateChildFrame({ type: 'call', id: Number.POSITIVE_INFINITY, global: 'tools', name: 'a', args: null }), undefined)
  assert.equal(validateChildFrame({ type: 'call', id: -0, global: 'tools', name: 'a', args: null }), undefined)
  assert.equal(validateChildFrame({ type: 'call', id: 1, global: 'tools', name: 'a' }), undefined)
  assert.deepEqual(
    validateChildFrame({ type: 'call', id: 1, global: 'tools', name: 'a', args: { n: 1 } }),
    { type: 'call', id: 1, global: 'tools', name: 'a', args: { n: 1 } },
  )
})

test('drops a call whose args carry a non-lossless number', () => {
  assert.equal(
    validateChildFrame({ type: 'call', id: 1, global: 'tools', name: 'a', args: { n: 1e400 } }),
    undefined,
  )
})

test('accepts only the three documented done failure kinds', () => {
  assert.deepEqual(validateChildFrame({ type: 'done' }), { type: 'done' })
  assert.deepEqual(validateChildFrame({ type: 'done', value: 1 }), { type: 'done', value: 1 })
  assert.deepEqual(
    validateChildFrame({ type: 'done', error: { kind: 'exception', message: 'x' } }),
    { type: 'done', error: { kind: 'exception', message: 'x' } },
  )
  assert.equal(validateChildFrame({ type: 'done', error: { kind: 'boom', message: 'x' } }), undefined)
  assert.equal(validateChildFrame({ type: 'done', error: { kind: 'exception', message: 7 } }), undefined)
})

test('reports a hostile bootstrap that never acknowledges boot', { skip: SKIP }, async () => {
  const ctx = { effect: () => () => {}, provide: () => () => {}, logger: { warn: () => {} } }
  const runtime = new PythonCodeRuntime(ctx, caps({ bootTimeoutMs: 1_000 }), {
    bootstrapPath: fileURLToPath(new URL('./fixtures/silent.py', import.meta.url)),
    executable: EXECUTABLE,
  })
  const result = await runtime.run({ program: 'pass', bindings: [] })
  assert.equal(result.error.kind, 'exception')
  assert.match(result.error.message, /did not acknowledge boot/)
})

test('guards the inbound frame budget', { skip: SKIP }, async () => {
  const ctx = { effect: () => () => {}, provide: () => () => {}, logger: { warn: () => {} } }
  const runtime = new PythonCodeRuntime(ctx, caps({ maxFrameBytes: 4_096 }), {
    bootstrapPath: fileURLToPath(new URL('./fixtures/flood.py', import.meta.url)),
    executable: EXECUTABLE,
  })
  const result = await runtime.run({ program: 'pass', bindings: [] })
  assert.ok(result.error !== undefined)
  // The flood is cut off either by the inbound byte guard (once the host reads
  // the bytes) or by the boot timeout that ends the run first.
  assert.match(result.error.message, /inbound frame traffic exceeded|did not acknowledge boot/)
})

test('matches the seam\'s reserved sets and portable words exactly', async () => {
  // The backend restates the seam's validation tables so it can register
  // `codeRuntime` without importing a core package (a profile must never resolve
  // its own copy). This compares the restatement against the published seam
  // exports, and skips when the seam package is not resolvable from here.
  let seam
  try {
    seam = await import('@deepseek-ai/dsh-code-runtime')
  } catch {
    return
  }
  const { SEAM_CONFORMANCE } = await import('../lib/python-runtime.js')
  assert.deepEqual(
    [...SEAM_CONFORMANCE.reservedBindingGlobals].sort(),
    [...seam.RESERVED_BINDING_GLOBALS].sort(),
    'reserved binding globals must match the seam',
  )
  assert.deepEqual(
    [...SEAM_CONFORMANCE.reservedErrorMembers].sort(),
    [...seam.RESERVED_ERROR_MEMBERS].sort(),
    'reserved error members must match the seam',
  )
  assert.deepEqual(
    [...SEAM_CONFORMANCE.portableReservedWords].sort(),
    [...seam.PORTABLE_RESERVED_WORDS].sort(),
    'portable reserved words must match the seam',
  )
  assert.equal(SEAM_CONFORMANCE.dunderMember.source, seam.DUNDER_MEMBER.source, 'dunder rule must match the seam')
})

test('refuses every reserved global and portable word the seam names', async () => {
  const { SEAM_CONFORMANCE } = await import('../lib/python-runtime.js')
  const { runtime } = makeRuntime()
  for (const name of SEAM_CONFORMANCE.reservedBindingGlobals) {
    await assert.rejects(
      () => runtime.run({ program: 'pass', bindings: [{ global: name, functions: {} }] }),
      /reserved binding global/,
      `reserved global ${name} must be refused`,
    )
  }
  for (const word of SEAM_CONFORMANCE.portableReservedWords) {
    await assert.rejects(
      () => runtime.run({ program: 'pass', bindings: [{ global: word, functions: {} }] }),
      /not a usable identifier/,
      `portable reserved word ${word} must be refused`,
    )
  }
  for (const member of SEAM_CONFORMANCE.reservedErrorMembers) {
    await assert.rejects(
      () => runtime.run({
        program: 'pass',
        bindings: [{
          global: 'tools',
          functions: {},
          errorClass: { name: 'ToolError', memberNameProperty: member },
        }],
      }),
      /error member property .* is not usable/,
      `reserved error member ${member} must be refused`,
    )
  }
})
