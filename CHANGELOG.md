# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Documented

- **A "read this before installing" section now leads the README**, because the
  plugin's most important property is a side effect: it replaces the
  `code-runtime` row, so a deployment that installs it loses the shipped
  TypeScript PTC mode. Native mode is untouched. The section also states, in one
  table, which of the surrounding gaps this plugin fills and which it cannot:
  - **Cannot fix**: `run_code`'s language is not bound to the request, so
    per-session TypeScript/Python coexistence is impossible without a
    `dsh-tools` change; the subprocess runtime is isolation, not a security
    boundary; and this backend is an independent implementation that inherits no
    upstream stability or compatibility promise — upstream marks the CPython
    subprocess path "experimental, private".
  - **Fixes**: Python PTC could not work at all, because no Python runtime
    backend was published.
  - **Mitigates**: Windows has no POSIX resource limits and CPU metering needs an
    external command; both degrade to the wall-clock ceiling with an explicit
    warning rather than silently.
- Documents the rollback path (removing the bundle un-stacks its patch layer, so
  the base `code-runtime` row applies again) and names the two places a stale
  registration can hide in a profile manifest.
- **Records why per-session TypeScript/Python coexistence is upstream work.** The
  blockers, each verified against the DSH source rather than the published `lib/`:
  - `requireCodeTransport()` builds the `run_code` definition once
    (`this.ptcTransport ??=`) from closures that carry no scope
    (`requireRuntime: () => this.requireCodeRuntime(this.defaultMode)`,
    `peekRuntime: () => this.ctx.get('codeRuntime')`), and `createRunCodeTool`
    reads them only inside the schema getters. With
    `CodeRuntime.language` declared `abstract readonly language: string`, the
    model-visible `run_code` schema and SDK section are fixed to one language per
    process.
  - The registry that resolves the runtime is provided once by
    `ToolRuntime extends Service` on the host plane, and its own docs state it
    cannot move into a preset, so no scope sees a different runtime.
  - `run_code` is a reserved name the registry refuses to let any scope register
    or shadow.
  - Execution is **not** the obstacle: `ToolExecutionInput.agent?: Agent`
  already reaches `execute(args, exec)`, so per-agent dispatch at run time is
  available today. What is missing is binding the language to the request at
  schema generation — exactly what upstream's note defers ("Binding it is
  deferred until a second backend ships"), and this backend is that second
  backend.
  - An isolate-realm runtime would be worse than no coexistence: the registry
  sits outside the realm, so the prompt would render Python while execution went
  to the TypeScript runtime.

## [0.1.1] - 2026-09-19

### Fixed

- **The plugin could fail to load on a clean profile.** `lib/index.js` and
  `lib/python-runtime.js` imported `@deepseek-ai/schemastery` for config
  validation. That package is a peer of the ecosystem's profile plugins, and with
  the profile's `nodeLinker: hoisted` plus `auto-install-peers=false`, pnpm only
  lifts it to `<profile>/node_modules` when enough other plugins declare it.
  Measured on a profile containing only this plugin, it was absent and the
  plugin died with `ERR_MODULE_NOT_FOUND` before it could install the preset or
  mount the runtime.

  Config validation now implements the [Standard Schema](https://standardschema.dev)
  v1 interface cordis actually consumes (`Config['~standard'].validate`) in the
  new `lib/config-schema.js`, so the plugin imports **no npm package at all** and
  has no runtime dependency. Declaring `schemastery` as a dependency was rejected
  as the alternative: it would nest a second copy, which the profile's `.npmrc`
  forbids for core packages.

### Added

- `lib/config-schema.js`, exporting `InstallerConfig`, `RuntimeConfig` (with a
  `defaults` record that is the single source of truth for every default), and
  the `makeSchema` builder.
- Preset tests pinning the Standard Schema contract (synchronous `validate`,
  `{ value }` on success, `{ issues }` with a field path on failure), the
  absent-key defaulting rule, and the rejection of malformed values.

### Changed

- `Config` is now a Standard Schema object, not a callable schema. Callers that
  need the defaults read `Config.defaults`.

> **Do not install `#v0.1.0`.** That tag predates this fix and fails to load on a
> clean profile. Use `v0.1.1` or later.

## [0.1.0] - 2026-09-19

First release. Delivers a Python Programmatic Tool Calling mode for DeepSeek
Harness 0.1.5-rc.1: a CPython subprocess code runtime plus the `ptc-python`
agent preset, distributed as a GitHub-installable dsh plugin.

> Superseded by 0.1.1, which removes the load-time dependency on
> `@deepseek-ai/schemastery`. Kept for history; not recommended for install.

### Added

- **CPython code-runtime backend** (`lib/python-runtime.js`) registering
  `ctx.codeRuntime` with `language: 'python'` and `isolation: 'process'`, which
  is what makes `dsh-tools` PTC mode emit the Python `run_code` schema and the
  Python SDK block. One fresh `python -I` child per run, no cross-run state.
- **Python bootstrap** (`py/dsh_bootstrap.py`), standalone and standard-library
  only, speaking the two-pipe frame protocol; runs the program as an async
  function body with top-level `await`/`return`, and bridges
  `await tools.<name>(args)` calls to host bindings.
- **`ptc-python` agent preset** (`agent-presets/ptc-python/`) matching the
  shipped `standard` preset's tool surface, with an `@deepseek-ai/dsh-agent-tool-presentation`
  row selecting `mode: ptc` and a Python-flavoured persona.
- **Bundle patch** (`cordis.patch.yml`) mapping the plugin's `./runtime` entry
  over the shipped `code-runtime` row so the Python backend replaces the
  TypeScript worker backend, plus an `insert` row that installs the preset.
- **Idempotent preset installer** (`lib/index.js`), with `force` to overwrite an
  existing installation.
- **Source-tree installer** (`install.mjs`) with `--home`, `--profile`,
  `--force`, and `--dry-run`.
- **`SEAM_CONFORMANCE`** export restating the seam's reserved binding globals,
  reserved error members, and portable reserved words, so a namespace list valid
  on this backend stays valid on every other one.
- **Test suite**: 40 real-subprocess runtime tests plus 13 preset and packaging
  contract tests.

### Design notes

- **The protocol uses two independent pipes, not one duplex fd 3.** The seam's
  fd-3 protocol document describes a single bidirectional handle, and on POSIX
  that would work. On Windows it deadlocks: a thread blocked in a read on a
  named pipe prevents a write to the same handle from completing, whether the
  write uses a Python file object, a raw `os.write`, or a separate `os.dup`'d
  descriptor. Since a program must be able to send a `call` while waiting for a
  `reply`, the child reads host frames on its stdin and writes child frames to
  its stdout. The child duplicates fd 1 for the protocol and repoints the
  program's stdout at stderr, so bytes written below the Python level become
  stray output instead of corrupting the frame stream.
- **Exactly one thread ever reads the channel.** For the same Windows reason,
  the boot/run handshake is read on the main thread before the single daemon
  reply-reader starts; writes are serialized by one lock. A reply reader that
  cannot parse a frame fails every pending call instead of exiting silently.
- **Inbound frames are split by a bounded accumulator, not `readline`.**
  `readline` buffers internally with no way to bound what it holds, so a peer
  that never sends a newline could grow the host process without limit. The
  accumulator is checked against `maxFrameBytes` before a line is assembled.
- **The program wrapper is two lines, and reported line numbers subtract them.**
  `async def __dsh_main__():` followed by a blank line, with the program
  re-indented one level, keeps every program line on its own number while still
  allowing an opening comment or blank line to belong to the body. Wrapper
  frames in a traceback are dropped entirely rather than shown with numbers
  shifted by the wrapper's own trailing lines.
- **Neither side may use a recursion-based JSON codec.** The seam leaves value
  depth unbounded, so the host encodes and validates with explicit-stack
  traversals, and the child ships its own iterative encoder because
  `json.dumps` both recurses and honours `sys.getrecursionlimit()`. Parsing a
  deep frame temporarily raises the interpreter's recursion limit; the host's
  `maxFrameBytes` is what bounds a hostile one.
- **The seam package is deliberately not a runtime import.** A profile must
  never resolve its own copy of a core package, so the backend registers
  `codeRuntime` through `ctx.provide` and restates the seam's validation tables.
  A conformance test compares that restatement against the published exports
  whenever the seam package is resolvable, and skips when it is not.
- **The plugin imports no npm package at all.** Config validation goes through
  the [Standard Schema](https://standardschema.dev) interface cordis actually
  consumes (`Config['~standard'].validate`), implemented in
  `lib/config-schema.js`, so the plugin carries no runtime dependency and needs
  no copy of a core package. A `schemastery` peer was rejected after measuring
  it: with the profile's `nodeLinker: hoisted` and `auto-install-peers=false`,
  pnpm only lifts `@deepseek-ai/schemastery` to `<profile>/node_modules` when
  enough other plugins declare it, so on a clean profile the plugin would fail
  with `ERR_MODULE_NOT_FOUND` before doing anything. Declaring it as a
  dependency would nest a second copy, which the profile's `.npmrc` forbids for
  core packages. The schemas also expose `defaults`, which lets a test force
  `cordis.patch.yml` and the schema to agree on every default.
- **The runtime row reuses the shipped `code-runtime` entry id.** Patching that
  id replaces the row's whole `name` and `config`, which is how one process ends
  up serving exactly one PTC language — `ctx.provide` would refuse a second
  registration under the same service name.

### Known limitations

- One `codeRuntime` language per process: installing this plugin replaces the
  TypeScript worker backend, so no TypeScript PTC preset can coexist with it.
- Consumed-CPU metering needs `tasklist` (Windows) or `ps` (POSIX); where it is
  unavailable the runtime warns once and relies on `maxWallMs`.
- The POSIX child limits (`cpuSeconds`, `addressSpaceBytes`) are ignored on
  Windows, where the `resource` module does not exist.
- `-I` ignores user site-packages, so third-party imports need an explicit
  `isoFlags: []` or a system-level install.

[Unreleased]: https://github.com/yukitakasama/dsh-ptc-python/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/yukitakasama/dsh-ptc-python/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/yukitakasama/dsh-ptc-python/releases/tag/v0.1.0
