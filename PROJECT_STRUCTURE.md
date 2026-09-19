# 项目结构地图

本文件是 `dsh-ptc-python` 的结构地图，供后续修改与维护使用。改动任何文件前先在这里找到它的职责，改完请回来更新本文件。

> 本文件是**手工维护**的。`tests/preset.test.js` 会断言下面「打包清单」与「文件清单」里列出的文件都真实存在，所以加了文件却忘了写进 `package.json` 的 `files`，测试会失败。

---

## 一、这个项目由哪几块组成

整个插件只有三个真实关注点，每个关注点独立可测：

| 关注点 | 载体 | 职责边界 |
| --- | --- | --- |
| **子进程执行** | `lib/python-runtime.js` + `py/dsh_bootstrap.py` | 起一个 `python -I`、按帧协议对话、把工具调用桥接过去、把结果带回来。**不知道 dsh 的存在**，只认能力 seam 的三个类型。 |
| **宿主装配** | `lib/runtime.js` + `cordis.patch.yml` | 把上面那个类注册成 `ctx.codeRuntime`，并**替换** web bundle 原本的 TypeScript 运行时行。 |
| **预设交付** | `lib/index.js` + `agent-presets/ptc-python/` | 把预设文件复制到用户预设根，让 roster 能列出「PTC Python 模式」。 |

三者之间**没有调用关系**，只通过 dsh 的组合层相遇：

```
cordis.patch.yml
  ├── id: code-runtime  ──▶ lib/runtime.js ──▶ lib/python-runtime.js ──▶ py/dsh_bootstrap.py
  └── insert: dsh-ptc-python ──▶ lib/index.js ──▶ agent-presets/ptc-python/*  →  ${DSH_HOME}/.agent-presets/ptc-python/
                                                        │
                                                        └── 会话选择该预设时，其中的 tool-presentation 行
                                                            等的是 ctx.codeRuntime —— 即上面那一支。
```

**关键约束**：`code-runtime` 行与 `dsh-ptc-python` 行必须指向**不同的入口**。同一个包被两行引用就是两次注册，而 `ctx.provide('codeRuntime', ...)` 会拒绝第二次注册同名服务。这正是 `lib/index.js`（只装预设）与 `lib/runtime.js`（只挂服务）分开的原因。

---

## 二、文件清单

### 打包与元数据

| 文件 | 职责 |
| --- | --- |
| `package.json` | 包清单。声明 `dsh.bundle.patch`（让 DSH 把本包当 bundle 层）、`exports['./runtime']`（patch 引用的入口）、`files`（发布白名单）、`scripts.check` / `scripts.test`。 |
| `cordis.patch.yml` | profile 组合层补丁。**两行**：`id: code-runtime` 覆盖（换掉 TS 后端）+ `insert` 安装器行。所有运行时上限都在这里配置。 |
| `LICENSE` | MIT。 |
| `.gitignore` | 忽略 `node_modules/`、Python 字节码缓存、编辑器噪声。 |
| `CHANGELOG.md` | 版本历史。含 0.1.0 的设计说明与已知限制。 |
| `README.md` | 面向使用者的文档：安装、配置、用法、实现要点、限制。 |
| `PROJECT_STRUCTURE.md` | 本文件。 |

### 宿主侧代码（`lib/`，手写 JS，无构建步骤）

| 文件 | 行数 | 职责 |
| --- | --- | --- |
| `lib/index.js` | ~99 | **主入口**（`main: lib/index.js`）。只有一个职责：把打包的预设幂等复制到 `${DSH_HOME:-~/.dsh}/.agent-presets/ptc-python/`。导出 `apply`、`Config`、`installPreset`、`userPresetRoot`。 |
| `lib/runtime.js` | ~48 | `exports['./runtime']` 指向的入口。解析解释器路径、打印诊断、`new PythonCodeRuntime(...)`。是 patch 里 `code-runtime` 行的 `name`。 |
| `lib/python-runtime.js` | ~1050 | 后端本体。`Config`（= `RuntimeConfig`，Standard Schema）、`PythonCodeRuntime`（注册 `codeRuntime` 服务）、`validateChildFrame`（敌意帧校验/重建）、`OutputLedger`（字节账本）、`teardownChild`（进程树硬杀）、`defaultPythonPath`（解释器发现）、`SEAM_CONFORMANCE`（seam 一致性表）。 |
| `lib/config-schema.js` | ~200 | 两行各自的配置 schema，按 cordis 实际消费的 [Standard Schema](https://standardschema.dev) v1 接口（`~standard.validate`）手写，**不 import 任何包**。导出 `InstallerConfig`、`RuntimeConfig`（含 `defaults`）与 `makeSchema`。 |
| `lib/json-wire.js` | ~202 | 无损 JSON 工具。全部**用显式栈迭代**：`jsonStringBytesUpTo`（不分配转义副本的字节扫描）、`encodeJsonPlain`、`checkDoneValue`（字节 + 数值无损性一次遍历）、`hasNonLosslessNumber`（每层一个游标，不按成员入栈）。 |

> `lib/` 里的文件**就是产物**，没有 TS 源码、没有编译。改完直接生效（重启 dsh 后）。

### 子进程侧（`py/`）

| 文件 | 行数 | 职责 |
| --- | --- | --- |
| `py/dsh_bootstrap.py` | ~871 | 全部子进程逻辑，**只依赖标准库**，可单独拷到任何 3.8+ 解释器上跑。内含：帧协议通道（`ProtocolChannel`）、日志账本（`LogSink`）、流代理（`StreamProxy`）、EOF stdin（`EofStdin`）、程序包装与执行（`run_program`）、traceback 渲染（`format_traceback`）、迭代式 JSON 编码器（`encode_value`）、深度解析（`parse_json`）、POSIX 限制（`apply_posix_limits`）、会话编排（`Session`）。 |

> `py/dsh_bootstrap.py` 是**唯一**的 Python 运行时文件。它的模块 docstring 记录了协议、信任立场与那条「只能有一个线程读」的硬规则。

### 预设（`agent-presets/ptc-python/`）

| 文件 | 职责 |
| --- | --- |
| `preset.yml` | roster 读的展示元数据：`name`（中文显示名）、`description`、`order`。目录名必须等于预设 id（`ptc-python`），id 需匹配 `^[a-z0-9][a-z0-9-]*$`。 |
| `agent.cordis.yml` | agent 平面组合。与 shipped `standard` 预设保持工具表面一致，差异只有两处：persona 换成 Python 措辞；多一行 `@deepseek-ai/dsh-agent-tool-presentation` 且 `mode: ptc`。文件头注释详细解释了 realm 规则与「同步自 standard」的意图。 |

### 安装与测试

| 文件 | 职责 |
| --- | --- |
| `install.mjs` | 源码树安装脚本。三件事：装预设、拷包进 profile `node_modules`、登记进 profile `package.json` 的 `dsh.profile.bundles`。支持 `--home` / `--profile` / `--force` / `--dry-run`。 |
| `tests/runtime.test.js` | **真子进程**测试（40 个）。每个执行用例都真起 `python -I`。覆盖：配置校验、seam 一致性、绑定桥接、并发、大整数、深度、traceback 行号、字节上限、日志截断、超时、中止、dispose、敌意帧。 |
| `tests/preset.test.js` | 预设与打包契约测试（13 个）。校验 YAML 形状、行 id 唯一、group 带 realm、persona 字段、patch 覆盖目标、patch 值与 schema 默认一致、manifest 文件存在。 |
| `tests/fixtures/silent.py` | 夹具：只 sleep，从不 ack boot。用于验证宿主的 boot 超时。 |
| `tests/fixtures/flood.py` | 夹具：不换行地猛写 stdout。用于验证入站帧字节护栏（宿主必须按累计字节判负，而不是等换行）。 |

---

## 三、数据流：一次 `run_code` 的完整路径

```
模型                 dsh-tools                    lib/python-runtime.js              py/dsh_bootstrap.py
 │                       │                                │                                  │
 │  run_code{code}       │                                │                                  │
 ├──────────────────────▶│  取 ctx.codeRuntime            │                                  │
 │                       ├───────────────────────────────▶│  run(request)                    │
 │                       │                                │  validateBindings()              │
 │                       │                                │  spawn(python, ['-I', bootstrap], stdio:[pipe,pipe,pipe])
 │                       │                                ├─────────────────────────────────▶│  ProtocolChannel()
 │                       │                                │  ── boot 帧 ───────────────────▶ │  apply_posix_limits()
 │                       │                                │                                  │  os.dup2(2, 1)
 │                       │                                │  ◀─ boot-ack ────────────────────┤
 │                       │                                │  ── run{program} ──────────────▶ │  read_frame() → program
 │                       │                                │                                  │  run_program(...)  ← 主线程
 │                       │                                │  ◀─ call{id,global,name,args} ───┤  await tools.x(...) ← 事件循环
 │                       │                                │  onCall: 查 bindings，await fn   │
 │                       │                                │  ── reply{id,ok,value} ────────▶ │  future.set_result
 │                       │                                │                                  │  继续执行
 │                       │                                │  ◀─ log{text} ───────────────────┤  print(...) → StreamProxy → LogSink
 │                       │                                │  ◀─ done{value} ─────────────────┤  send_done()
 │                       │                                │  finish(): 物化结果、关管道、杀树 │
 │                       │  ◀── CodeRunResult ────────────┤                                  │
 │  ◀── 外层 run_code 结果 ┤                                │                                  │
```

只有最外层结果进入模型上下文；`call`/`reply` 与中间值都留在执行局部。

### 结果字段

| 场景 | `CodeRunResult` |
| --- | --- |
| 程序正常结束、无返回值 | `{ logs }` |
| 程序 `return` 了值 | `{ logs, value }` |
| 程序抛异常 | `{ logs, error: { kind: 'exception', message: <traceback> } }` |
| 返回值不是无损 JSON（NaN/Inf 等） | `{ logs, error: { kind: 'invalid-output', ... } }` |
| 超出 `maxValueBytes` / `maxOutputBytes` | `{ logs, error: { kind: 'output-limit', ... } }` |
| 墙钟超时 | `{ logs, error: { kind: 'timeout', ... } }` |
| 被 abort signal 中止 / dispose | `{ logs, error: { kind: 'abort', ... } }` |
| 子进程暴毙、boot 超时、spawn 失败 | `{ logs, error: { kind: 'worker-exit' \| 'exception', ... } }` |

`run()` 只在**误用 seam**时 reject（dispose 后调用、绑定命名不合法）；程序失败一律是结果字段。

---

## 四、改动指南

### 想加一个运行时上限

1. 在 `lib/config-schema.js` 的 `RuntimeConfig` 表里加字段（**必须带 `.default(...)`**）；需要非负零值的字段用 `numberField(x, { allowZero: true })`，字节数用 `byteField(x)`；
2. `lib/python-runtime.js` 构造器会对正数做一次冗余自检——把非数值字段（`pythonPath` / `isoFlags` / `protocol` / `maxComputeMs`）加进那个跳过列表；
3. 在 `cordis.patch.yml` 的 `code-runtime` 行里显式写出该值与默认值；
4. 在 `README.md` 的配置表里加一行；
5. `tests/preset.test.js` 会断言 patch 里的字段都在 schema 里、且值等于 `RuntimeConfig.defaults`——所以两处默认值必须一致。

### 想改配置校验语义

改 `lib/config-schema.js`。注意 cordis 只认 `Config['~standard'].validate(raw)`：**必须同步**（返回 thenable 会被 cordis 直接抛错），成功返回 `{ value }`、失败返回 `{ issues: [{ message, path }] }`。默认值只对**缺失**（`undefined`）生效，显式传 `null` 会走类型错误分支——这是故意的，静默替换 `null` 会掩盖真实配置错误。

### 想改协议帧

两侧必须同时改，且**同时改这三处**：

1. `lib/python-runtime.js` 的 `validateChildFrame`（宿主侧敌意帧校验/重建）；
2. `lib/python-runtime.js` 的 `handleFrame`（宿主侧分派）与 `deliverFrames`（分帧）；
3. `py/dsh_bootstrap.py` 的 `ProtocolChannel` / `Session.call_binding` / `Session.execute`。

改了帧的**必填/可选字段集**，请同步 `@deepseek-ai/dsh-code-runtime-python` 的 `py/protocol.py` 镜像说明（如果沿用其词表）。

### 想加一个预设内的工具行

1. 从 shipped `standard` 预设（`dsh-base` 的 `cordis.patch.yml` 或已安装的 `standard` 预设）里对照抄一行，**保持 id 一致**；
2. 只注册工具、不提供服务 → 不需要 realm，直接平铺；
3. **提供服务** → 必须放进一个 `cordis:group` 且声明 `isolate` 映射，否则 `dsh-agent-presets` 会在挂载时拒绝（服务泄漏到 root realm）；
4. 如果新工具需要新的 `@deepseek-ai/*` 包，先确认它在 dsh 的依赖树里真实存在（`preset.test.js` 不校验包是否存在，只校验本地文件）。

### 想换解释器发现策略

改 `lib/python-runtime.js` 的 `defaultPythonPath()`。注意 `windowsFallbacks()` 里写死了 `Python3{10,11,12,13}`——新增 Python 版本时这里要跟着加。也可以在 `cordis.patch.yml` 里设 `pythonPath` 或设环境变量 `DSH_PYTHON` 直接绕开发现逻辑。

---

## 五、测试怎么跑

```bash
npm run check   # 所有 JS: node --check；Python: py_compile
npm test        # node --test "tests/*.test.js"
```

**沙箱注意**：`tests/runtime.test.js` 会 `spawn` 带管道的子进程。在受限沙箱（只读或 workspace-write）下，`spawn` 会以 `EPERM` 失败——这是沙箱边界，不是代码缺陷。需要在能创建管道的环境下运行。

**依赖注意**：**运行期零 npm 依赖**——插件只用 Node 内置模块，配置校验走 cordis 实际消费的 Standard Schema 接口（`lib/config-schema.js`）。测试额外需要 `node_modules/` 中有 `yaml`，以及（可选，供一致性断言用）`@deepseek-ai/dsh-code-runtime`。seam 包**故意不是依赖**：profile 绝不能自己解析一份核心包，所以后端用 `ctx.provide` 注册、完全不 import 它；一致性断言检测不到 seam 包时会静默跳过。

**为什么不用 `@deepseek-ai/schemastery`**：cordis 的 `resolveConfig` 调的是 `runtime.Config['~standard'].validate(config)`，即 Standard Schema v1，所以 schema 不必来自 schema 库。而两个替代方案都更糟：

- **peer**：`nodeLinker: hoisted` + `auto-install-peers=false` 下，pnpm 只有在足够多其他插件也声明它时才把它提升到 `<profile>/node_modules/`。实测在只装本插件的干净 profile 里它不在，插件会以 `ERR_MODULE_NOT_FOUND` 在加载期失败——对一个要给别人装的插件是最坏的失败形态；
- **dependency**：pnpm 会在插件自己的 `node_modules/` 里嵌第二份，而该 profile 的 `.npmrc` 明确要求核心包只能来自 CLI 依赖树。

改动 schema 时注意：`RuntimeConfig.defaults` 是默认值的**唯一真源**，`cordis.patch.yml` 只是复述，`tests/preset.test.js` 会强制两者一致。

---

## 六、已知的坑（改代码前务必读）

1. **Windows 管道会串行化「读阻塞」与「写」**。任何「一个线程读、另一个线程往同一句柄写」的设计都会死锁。协议因此用两个独立管道（stdin 读 / stdout 写），并且**全生命周期只有一个线程读**。
2. **不要用 `readline` 分帧**。它内部缓冲且无法设界；用 `deliverFrames` 里的有界累加器。
3. **不要用 `json.dumps` / `JSON.stringify` 处理可能很深的值**。两者都按层递归。宿主用 `lib/json-wire.js`，子进程用 `encode_value`。
4. **子进程包装是两行**（`WRAPPER_LINES = 2`），traceback 行号要减 2；子进程自身栈帧整段丢弃。
5. **`finish()` 必须「先物化结果、再关管道」**。`result` 要在 `settled = true` 之后立刻算出来，否则异步 teardown 期间其他 handler 可能改掉 `terminalOverride`，导致报错信息与决策不符。
6. **`teardownChild` 必须有兜底时限**。子进程可能杀不死，但一次运行/一次 dispose 绝不能悬住。
7. **`lib/index.js` 与 `lib/runtime.js` 不能合并**。合并会导致同名服务被注册两次。
8. **`isoFlags` 默认值在 schema 与 patch 里必须一致**（都是 `['-I']`），否则 `preset.test.js` 失败。
9. **不要给插件加运行时 npm 依赖**。配置校验用 Standard Schema 自己实现就够了；加依赖会在干净 profile 上以 `ERR_MODULE_NOT_FOUND` 加载失败（原因见第四节「依赖注意」）。
