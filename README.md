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
dsh plugin --profile web add github:yukitakasama/dsh-ptc-python#v0.1.0
```

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
| `@deepseek-ai/schemastery` | `^3.18.2`；声明为 peerDependency，profile 用 hoisted 布局安装时已在 `<profile>/node_modules/` 一层，无需额外操作 |

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

> 需要 `node_modules/` 中有 `@deepseek-ai/schemastery`、`yaml`，以及（用于 seam 一致性断言的）`@deepseek-ai/dsh-code-runtime`。前两者是普通依赖；seam 包**故意不是依赖**——profile 绝不能自己解析一份核心包，所以后端用 `ctx.provide('codeRuntime', ...)` 注册、完全不 import 它。检测到 seam 包时才运行一致性断言，检测不到就静默跳过。

## 限制

- **一个进程只有一门语言**：`ctx.codeRuntime` 是宿主平面单例，本插件通过**替换** `code-runtime` 行来安装 Python 后端。装了本插件，所有 PTC 模式会话都用 Python；不能同时提供一个 TypeScript PTC 预设；
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
