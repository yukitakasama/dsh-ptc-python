# dsh-ptc-python

DeepSeek Harness 插件：一个 **Python 版 PTC（Programmatic Tool Calling）模式**预设。

装上它之后，模型不再逐个调用工具，而是**只调用 `run_code`**：一次写出一整段 Python 程序，把工具当作 `await tools.<name>(args)` 绑定函数调用，只有程序 `print` 出来的行和 `return` 的值回到对话里。中间的工具调用、循环、异常处理全部留在子进程内部。

> 适配 **dsh 0.1.5-rc.1**。分布方式为 **GitHub 直装**（无需 npm 发布）。

English | [中文](README.md)

---

## 为什么需要这个插件

DSH 的 PTC 模式是一套「工具呈现方式」，不是某个语言专属的功能：`dsh-tools` 里同时内置了 **TypeScript** 与 **Python** 两套 `run_code` schema 与 SDK 生成器（见 `packages/core/tools/src/ptc.ts` 的 `RUN_CODE_FLAVORS`、`py-types.ts`）。

但**已发布的代码运行时后端只有 TypeScript 那个**：

| 包 | 状态 |
| --- | --- |
| `@deepseek-ai/dsh-code-runtime` | 已发布（能力 seam：`CodeRuntime` 抽象类） |
| `@deepseek-ai/dsh-code-runtime-worker-thread` | 已发布（TypeScript 后端，web profile 默认挂载） |
| `@deepseek-ai/dsh-code-runtime-python` | 已发布，但**只有 fd-3 线协议的定义**，README 明确写着不包含子进程执行路径 |

`dsh-tools` 读取 `ctx.codeRuntime.language` 决定发哪一套 schema。所以「Python 模式的 PTC」缺的不是预设，而是**一个 `language === 'python'` 的运行时后端**。本插件补上这一块，并把预设一起交付。

## 特性

- **一个真·CPython 子进程后端**：每次运行 `python -I <bootstrap>` 起一个全新子进程，程序结束后进程即销毁，运行之间不保留任何状态；
- **独立双向管道**：宿主→子进程走子进程 stdin，子进程→宿主走子进程 stdout。**故意不用单一 fd 3 双向句柄**——Windows 命名管道会把「阻塞中的读」和「同一句柄上的写」串行化，一个读写共用的句柄会让「等工具回包」和「发工具请求」互相死锁（详见[实现要点](#实现要点)）；
- **Python 作为宿主侧工具调用语言**：程序里 `await tools.bash({...})`、`await tools.read({...})` 就是普通异步调用，并发用 `asyncio.gather` 直接铺开；
- **工具表面与标准模式一致**：bash、文件系统、搜索、技能、目标、计划、压缩、委托、工作流、Web、present 全部保留，只是改用绑定方式触达；
- **处处有界**：墙钟上限、可选的 CPU 占用上限、日志/返回值/单帧字节上限、POSIX `RLIMIT_CPU`/`RLIMIT_AS`、以及必定生效的进程树硬杀；
- **GitHub 直装**：`dsh plugin add github:...` 即可，无需 npm 发布；
- **幂等安装**：启动时把打包的预设复制到用户预设根，已存在则跳过，`force: true` 才覆盖。

## 工作原理

```
                 ┌─────────────────────── 宿主进程（dsh） ───────────────────────┐
                 │                                                              │
  Web 会话 ──────┤ dsh-tools PTC 模式                     dsh-agent-presets      │
  选择           │  · 读取 ctx.codeRuntime.language        · 挂载 ptc-python      │
  「PTC Python   │  · 吐出 Python 版 run_code schema        预设（mode: ptc）     │
   模式」        │  · 吐出一段 Python SDK 章节                                   │
                 │                                                              │
                 │ 本插件的 code-runtime 行（替换掉 TypeScript worker 后端）      │
                 │  ctx.codeRuntime = PythonCodeRuntime(language='python')       │
                 └───────────────────────────┬──────────────────────────────────┘
                                             │ 每次 run_code 起一个全新子进程
                                             │
                  stdin  ── boot / run / reply ──▶  ┌──────────────────────────┐
                  stdout ◀── boot-ack / call / log / done ──│ python -I bootstrap │
                  stderr ── 程序的原生输出（兜底捕获）──▶  └──────────────────────────┘
```

| 环节 | 说明 |
| --- | --- |
| 插件行 | `cordis.patch.yml` 用 `code-runtime` 这个 id **替换** web bundle 原本的 TypeScript 运行时行，并 `insert` 安装器行 |
| 运行时 | `lib/runtime.js` → `lib/python-runtime.js`，以 `ctx.provide('codeRuntime', ...)` 注册服务 |
| 子进程 | `py/dsh_bootstrap.py`，每次运行一个全新 `python -I` 进程 |
| 预设 | `agent-presets/ptc-python/`，由插件启动时复制到 `${DSH_HOME:-~/.dsh}/.agent-presets/ptc-python/` |
| 呈现 | 预设里的 `@deepseek-ai/dsh-agent-tool-presentation` 行声明 `mode: ptc` |

### 一次运行的帧序列

```
宿主 → 子进程   {"type":"boot", cpuSeconds, addressSpaceBytes, maxLogBytes,
                 maxValueBytes, namespaces:[{global, names, errorClass?}]}
子进程 → 宿主   {"type":"boot-ack"}
宿主 → 子进程   {"type":"run", program:"<模型写的程序体>"}
子进程 → 宿主   {"type":"call","id":1,"global":"tools","name":"bash","args":{...}}
宿主 → 子进程   {"type":"reply","id":1,"ok":true,"value":{...}}
子进程 → 宿主   {"type":"log","text":"..."}          （可多次；行缓冲，一行一条）
子进程 → 宿主   {"type":"done","value":...} 或 {"type":"done","error":{kind,message}}
```

`done.error.kind` 只有 `exception` / `invalid-output` / `output-limit` 三种；墙钟超时、中止、子进程暴毙由**宿主侧**观察，不占协议字段。

## 快速开始

### 方式一：GitHub 直装（推荐）

```bash
dsh plugin --profile web add github:yukitakasama/dsh-ptc-python
```

`dsh plugin` 会把参数转发给 profile 目录下的 pnpm；pnpm 克隆本仓库，随后 DSH 自动把声明了 `dsh.bundle` 的包加入 profile 的 layer 栈。

**锁定版本 / 分支 / 提交**：

```bash
dsh plugin --profile web add github:yukitakasama/dsh-ptc-python#v0.1.1
```

> 不要锁 `#v0.1.0`：那个 tag 早于 0.1.1 的加载失败修复，在干净 profile 上会以
> `ERR_MODULE_NOT_FOUND` 起不来。用 `v0.1.1` 或更新。

**更新**：

```bash
dsh plugin --profile web update @yukitakasama/dsh-ptc-python
```

### 针对特定 dsh 实例安装

`dsh` 通过 `DSH_HOME` 定位实例。安装前把它指向目标实例的 home 目录即可：

**bash / WSL**：

```bash
DSH_HOME=/path/to/instance/.dsh dsh plugin --profile web add github:yukitakasama/dsh-ptc-python
```

**PowerShell**：

```powershell
$env:DSH_HOME="D:\path\to\instance\.dsh"; dsh plugin --profile web add github:yukitakasama/dsh-ptc-python
```

> 不要用 `--dir` 来指定实例：`dsh plugin` 会把 `--dir` 原样透传给 pnpm，它改变的是 pnpm 的工作目录，而 DSH 仍按 `DSH_HOME` 回写 profile 清单，两者会不一致。

### 方式二：源码本地安装

不走网络，速度最快：

```bash
git clone https://github.com/yukitakasama/dsh-ptc-python.git
cd dsh-ptc-python
node install.mjs
```

脚本会完成三件事：

1. 复制预设文件到 `<DSH_HOME>/.agent-presets/ptc-python/`
2. 复制插件包到 profile 的 `node_modules/`
3. 把本包登记进 profile `package.json` 的 `dsh.profile.bundles`

支持参数：`--home DIR`（别名 `--dir DIR`）、`--profile NAME`（默认 `web`）、`--force`、`--dry-run`。

### 方式三：手动安装

1. 把 `agent-presets/ptc-python/` 复制到 `<DSH_HOME>/.agent-presets/`；
2. 确保本包已在 profile 的 `node_modules/` 中（或把整个仓库复制到那里）；
3. 在 profile 的 `cordis.patch.yml` 中追加：

```yaml
- id: code-runtime
  name: '@yukitakasama/dsh-ptc-python/runtime'
  config:
    pythonPath: ''

- insert:
    - id: dsh-ptc-python
      name: '@yukitakasama/dsh-ptc-python'
```

**重启 DSH 后生效**。

## 前置条件

| 依赖 | 要求 |
| --- | --- |
| dsh | `>= 0.1.5-rc.1`（需要 `@deepseek-ai/dsh-agent-tool-presentation`） |
| Node.js | `>= 20` |
| CPython | **3.8+**，且能被找到 |

**零运行时依赖**：插件不 import 任何 npm 包，配置校验用 cordis 实际消费的 [Standard Schema](https://standardschema.dev) 接口自己实现（见[实现要点](#为什么没有运行时依赖)）。

Python 解释器的查找顺序（`pythonPath` 为空时）：

1. 配置项 `pythonPath`（非空则直接用）；
2. 环境变量 `DSH_PYTHON`；
3. `PATH` 上的 `python.exe` / `python3.exe`（Windows）或 `python3` / `python`（POSIX）；
4. Windows 常规安装位置 `%LOCALAPPDATA%\Programs\Python\Python3{10,11,12,13}\python.exe`。

找不到解释器时**不会导致插件挂载失败**，而是在第一次 `run_code` 时返回一条明确的 `exception`：

```
no Python interpreter found; set `pythonPath` on the dsh-ptc-python runtime row or the DSH_PYTHON environment variable
```

## 使用

1. Web 界面新建会话，模式选择器里选 **「PTC Python 模式」**；
2. 模型侧只会看到 `run_code` 一个工具，以及系统提示词里生成的一段 Python SDK 声明；
3. 让模型干活即可。例如：

```python
# 模型写进 run_code 的 code 参数（函数体，顶层 await / return 可用）
import asyncio

async def grep(path, pattern):
    return await tools.bash({"command": f"grep -rn {pattern} {path} || true"})

results = await asyncio.gather(*[grep(p, "TODO") for p in ["packages/core", "packages/api"]])
total = sum(len(r["output"].splitlines()) for r in results)
print(f"TODO 行数：{total}")
return total
```

模型只收到 `TODO 行数：…` 这一行和返回值 `total`；两次 `bash` 调用的原始输出不会进入对话。

## 配置

### 运行时（profile `cordis.patch.yml` 的 `code-runtime` 行）

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `pythonPath` | `''` | 解释器绝对路径；空表示按上面的顺序自动查找 |
| `isoFlags` | `['-I']` | 解释器隔离开关；`-I` 表示忽略用户 site-packages 与 `PYTHONPATH`/`PYTHONHOME` |
| `maxWallMs` | `300000` | 单次运行墙钟上限（毫秒），也是唯一的硬兜底 |
| `maxComputeMs` | `0` | 子进程 CPU 占用上限（毫秒）；`0` 关闭计量。采样需要 `tasklist`（Windows）或 `ps`（POSIX），不可用时只告警一次并退回墙钟 |
| `maxOutputBytes` | `67108864` | 日志 + 完成值的合计字节上限 |
| `maxFrameBytes` | `8388608` | 单个入站帧在解析前的字节上限 |
| `cpuSeconds` | `60` | POSIX `RLIMIT_CPU`；Windows 无 `resource` 模块时忽略 |
| `addressSpaceBytes` | `2147483648` | POSIX `RLIMIT_AS`；同上忽略 |
| `maxLogBytes` | `1048576` | 子进程侧日志账本预算 |
| `maxValueBytes` | `4194304` | 完成值渲染后的字节上限 |
| `bootTimeoutMs` | `30000` | 子进程确认 boot 的时限 |

### 安装器（`dsh-ptc-python` 行）

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `force` | `false` | 预设已存在时是否用包内文件覆盖（保留用户额外文件） |

## 实现要点

这一节记录「为什么是这个形状」，改动代码前值得先读。

### 为什么没有运行时依赖

cordis 解析插件配置走的不是某个 schema 库的私有 API，而是 **Standard Schema v1**：

```js
// cordis 的 resolveConfig 内部
const result = runtime.Config['~standard'].validate(rawConfig)
if (result.issues) throw new ValidationError(result.issues)
return result.value
```

所以 `Config` 只要是「暴露 `~standard.validate` 的对象」就够了，不必来自 schema 库。本插件按这个接口自己实现了 `lib/config-schema.js`，于是**整个插件不 import 任何 npm 包**。

这不是洁癖，是因为替代方案都更糟：

- **把 `@deepseek-ai/schemastery` 声明为 peer**：它确实是生态里同层插件的 peer，但 `nodeLinker: hoisted` + `auto-install-peers=false` 下，pnpm 只有在**足够多其他插件也声明它**时才会把它提升到 `<profile>/node_modules/`。实测：在只装本插件的干净 profile 里它**不在**，于是插件会在真正干活之前就以 `ERR_MODULE_NOT_FOUND` 加载失败——这对一个要给别人装的插件是最坏的失败形态；
- **声明为 dependency**：pnpm 会在插件自己的 `node_modules/` 里再嵌一份，而该 profile 的 `.npmrc` 明确写着核心包只能来自 CLI 依赖树。

`Config` 同时暴露 `defaults`，让 `cordis.patch.yml` 与 schema 的默认值能被测试强制对齐。

### 为什么不用 fd 3 双向句柄

工具调用天生是双向的：子进程要**发** `call`，同时**等** `reply`。最自然的写法是一个 fd 3 双向句柄——协议文档也是这么描述的（`PROTOCOL_FD = 3`，`stdio: ['pipe','pipe','pipe','pipe']`）。

在 Windows 上这会死锁。实测结论（`tests/` 与开发期探针一致）：

- 一个线程阻塞在 fd 3 的 `readline()` 时，**另一个线程对同一句柄的 `write()` 不会完成**；
- 换成 `os.read`/`os.write` 裸系统调用也一样；
- 换成「读用 `os.dup` 的 fd、写用另一个 `os.dup` 的 fd」也一样；
- **把读写拆到两个独立管道就正常**。

所以协议改成：子进程从 **stdin 读**宿主帧、向 **stdout 写**子进程帧。这两个方向由 Node 分别建管道，互不阻塞。

子进程在启动早期就把 fd 1 复制一份给协议用，然后用 `os.dup2(2, 1)` 把「程序的原生 stdout」指向 stderr：程序里任何绕过 Python 层的写入（C 扩展、子进程）都会落到 stderr，被宿主当作兜底日志收下，而不会污染帧流。

### 为什么只有一个线程读

同一个 Windows 管道限制还意味着：既然读会阻塞写，那就**永远不要让多个线程同时碰读侧**。因此：

- 握手（`boot`、`run` 两帧）在**主线程**上顺序读，此时读线程还没启动；
- 握手完成后才启动唯一的 daemon 读线程，专门收 `reply`；
- 写侧由 `ProtocolChannel._write_lock` 串行化（日志、call、done 都可能从不同协程写出）。

读线程如果遇到无法解析的帧（例如嵌套深度超过解释器能解析的程度），会让所有待回包的调用**立刻失败**，而不是静默退出让程序永远等下去。

### 程序包装与行号

程序作为 async 函数体执行，包装方式固定为两行：

```python
async def __dsh_main__():
<空行>
    <程序，整体缩进一级>
```

- 空行是必需的：它让程序**每一行都保持自己的行号**，同时允许程序以注释或空行开头仍属于函数体；
- 整体缩进一级，让顶层 `return` 合法，同时**不改动模型自己的相对缩进**；
- 包装占 2 行（`WRAPPER_LINES`），所以 traceback 里报告的行号会**减去 2**，模型看到的就是自己写的行号；
- 子进程自身的栈帧会被**整段丢弃**——包装的尾部行会把它们的行号整体推偏，给一个错误的行号比不给更糟。

### 深度无上限

能力 seam 的 `CodeJsonValue` 不限制嵌套深度，所以两侧都不能用会按层递归的编码器：

- 宿主侧 `lib/json-wire.js` 的 `encodeJsonPlain` / `checkDoneValue` / `hasNonLosslessNumber` 全部用显式栈迭代；
- 子进程侧自己实现了一份迭代式 JSON 编码器（`encode_value`），因为 `json.dumps` 既按层递归、又受 `sys.getrecursionlimit()` 限制；
- 解码侧 `json.loads` 同样是递归的，所以 `parse_json` 在**解析期间临时提高** `sys.getrecursionlimit()`（`DEEP_PARSE_RECURSION_LIMIT`）。原子性由宿主的 `maxFrameBytes` 保证，不是靠这个上限。

### 有界的承诺到哪一步

- 日志账本两侧各自计量，**都包含 JSON 数组语法与转义**，所以两边算的是同一笔字节；子进程先耗尽时会发一条 `truncated: true` 的标记帧，宿主据此在**同一点**停止捕获，只留一条标记；
- 入站帧由宿主自己的累加器切分（**不用 `readline`**，它内部缓冲且无法设界）：先按 `\n` 切，剩下的残片超过 `maxFrameBytes` 立即判负；
- 子进程暴毙 / 超时 / 中止都会硬杀**整棵进程树**（Windows 走 `taskkill /T /F`），并保证在限期内一定结算，绝不会让一次运行或一次 dispose 悬住。

## 开发

```bash
npm run check   # 所有 JS 文件 node --check + py_compile
npm test        # 53 个测试
```

测试分两层：

- `tests/runtime.test.js` —— **真子进程**测试（40 个）。每个执行用例都真的起一个 `python -I` 子进程，覆盖协议编解码、绑定桥接、并发、深度、字节上限、超时、中止、dispose；
- `tests/preset.test.js` —— 预设与打包契约测试（13 个）。校验 `agent.cordis.yml` / `preset.yml` / `cordis.patch.yml` / `package.json` 的形状（行 id 唯一、group 带 realm、persona 用 `prefix`/`suffix`、patch 覆盖的是 `code-runtime`、patch 里的每个字段都存在于 schema 且值与默认一致、manifest 列出的文件都存在）。

> 运行期只需要 Node 内置模块 + 一个 CPython 解释器。测试额外需要 `node_modules/` 中有 `yaml`，以及（用于 seam 一致性断言的）`@deepseek-ai/dsh-code-runtime`。seam 包**故意不是依赖**——profile 绝不能自己解析一份核心包，所以后端用 `ctx.provide('codeRuntime', ...)` 注册、完全不 import 它。检测到 seam 包时才运行一致性断言，检测不到就静默跳过。

## 与官方模式的关系

本插件**不改变**任何官方模式的行为：

| 会话选择 | 结果 |
| --- | --- |
| **原生（native）** | 完全不受影响。`run_code` 不出现，工具照旧逐个直接调用。 |
| 其他预设 | 上层 tool-presentation 行照常工作，不受影响。 |
| **PTC Python 模式** | 只调用 `run_code`，程序用 Python，工具以 `await tools.<name>(args)` 绑定触达。 |

插件替换的是**运行时后端**（`code-runtime` 行），不是呈现方式：呈现方式始终由预设里的 `tool-presentation` 行决定，官方预设说的 `native` / `ptc` 该怎样还怎样。

### 但 PTC 的两种语言无法在同一进程共存

**整篇部署只有一门 `run_code` 语言**：装了本插件，TS 版 PTC 就没有了；不装，Python 版 PTC 就没有。这不是本插件的偷懒，而是 seam 当前的设计边界，理由在上游代码里写得很明白：

```js
// @deepseek-ai/dsh-tools，requireCodeRuntime 的文档注释
// Assembly and run_code execution read separately, so the language is not
// bound to a request. Harmless while one published backend exists — both
// reads return the same flavor — but a reload that swapped in a second
// language between them would hand a program written against one SDK to the
// other. Binding it is deferred until a second backend ships (the first
// point it is testable).
```

具体卡在三处：

1. **`ctx.codeRuntime` 是宿主平面单例**。`dsh-tools` 通过 `this.ctx.get("codeRuntime")` 取它——这里的 `this.ctx` 是**工具注册表自己的**上下文，而注册表在 base 层挂载（`id: tools`），不能在预设里再挂一份（它的文档注释：*"The tool registry itself stays on the host plane … it cannot move into a preset"*）。所以**每个会话看不到不同的 runtime**，也没法按 scope 分派；
2. **`run_code` 是保留名**，注册表明确拒绝注册或遮蔽它（*"tool name "run_code" is reserved for the PTC mode presentation transport and cannot be registered or shadowed"*），所以没法给某个预设单独塞一个自己的 `run_code`；
3. **语言在 `runtime.language` 上**，是加载时那个实现的固定属性；而 `dsh-tools` 在组装提示词、发 `run_code` schema、执行程序这三处**分开读同一个 runtime**——上游注释承认这正是「第二个后端出现时」才需要绑定的问题。

**最后一处才是真正的拦路石**，值得说细一点，因为它决定了要改哪里：`run_code` 的 schema 里那两个语言相关字段是通过**无 scope 的闭包**读出来的——

```ts
// @deepseek-ai/dsh-tools/src/index.ts:914-923
private requireCodeTransport(): ToolDefinition {
    this.ptcTransport ??= createRunCodeTool(this, {
      requireRuntime: () => this.requireCodeRuntime(this.defaultMode),
      peekRuntime: () => this.ctx.get('codeRuntime'),
      ...
```

`createRunCodeTool` 是**单例**（`this.ptcTransport ??=`），只在 schema getter 里调用那两个闭包，而 `CodeRuntime.language` 是 `abstract readonly language: string`——静态定值。所以**模型看到的 `run_code` schema 与 SDK 段落是按一门语言固定的**，不可能按会话变。

与之相对，**执行阶段其实已经拿得到调用方**：`ToolExecutionInput.agent?: Agent`。也就是说这个功能缺的不是执行期信息，而是「schema 生成也按 scope 选语言」这一步——上游注释里那句 *"Binding it is deferred until a second backend ships"* 说的就是它。要补这一步，改动落在 DSH 核心的 `dsh-tools`（以及让 runtime 解析按 scope 进行），**没有任何预设或插件层的写法能绕过**。

**所以唯一的可行形态是：一门语言一次部署，且必须显式替换 `code-runtime` 行。** 本插件采用的就是这个形态。若将来上游把语言绑定到请求（上面注释里预留的那一步），本插件的后端不用改——它已经是一个标准的 `CodeRuntime` 实现。

### 为什么必须替换全局行，而不能加在自己的 realm 里

预设的服务默认必须放在 `isolate` realm 里（否则 `dsh-agent-presets` 会拒绝：*"a preset service must sit behind an isolate realm or move to the host plane"*）。理论上本插件可以把 Python runtime 放进 realm，让预设内的行解析到它——**但工具注册表在 realm 之外**，它读的是 base 层那份 runtime，所以那样做只会让提示词按 Python 渲染、实际却把程序交给 TS 执行，比不能共存更糟。因此只能替换 base 行。

替换 `code-runtime` 行是 profile 层的正当机制：profile 补丁本来就是用来覆盖 base 层行的。若同时装了另一个也替换该行的插件，**两者会冲突**（后加载的生效），这一点无解。

## 限制

- **一个进程只有一门语言**：`ctx.codeRuntime` 是宿主平面单例，本插件通过**替换** `code-runtime` 行来安装 Python 后端。装了本插件，所有 PTC 模式会话都用 Python；不能同时提供一个 TypeScript PTC 预设（原因与上游代码证据见[与官方模式的关系](#与官方模式的关系)）；
- **CPU 计量依赖外部命令**：Windows 需要 `tasklist`、POSIX 需要 `ps`。取不到进程 CPU 时间时只告警一次，运行仍由 `maxWallMs` 兜底；
- **POSIX 资源限制在 Windows 无效**：`resource` 模块不存在，`cpuSeconds` / `addressSpaceBytes` 被忽略（已在子进程里显式跳过并注释）；
- **程序的 stdin 是立即 EOF**：子进程装上了一个立刻返回 EOF 的 `sys.stdin`，这样 `input()` 会立刻抛 `EOFError` 而不是挂到墙钟上限。程序要接触外部世界请走工具绑定；
- **`pip` 不可用只是没有第三方包**：`-I` 会忽略用户 site-packages。需要第三方库时，要么把 `isoFlags` 改成 `[]`（去掉隔离，自己承担后果），要么在系统 Python 里装；
- **中间值只存在于执行局部**：工具返回的中间结果无法从会话日志重建。只有 `run_code` 的外层结果会进入对话与日志。

## 项目结构

见 [`PROJECT_STRUCTURE.md`](PROJECT_STRUCTURE.md)。

## 版本历史

见 [`CHANGELOG.md`](CHANGELOG.md)。

## License

MIT
