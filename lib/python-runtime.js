/**
 * CPython subprocess backend for the harness code-execution seam: one fresh
 * `python -I` child per run, the model-written program executed as an async
 * function body, tool calls bridged over the child's fd 3 as JSON-lines frames.
 *
 * Containment, not a security boundary: model code has bash-equivalent trust,
 * and the caps below (wall clock, consumed CPU, byte budget, hard kill of the
 * process tree, optional POSIX CPU/address-space limits applied in the child)
 * bound resource use rather than isolate the program. Only what the program
 * printed and returned re-enters the caller's context; binding traffic and
 * intermediate values stay execution-local.
 *
 * The service registers as `codeRuntime` — the name the seam's consumer
 * (`dsh-tools` PTC mode) and a preset's tool-presentation row inject — so it
 * must be mounted in place of the TypeScript worker backend, never beside it.
 *
 * @module @yukitakasama/dsh-ptc-python/lib/python-runtime
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { RuntimeConfig } from './config-schema.js'
import { checkDoneValue, encodeJsonPlain, hasNonLosslessNumber, jsonStringBytesUpTo } from './json-wire.js'

/**
 * The protocol's two pipes, from the child's perspective. The child READS host
 * frames on its own stdin and WRITES child frames to its own stdout. They are
 * deliberately two unidirectional pipes rather than one duplex handle (fd 3):
 * a Windows pipe serializes a blocked read against a write on the same handle,
 * so a reply-reader and a call-writer sharing one handle deadlock. With two
 * pipes the directions are independent, which is what lets a program await a
 * tool while the harness keeps reading its frames.
 *
 * The child redirects its stdout onto stderr once it has duplicated fd 1 for the
 * protocol, so anything the program writes below the Python level lands on the
 * stray-output pipe instead of corrupting the frame stream.
 *
 * `logTruncationMarker` names `[dsh-code-runtime-python]`, the same family
 * identifier the seam's reserved protocol package uses, so a truncated run reads
 * the same whichever Python backend produced it.
 */

/**
 * The child's own log-ledger truncation marker. Byte-identical to the Python
 * side's `log_truncation_marker`, so a truncated run reads the same however the
 * cap was hit.
 * @param maxBytes - the configured log budget the marker names.
 * @returns the marker line.
 */
export function logTruncationMarker(maxBytes) {
  return `[dsh-code-runtime-python] log capture truncated at ${maxBytes} bytes`
}

/**
 * Binding globals every backend refuses because some backend owns the slot in
 * the program's namespace: `console` (the worker backend's log capture) and
 * `__dsh_main__`/`__builtins__`/`__name__`/`__debug__` (this backend's wrapper
 * and seeded module globals). Kept byte-identical to
 * `@deepseek-ai/dsh-code-runtime`'s `RESERVED_BINDING_GLOBALS` so a namespace
 * list valid here stays valid on every other backend.
 */
const RESERVED_BINDING_GLOBALS = new Set(['console', '__dsh_main__', '__builtins__', '__name__', '__debug__'])

/** Error members every backend refuses; dunder forms are refused wholesale. */
const RESERVED_ERROR_MEMBERS = new Set(['name', 'message', 'stack', 'args', 'with_traceback', 'add_note'])

/** Dunder form (`__x__`, non-empty middle): object-protocol slots in Python. */
const DUNDER_MEMBER = /^__.+__$/

/**
 * Reserved words of every portable target language (ECMAScript ∪ Python),
 * refused as binding globals and error-class names by all backends.
 */
const PORTABLE_RESERVED_WORDS = new Set([
  'await', 'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default', 'delete', 'do',
  'else', 'enum', 'export', 'extends', 'false', 'finally', 'for', 'function', 'if', 'import', 'in',
  'instanceof', 'new', 'null', 'return', 'super', 'switch', 'this', 'throw', 'true', 'try', 'typeof',
  'var', 'void', 'while', 'with', 'yield', 'let', 'static', 'implements', 'interface', 'package',
  'private', 'protected', 'public', 'arguments', 'eval',
  'False', 'None', 'True', 'and', 'as', 'assert', 'async', 'def', 'del', 'elif', 'except', 'from',
  'global', 'is', 'lambda', 'nonlocal', 'not', 'or', 'pass', 'raise', 'match', 'type', '_',
])

/** The seam's language-portable identifier subset (no `$`, which is JS-only spelling). */
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/

/**
 * The seam-level validation tables this backend enforces, exported so a
 * conformance check can compare them against the published
 * `@deepseek-ai/dsh-code-runtime` exports. They are restated here rather than
 * imported because a profile must never resolve its own copy of a core package:
 * the runtime registers `codeRuntime` through `ctx.provide` and therefore needs
 * no seam import at all, and the harness puts the seam only in the CLI's
 * dependency tree. Divergence would make a namespace list valid on one backend
 * and invalid on another, which is exactly what the shared set exists to prevent.
 */
export const SEAM_CONFORMANCE = Object.freeze({
  reservedBindingGlobals: RESERVED_BINDING_GLOBALS,
  reservedErrorMembers: RESERVED_ERROR_MEMBERS,
  portableReservedWords: PORTABLE_RESERVED_WORDS,
  dunderMember: DUNDER_MEMBER,
})

/** Smallest byte cap that can represent the counted payloads: an empty logs array plus an empty failure message. */
const MIN_OUTPUT_BYTES = 4

/** Node clamps a `setTimeout` delay above this to 1 ms, so a longer wall ceiling must be rejected at load. */
const MAX_TIMER_DELAY_MS = 2_147_483_647

/**
 * How often the host samples a running child's consumed CPU time for
 * `maxComputeMs`. An internal cadence, not config: its only effect is
 * budget-expiry granularity.
 */
const CPU_POLL_INTERVAL_MS = 500

/** Milliseconds allowed for the child to shut down after a kill request before it is killed again. */
const KILL_RETRY_MS = 1_000

/**
 * The backend's validated config, as the Standard Schema cordis consumes for a
 * plugin row. Every cap is deployment-varying and therefore a config field
 * rather than a constant; the interface width caps live in the code because they
 * bound only the host's own re-serialization.
 */
export const Config = RuntimeConfig

/** Conventional Windows interpreter locations, used only when PATH yields nothing. */
function windowsFallbacks() {
  const local = process.env.LOCALAPPDATA
  if (local === undefined || local === '') return []
  const dirs = ['Python313', 'Python312', 'Python311', 'Python310']
  return dirs.map((dir) => join(local, 'Programs', 'Python', dir, 'python.exe'))
}

/**
 * Pick the interpreter: an explicit `pythonPath`, then `DSH_PYTHON`, then the
 * first `python`/`python3` on PATH, then the conventional Windows install
 * locations. `undefined` when nothing is found, which surfaces as a per-run
 * `exception` naming the config field rather than a mount failure — a
 * deployment can legitimately mount this runtime before installing Python.
 * @returns an interpreter command, or `undefined` when none is discoverable.
 */
export function defaultPythonPath() {
  if (process.env.DSH_PYTHON !== undefined && process.env.DSH_PYTHON !== '') return process.env.DSH_PYTHON
  const names = process.platform === 'win32' ? ['python.exe', 'python3.exe'] : ['python3', 'python']
  for (const name of names) {
    for (const dir of (process.env.PATH ?? '').split(delimiter)) {
      if (dir === '') continue
      const candidate = join(dir, name)
      if (existsSync(candidate)) return candidate
    }
  }
  for (const candidate of windowsFallbacks()) {
    if (existsSync(candidate)) return candidate
  }
  return undefined
}

/** Render an unknown thrown value as a message, `Error` or not. */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * One run's combined outer-output ledger. Binding values never enter it; only
 * the program's captured text, its completion value, and a failure message do.
 * It includes the log-array syntax and string escaping in its accounting, so
 * the cap bounds exactly what the caller will retain.
 */
class OutputLedger {
  /**
   * @param maxBytes - the combined cap for logs plus value-or-diagnostic.
   */
  constructor(maxBytes) {
    this.maxBytes = maxBytes
    this.bytes = 2 // JSON serialization of the empty logs array: []
    this.entries = 0
  }

  /**
   * Admit one exact log entry, or report that the hard cap was crossed.
   * @param text - the captured text.
   * @param sink - the array the admitted text is appended to.
   * @returns true when admitted, false when the cap was crossed.
   */
  admit(text, sink) {
    const separatorBytes = this.entries > 0 ? 1 : 0
    const stringBytes = jsonStringBytesUpTo(text, this.maxBytes - this.bytes - separatorBytes)
    if (stringBytes === undefined) return false
    this.bytes += stringBytes + separatorBytes
    this.entries += 1
    sink.push(text)
    return true
  }

  /**
   * Finalize a successful absent-or-JSON completion against the combined cap.
   * @param logs - the captured logs.
   * @param value - the completion value, or `undefined` when the program returned nothing.
   * @returns the run result.
   */
  success(logs, value) {
    if (value !== undefined && !checkDoneValue(value, this.maxBytes - this.bytes).ok) return this.limit(logs)
    return value === undefined ? { logs } : { logs, value }
  }

  /**
   * Finalize a failure diagnostic, with output-limit taking precedence when
   * the combined bytes exceed the cap.
   * @param logs - the captured logs.
   * @param error - the failure to report.
   * @returns the run result.
   */
  failure(logs, error) {
    if (jsonStringBytesUpTo(error.message, this.maxBytes - this.bytes) === undefined) return this.limit(logs)
    return { logs, error }
  }

  /**
   * Build the explicit output-limit failure while retaining a fitting prefix of
   * the final log.
   * @param logs - the captured logs.
   * @returns the run result with an `output-limit` error.
   */
  limit(logs) {
    const message = `outer output exceeded ${this.maxBytes} bytes`
    const messageBytes = message.length + 2 // the diagnostic is ASCII
    const retained = []
    let retainedBytes = 2
    const logBudget = this.maxBytes - messageBytes
    for (const text of logs) {
      const separatorBytes = retained.length > 0 ? 1 : 0
      const available = logBudget - retainedBytes - separatorBytes
      const stringBytes = jsonStringBytesUpTo(text, available)
      if (stringBytes !== undefined) {
        retained.push(text)
        retainedBytes += stringBytes + separatorBytes
        continue
      }
      const prefix = truncateJsonString(text, available)
      if (prefix !== '') {
        const prefixBytes = jsonStringBytesUpTo(prefix, available)
        if (prefixBytes === undefined) break
        retained.push(prefix)
        retainedBytes += prefixBytes + separatorBytes
      }
      break
    }
    return { logs: retained, error: { kind: 'output-limit', message } }
  }
}

/**
 * Longest prefix of `text` whose compact JSON form fits `maxBytes`.
 * @param text - the string to truncate.
 * @param maxBytes - the byte budget.
 * @returns the fitting prefix (empty when even the opening quote does not fit).
 */
function truncateJsonString(text, maxBytes) {
  if (maxBytes < 2) return ''
  let low = 0
  let high = text.length
  while (low < high) {
    const mid = Math.ceil((low + high) / 2)
    if (jsonStringBytesUpTo(text.slice(0, mid), maxBytes) !== undefined) low = mid
    else high = mid - 1
  }
  return text.slice(0, low)
}

/**
 * Runtime shape gate for inbound fd-3 traffic. The peer runs MODEL CODE and can
 * post anything, so every accepted frame is re-validated and REBUILT field by
 * field: forged extras never ride along and a non-number call id can never be
 * echoed into a reply. Junk returns `undefined` to be dropped, because a throw
 * in the host's line handler would crash the host process.
 * @param raw - one JSON-parsed frame from fd 3.
 * @returns the rebuilt frame, or `undefined` to drop it silently.
 */
export function validateChildFrame(raw) {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined
  switch (raw.type) {
    case 'boot-ack':
      return { type: 'boot-ack' }
    case 'log':
      if (typeof raw.text !== 'string') return undefined
      return raw.truncated === true
        ? { type: 'log', text: raw.text, truncated: true }
        : { type: 'log', text: raw.text }
    case 'call': {
      const { id } = raw
      // The id is echoed verbatim into the reply frame, so it must be a finite
      // number: `1e400` parses to Infinity and would make the reply
      // unencodable, while `-0` re-serializes as `0` and would collide with a
      // real call whose id is 0.
      if (typeof id !== 'number' || !Number.isFinite(id) || Object.is(id, -0)) return undefined
      if (typeof raw.global !== 'string' || typeof raw.name !== 'string') return undefined
      if (!Object.hasOwn(raw, 'args')) return undefined
      if (hasNonLosslessNumber(raw.args)) return undefined
      return { type: 'call', id, global: raw.global, name: raw.name, args: raw.args }
    }
    case 'done': {
      if (raw.error === undefined) {
        return raw.value === undefined ? { type: 'done' } : { type: 'done', value: raw.value }
      }
      const error = raw.error
      if (typeof error !== 'object' || error === null) return undefined
      if (typeof error.message !== 'string') return undefined
      const { kind } = error
      if (kind !== 'exception' && kind !== 'invalid-output' && kind !== 'output-limit') return undefined
      return raw.value === undefined
        ? { type: 'done', error: { kind, message: error.message } }
        : { type: 'done', value: raw.value, error: { kind, message: error.message } }
    }
    default:
      return undefined
  }
}

/**
 * The CPython subprocess code runtime. Registers as the `codeRuntime` service;
 * `language` is `'python'`, which is what makes `dsh-tools` PTC mode emit the
 * Python `run_code` schema and the Python SDK block for a preset that selects it.
 */
export class PythonCodeRuntime {
  /**
   * @param ctx - the registering context; the service unregisters with its fiber.
   * @param config - validated caps (defaults filled by {@link Config}).
   * @param options - host wiring: `bootstrapPath` (required in production) and
   *   an optional `executable` that overrides interpreter discovery. Both are
   *   injected by the plugin entry so this module holds no package-relative
   *   path knowledge and stays independently testable.
   */
  constructor(ctx, config = {}, options = {}) {
    this.ctx = ctx
    this.config = config
    this.bootstrapPath = options.bootstrapPath ?? ''
    this.executable = options.executable
    this.activeBindings = new Map()
    this.live = new Set()
    this.disposed = false
    this.computeMeteringWarned = false

    for (const [key, value] of Object.entries(this.config)) {
      // `maxComputeMs: 0` is the documented "no compute budget" sentinel;
      // `isoFlags` is a list and `protocol` is a protocol constant.
      if (key === 'pythonPath' || key === 'isoFlags' || key === 'protocol' || key === 'maxComputeMs') continue
      if (!(Number.isFinite(value) && value > 0)) {
        throw new Error(`dsh-ptc-python: config.${key} must be a positive number, got ${String(value)}`)
      }
    }
    if (!Number.isFinite(this.config.maxComputeMs) || this.config.maxComputeMs < 0) {
      throw new Error(`dsh-ptc-python: config.maxComputeMs must be zero (disabled) or a positive number, got ${String(this.config.maxComputeMs)}`)
    }
    if (!Number.isSafeInteger(this.config.maxOutputBytes) || this.config.maxOutputBytes < MIN_OUTPUT_BYTES) {
      throw new Error(`dsh-ptc-python: config.maxOutputBytes must be a safe integer of at least ${MIN_OUTPUT_BYTES}`)
    }
    if (this.config.maxWallMs > MAX_TIMER_DELAY_MS) {
      throw new Error(`dsh-ptc-python: config.maxWallMs must be at most ${MAX_TIMER_DELAY_MS}`)
    }
    if (this.config.protocol !== 'stdin-stdout') {
      throw new Error('dsh-ptc-python: config.protocol must be \'stdin-stdout\' (the protocol pins child stdin/stdout)')
    }

    // The service registration rides the calling fiber, so the row's unload
    // removes `ctx.codeRuntime` automatically.
    this.registration = ctx.provide?.('codeRuntime', this)

    if (ctx.effect) ctx.effect(() => () => this.teardown(), 'python code-runtime teardown')
  }

  /** The source language `run` expects, read by `dsh-tools` to pick its PTC presentation. */
  get language() {
    return 'python'
  }

  /** The execution substrate descriptor — informational, not a security claim. */
  get isolation() {
    return 'process'
  }

  /**
   * Dispose to quiescence: mark the service unusable, fail every in-flight run
   * as aborted, and AWAIT each child's exit so no subprocess outlives the fiber.
   * @returns a promise that settles once every live child has exited.
   */
  async teardown() {
    this.disposed = true
    const runs = [...this.live]
    for (const run of runs) run.settle({ kind: 'abort', message: 'runtime disposed' })
    await Promise.all(runs.map((run) => run.exited))
  }

  /**
   * Execute one program in a fresh CPython subprocess. Program outcomes —
   * including a syntax error, which never spawns a child — resolve with
   * `result.error`; the method rejects only for Service Definition contract misuse
   * (a disposed runtime, an invalid binding namespace).
   * @param request - the program, its bindings, and the abort signal.
   * @returns the run's outcome per the seam contract.
   */
  async run(request) {
    if (this.disposed) throw new Error('dsh-ptc-python: run() after disposal')
    const bindings = this.validateBindings(request)
    const ledger = new OutputLedger(this.config.maxOutputBytes)
    if (request.signal?.aborted) {
      return ledger.failure([], { kind: 'abort', message: String(request.signal.reason) })
    }
    const executable = this.executable !== undefined && this.executable !== ''
      ? this.executable
      : this.config.pythonPath !== ''
        ? this.config.pythonPath
        : defaultPythonPath()
    if (executable === undefined || executable === '') {
      return ledger.failure([], {
        kind: 'exception',
        message: 'no Python interpreter found; set `pythonPath` on the dsh-ptc-python runtime row or the DSH_PYTHON environment variable',
      })
    }
    if (!existsSync(this.bootstrapPath)) {
      return ledger.failure([], { kind: 'exception', message: `python bootstrap not found at ${this.bootstrapPath}` })
    }
    return this.execute(request, bindings, executable, ledger)
  }

  /**
   * Reject malformed binding globals or typed-error declarations as Service
   * Definition contract misuse, so a caller's composition error fails loudly
   * instead of producing a program that cannot call its tools.
   * @param request - the run request whose bindings are validated.
   * @returns the validated namespaces keyed by their program-visible global.
   */
  validateBindings(request) {
    const bindings = new Map()
    for (const namespace of request.bindings) {
      const name = namespace.global
      if (!IDENTIFIER.test(name) || PORTABLE_RESERVED_WORDS.has(name)) {
        throw new Error(`dsh-ptc-python: binding global ${JSON.stringify(name)} is not a usable identifier`)
      }
      if (RESERVED_BINDING_GLOBALS.has(name)) {
        throw new Error(`dsh-ptc-python: reserved binding global ${JSON.stringify(name)}`)
      }
      if (bindings.has(name)) {
        throw new Error(`dsh-ptc-python: duplicate binding global ${JSON.stringify(name)}`)
      }
      bindings.set(name, namespace)
    }
    const errorClassNames = new Set()
    for (const namespace of request.bindings) {
      const descriptor = namespace.errorClass
      if (descriptor === undefined) continue
      if (!IDENTIFIER.test(descriptor.name) || PORTABLE_RESERVED_WORDS.has(descriptor.name)) {
        throw new Error(`dsh-ptc-python: binding error class ${JSON.stringify(descriptor.name)} is not a usable identifier`)
      }
      if (RESERVED_BINDING_GLOBALS.has(descriptor.name) || bindings.has(descriptor.name) || errorClassNames.has(descriptor.name)) {
        throw new Error(`dsh-ptc-python: duplicate injected global ${JSON.stringify(descriptor.name)}`)
      }
      const member = descriptor.memberNameProperty
      if (member.length === 0 || RESERVED_ERROR_MEMBERS.has(member) || DUNDER_MEMBER.test(member)) {
        throw new Error(`dsh-ptc-python: binding error member property ${JSON.stringify(member)} is not usable`)
      }
      errorClassNames.add(descriptor.name)
    }
    return bindings
  }

  /**
   * Spawn the child for one validated run and drive it to settlement.
   * @param request - the run request.
   * @param bindings - validated namespaces keyed by program-visible global.
   * @param executable - the interpreter command.
   * @param ledger - the run's outer-output ledger.
   * @returns the run result.
   */
  execute(request, bindings, executable, ledger) {
    const boot = {
      type: 'boot',
      cpuSeconds: Math.round(this.config.cpuSeconds),
      addressSpaceBytes: Math.round(this.config.addressSpaceBytes),
      maxLogBytes: Math.round(this.config.maxLogBytes),
      maxValueBytes: Math.round(this.config.maxValueBytes),
      namespaces: [...bindings].map(([global, namespace]) => ({
        global,
        names: Object.keys(namespace.functions),
        ...(namespace.errorClass === undefined ? {} : { errorClass: namespace.errorClass }),
      })),
    }

    const child = spawn(executable, [...this.config.isoFlags, this.bootstrapPath], {
      // Child stdin is the host→child frame pipe and child stdout the
      // child→host one; stderr carries the program's stray output.
      stdio: ['pipe', 'pipe', 'pipe'],
      // Model code gets NO ambient environment beyond what a Windows Python
      // needs to start (it reads SystemRoot for its own file APIs).
      env: minimalEnvironment(),
      windowsHide: true,
    })

    return new Promise((resolve) => {
      let settled = false
      let bootAcked = false
      let doneSeen = false
      let terminalOverride
      const protocolLogs = []
      const strayLogs = []
      const answered = new Set()
      const toChild = child.stdin
      const fromChild = child.stdout

      let finishResolve
      const exited = new Promise((done) => { finishResolve = done })

      const allLogs = () => [...protocolLogs, ...strayLogs]

      const finish = (finalize) => {
        if (settled) return
        settled = true
        clearInterval(cpuTimer)
        clearTimeout(wallTimer)
        clearTimeout(bootTimer)
        request.signal?.removeEventListener('abort', onAbort)
        this.live.delete(live)
        // Materialize the outcome NOW, against the state this path decided on,
        // then stop reading. A pipe left flowing would keep buffering a peer that
        // never sends a newline -- growing without bound long after the result
        // was settled.
        const result = terminalOverride ?? (typeof finalize === 'function' ? finalize() : finalize)
        fromChild.destroy()
        // Closing the host's write pipe is what ends the child's frame reader:
        // the bootstrap stops on end-of-stream. Without it the reader stays
        // blocked waiting for another frame that will never come.
        try { toChild.end() } catch { /* the pipe is already gone */ }
        void teardownChild(child).then(() => {
          finishResolve()
          resolve(result)
        })
      }

      // Inbound frames are split HERE rather than by `readline`, because
      // `readline` buffers internally and exposes no way to bound what it holds.
      // This accumulator is capped by `maxFrameBytes` before any line is
      // assembled, so a peer that never sends a newline cannot grow the host.
      let pending = Buffer.alloc(0)

      /** Route one validated frame to its handler. */
      function handleFrame(frame) {
        switch (frame.type) {
          case 'boot-ack':
            bootAcked = true
            clearTimeout(bootTimer)
            toChild.write(`${encodeJsonPlain({ type: 'run', program: request.program })}\n`)
            return
          case 'log':
            if (ledger.admit(frame.text, protocolLogs)) return
            terminalOverride = ledger.limit([...protocolLogs, ...strayLogs, frame.text])
            finish(terminalOverride)
            return
          case 'call':
            onCall(frame)
            return
          case 'done':
            onDone(frame)
            return
          default:
            return
        }
      }

      const deliverFrames = (chunk) => {
        if (settled) return
        pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk])
        let index = pending.indexOf(0x0a)
        while (index >= 0) {
          const line = pending.subarray(0, index).toString('utf8').trim()
          pending = pending.subarray(index + 1)
          if (line !== '') {
            let parsed
            try {
              parsed = JSON.parse(line)
            } catch {
              parsed = undefined // junk on the wire is dropped, never fatal
            }
            const frame = parsed === undefined ? undefined : validateChildFrame(parsed)
            if (frame !== undefined) {
              handleFrame(frame)
              if (settled) return
            }
          }
          index = pending.indexOf(0x0a)
        }
        if (pending.length > this.config.maxFrameBytes) {
          terminalOverride = ledger.failure(allLogs(), {
            kind: 'invalid-output',
            message: `inbound frame traffic exceeded ${this.config.maxFrameBytes} bytes`,
          })
          finish(terminalOverride)
        }
      }

      const captureStray = (chunk) => {
        if (settled || terminalOverride !== undefined) return
        const text = chunk.toString('utf8')
        if (!ledger.admit(text, strayLogs)) {
          terminalOverride = ledger.limit([...protocolLogs, ...strayLogs])
          finish(terminalOverride)
        }
      }
      child.stderr.on('data', captureStray)
      fromChild.on('data', deliverFrames)

      const onDone = (frame) => {
        doneSeen = true
        if (frame.error !== undefined) {
          finish(() => ledger.failure(allLogs(), frame.error))
          return
        }
        if (frame.value === undefined) {
          finish(() => ledger.success(allLogs()))
          return
        }
        const checked = checkDoneValue(frame.value, this.config.maxValueBytes)
        if (!checked.ok) {
          finish(() => ledger.failure(allLogs(), {
            kind: checked.reason === 'non-lossless' ? 'invalid-output' : 'output-limit',
            message: checked.reason === 'non-lossless'
              ? 'program completion must be lossless JSON'
              : `program completion exceeded ${this.config.maxValueBytes} bytes`,
          }))
          return
        }
        finish(() => ledger.success(allLogs(), frame.value))
      }

      const onCall = (frame) => {
        if (settled || answered.has(frame.id)) return
        answered.add(frame.id)
        const reply = (payload) => {
          if (settled || toChild.destroyed) return
          try {
            toChild.write(`${encodeJsonPlain(payload)}\n`)
          } catch {
            // A dead pipe settles the run through the child's exit.
          }
        }
        const record = bindings.get(frame.global)?.functions
        // Own-property lookup only: a forged name like `constructor` or
        // `hasOwnProperty` must not walk the record's prototype chain and reach
        // a callable the caller never declared.
        const fn = record !== undefined && Object.hasOwn(record, frame.name) ? record[frame.name] : undefined
        if (typeof fn !== 'function') {
          reply({ type: 'reply', id: frame.id, ok: false, message: `unknown binding ${JSON.stringify(`${frame.global}.${frame.name}`)}` })
          return
        }
        void (async () => {
          try {
            const resolved = await fn(frame.args)
            // The seam requires a lossless-JSON resolution; `undefined` is not
            // JSON, so it is reported rather than silently normalized to null.
            if (resolved === undefined || !checkDoneValue(resolved, Number.MAX_SAFE_INTEGER).ok) {
              reply({ type: 'reply', id: frame.id, ok: false, message: 'binding resolution must be lossless JSON' })
              return
            }
            reply({ type: 'reply', id: frame.id, ok: true, value: resolved })
          } catch (error) {
            reply({ type: 'reply', id: frame.id, ok: false, message: messageOf(error) })
          }
        })()
      }

      toChild.on('error', () => { /* the child's exit handler owns settlement */ })

      child.on('error', (error) => {
        if (doneSeen) {
          finish(() => ledger.success(allLogs()))
          return
        }
        finish(() => ledger.failure(allLogs(), { kind: 'worker-exit', message: `python spawn failed: ${error.message}` }))
      })
      child.on('exit', (code) => {
        // The child posts `done`, closes its protocol channel, and exits; an
        // exit after a terminal frame is the normal end of a run, while an exit
        // before one is the substrate dying.
        if (doneSeen) {
          finish(() => ledger.success(allLogs()))
          return
        }
        finish(() => ledger.failure(allLogs(), {
          kind: 'worker-exit',
          message: bootAcked
            ? `python exited with code ${code ?? 'null'} before completing`
            : 'python bootstrap exited before acknowledging boot',
        }))
      })

      const wallTimer = setTimeout(() => {
        finish(() => ledger.failure(allLogs(), { kind: 'timeout', message: `wall-clock ceiling reached (${this.config.maxWallMs}ms)` }))
      }, this.config.maxWallMs)

      const bootTimer = setTimeout(() => {
        if (bootAcked) return
        finish(() => ledger.failure(allLogs(), { kind: 'exception', message: `python bootstrap did not acknowledge boot within ${this.config.bootTimeoutMs}ms` }))
      }, this.config.bootTimeoutMs)

      // A disabled budget still needs a clearable handle. The placeholder is
      // unref'd so a long-lived runtime never holds the host's event loop open.
      const cpuTimer = this.config.maxComputeMs > 0
        ? setInterval(() => {
          void checkCompute(child.pid, this.config.maxComputeMs, (cpuMs) => {
            finish(() => ledger.failure(allLogs(), { kind: 'timeout', message: `compute budget exhausted (${cpuMs}ms CPU)` }))
          }, () => this.warnComputeMeteringUnavailable())
        }, CPU_POLL_INTERVAL_MS)
        : idleTimer()

      const onAbort = () => {
        finish(() => ledger.failure(allLogs(), { kind: 'abort', message: String(request.signal?.reason) }))
      }
      request.signal?.addEventListener('abort', onAbort, { once: true })

      const live = {
        child,
        exited,
        settle: (failure) => { finish(() => ledger.failure(allLogs(), failure)) },
      }
      this.live.add(live)

      try {
        toChild.write(`${encodeJsonPlain(boot)}\n`)
      } catch (error) {
        finish(() => ledger.failure([], { kind: 'exception', message: `python boot frame failed: ${messageOf(error)}` }))
      }
    })
  }

  /** Report once per runtime that `maxComputeMs` cannot be metered on this host. */
  warnComputeMeteringUnavailable() {
    if (this.computeMeteringWarned) return
    this.computeMeteringWarned = true
    const logger = this.ctx?.logger
    const message = 'maxComputeMs is set but this host cannot sample a child process tree\'s CPU time; only maxWallMs bounds the run'
    if (typeof logger?.warn === 'function') logger.warn(message)
    else console.warn(`[dsh-ptc-python] ${message}`)
  }
}

/**
 * A clearable placeholder for a disabled budget. It is unref'd so it never keeps
 * the host's event loop alive, and it is scheduled far enough out that it cannot
 * fire inside a run.
 * @returns the timer handle the run's settlement clears.
 */
function idleTimer() {
  const timer = setTimeout(() => {}, MAX_TIMER_DELAY_MS)
  timer.unref?.()
  return timer
}

/** The minimal environment a Python interpreter needs to start on this platform. */function minimalEnvironment() {
  const env = {}
  for (const key of ['SystemRoot', 'windir', 'TEMP', 'TMP', 'PATHEXT', 'COMSPEC']) {
    const value = process.env[key]
    if (value !== undefined) env[key] = value
  }
  return env
}

/**
 * Hard-stop one child and its descendants. `SIGKILL` is not honoured by
 * Windows, so the tree is killed through `taskkill`. The returned promise always
 * settles: a child that survives the kill must not hold a run — or a disposal —
 * open, so a bounded grace period ends the wait either way.
 * @param child - the spawned child process.
 * @returns a promise that settles once the child is reaped or the grace period ends.
 */
function teardownChild(child) {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve()
      return
    }
    let done = false
    const settle = () => {
      if (done) return
      done = true
      clearTimeout(grace)
      resolve()
    }
    const grace = setTimeout(settle, KILL_RETRY_MS * 3)
    child.once('exit', settle)
    child.once('close', settle)
    if (process.platform === 'win32' && typeof child.pid === 'number') {
      const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
      killer.on('error', () => { try { child.kill('SIGKILL') } catch { /* already gone */ } })
      return
    }
    try { child.kill('SIGKILL') } catch { /* already gone */ }
  })
}

/**
 * Poll one process tree's consumed CPU time and report the total once the
 * budget is crossed. A tree that cannot be sampled (already gone, or a host
 * without a sampler) is reported to `onUnavailable` once and left to the
 * wall-clock ceiling.
 * @param pid - the child's process id.
 * @param budgetMs - the consumed-CPU budget in milliseconds.
 * @param onExceeded - called with the measured CPU milliseconds once over budget.
 * @param onUnavailable - called when this host cannot sample the tree.
 */
async function checkCompute(pid, budgetMs, onExceeded, onUnavailable) {
  if (typeof pid !== 'number') return
  let cpuMs
  try {
    cpuMs = await processTreeCpuMs(pid)
  } catch {
    onUnavailable()
    return
  }
  if (cpuMs > budgetMs) onExceeded(cpuMs)
}

/**
 * Consumed CPU milliseconds for one process, or throw when this host cannot
 * report it.
 * @param pid - the process id.
 * @returns the consumed CPU time in milliseconds.
 */
async function processTreeCpuMs(pid) {
  const { execFile } = await import('node:child_process')
  if (process.platform === 'win32') {
    const stdout = await run(execFile, 'tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'])
    return parseTasklistCpu(stdout)
  }
  const stdout = await run(execFile, 'ps', ['-o', 'time=', '-p', String(pid)])
  return parsePosixCpu(stdout.trim())
}

/**
 * Run one sampler command and resolve its stdout.
 * @param execFile - the `node:child_process` `execFile` function.
 * @param file - the executable.
 * @param args - its arguments.
 * @returns the command's stdout.
 */
function run(execFile, file, args) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { windowsHide: true }, (error, stdout) => {
      if (error) reject(error)
      else resolve(stdout)
    })
  })
}

/**
 * Parse `tasklist /FO CSV /NH` output's CPU-time column into milliseconds.
 * Accepts both the `H:MM:SS` form and a bare total-seconds figure, because the
 * exact rendering varies with the locale; any unrecognized value yields 0,
 * which leaves the budget to the wall-clock ceiling.
 * @param stdout - the command's stdout.
 * @returns consumed CPU milliseconds.
 */
function parseTasklistCpu(stdout) {
  const line = stdout.trim().split(/\r?\n/).find((row) => row.trim() !== '') ?? ''
  const fields = line.split('","').map((field) => field.replace(/^"|"$/g, '').trim())
  const cell = fields[2] ?? ''
  if (cell.includes(':')) {
    const parts = cell.split(':').map(Number)
    if (parts.some((part) => !Number.isFinite(part))) return 0
    return parts.reduce((total, part) => total * 60 + part, 0) * 1000
  }
  const seconds = Number(cell)
  return Number.isFinite(seconds) ? seconds * 1000 : 0
}

/**
 * Parse `ps -o time=` output's CPU-time column into milliseconds.
 * @param text - the trimmed stdout.
 * @returns consumed CPU milliseconds.
 */
function parsePosixCpu(text) {
  if (text === '') return 0
  const [dayPart, clockPart] = text.includes('-') ? text.split('-') : ['0', text]
  const parts = clockPart.split(':').map(Number)
  if (parts.some((part) => !Number.isFinite(part))) return 0
  const seconds = parts.length === 3
    ? parts[0] * 3600 + parts[1] * 60 + parts[2]
    : parts.length === 2
      ? parts[0] * 60 + parts[1]
      : parts[0]
  const days = Number(dayPart)
  return ((Number.isFinite(days) ? days : 0) * 86_400 + seconds) * 1000
}
