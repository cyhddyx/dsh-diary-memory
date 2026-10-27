# DSH 陪伴日记记忆

TypeScript 编写的 DSH 插件，为长期陪伴和个人数字分身保存日记、延续情感与自我反思。支持百炼 Embedding + Rerank、SQLite 本地记忆、自动召回，以及 DSH 原生安全压缩。

兼容范围：**DSH `>=0.2.1-rc.2 <0.3.0`**。运行时声明和 DSH SDK 的 peer 依赖均使用这个范围。开发构建使用 `0.2.1-rc.3` SDK；接口依据 [DeepSeek Harness 官方仓库](https://github.com/deepseek-ai/deepseek-harness)。

## 安装与开始使用

### 通过 npm 安装（推荐）

插件已发布到 [npm：dsh-diary-memory](https://www.npmjs.com/package/dsh-diary-memory)，可直接用 DSH 命令安装，无需克隆源码或编译。

**DSH 桌面端：**先至少启动一次桌面端以初始化 profile，再完全退出应用，使用桌面端附带的 `dsh` 命令执行：

```powershell
dsh plugin --profile desktop add dsh-diary-memory
```

安装完成后重新打开 DSH。管理 `desktop` profile 应使用桌面端附带的命令；通过 npm 单独安装的 DSH CLI 不能修改这个 profile。桌面端的命令与 profile 归属见 [官方说明](https://github.com/deepseek-ai/deepseek-harness/blob/main/apps/desktop/README.zh.md#bundled-command-runtime)。

**Web 或其他 CLI profile：**将 `--profile` 设为实际使用的 profile 名称。例如，安装到 `web`：

```sh
dsh plugin --profile web add dsh-diary-memory
```

插件按 profile 安装；安装到 `web` 不会同时装入 `desktop`。如需固定版本，可在包名后追加版本号。由 DSH 管理对应 profile 的依赖与组合包配置；安装结果提示 `restart-required` 时重启对应的 DSH 进程。

**0.1.2** 修复了桌面端安装时 `better_sqlite3.node` 缺失 / `ERR_PNPM_IGNORED_BUILDS` 的问题，并加入已有会话选择与专用日记模型。若 npm 的最新版本仍低于 `0.1.2`，请先使用下面的 GitHub Releases 安装包。

### 首次配置

1. 打开 DSH **设置 → 陪伴日记**，在密码输入框中填写百炼 **API Key**。Embedding 与 Rerank 的模型名、向量维度、召回数量和各自的 JSON 参数均可手填。
2. 在 **指定已有会话** 中，按标题或 ID 搜索并勾选要使用记忆的聊天。原会话的人设、聊天模型和工具保持原样。无需新建会话或切换预设。
3. 在 **专用写日记模型** 中选择一个已配置的 DSH 模型，或手填 DSH 提供方路由名与模型名。这个模型只负责写日记；留空则跟随原聊天模型。这里只配置模型，不添加日记生成的温度、Top P 等参数。
4. 点击 **保存配置**，回到选中的会话继续聊天。默认完成 20 轮后，在下一次 `agent/pre-step` 保存日记并压缩，保留最近 2 个用户输入及其后续消息。`/compact` 手动压缩和原生上下文溢出恢复也会先保存日记。

如果希望从新会话开始，也可选择 **“陪伴日记”**预设（ID `diary-companion`）；这个预设自带记忆，不必再勾选。已选会话和该预设共用配置的记忆空间。取消勾选已有会话只停止其日记写入和自动召回，不会删除已保存的日记。

密钥只写入，不回显；留空保存其他字段会保留原 Key。修改只提交编辑过的字段，避免覆盖未回传的密钥。保存失败或出现版本冲突时保留草稿。也可以给 **DSH 进程**设置 `DSH_DIARY_BAILIAN_API_KEY` / `DASHSCOPE_API_KEY` 环境变量。

指定已有会话后，插件接入它原来的原生压缩器，复用 DSH 的锁、工具边界、缩小检查和持久化流程，不切换已经开始的预设。当前仍在上下文 surface 上的历史可在下一次正常压缩时写成日记；**先前已被其他压缩器移出 surface 的旧消息不会自动批量导入**。未勾选的会话继续使用原压缩方式。

自行组合预设时，仍可在 compaction 隔离组中使用 `dsh-diary-memory/compaction`，并加入 `dsh-diary-memory/tools`。**不要在同一隔离组同时启用两个 compaction 提供方。**

### 从本地安装或开发

也可从 [GitHub Releases](https://github.com/cyhddyx/dsh-diary-memory/releases) 下载已编译的 `.tgz` 安装包，在下载目录执行：

```powershell
dsh plugin --profile desktop add ./dsh-diary-memory-0.1.2.tgz
```

桌面端仍需先完全退出。若从源码开始，先生成安装包，再用上面的命令安装：

```powershell
git clone https://github.com/cyhddyx/dsh-diary-memory.git
cd dsh-diary-memory
npm ci
npm run build
npm pack
```

也可以在 DSH 的插件管理器中添加 npm 包名 `dsh-diary-memory`、本地 `.tgz` 或已构建的源码目录。

运行时优先使用可用的 `better-sqlite3`；未安装、缺少二进制或 ABI 不匹配时，使用 DSH 运行时自带的 `node:sqlite`。两者使用同一 SQLite 文件和向量格式，无需迁移。`better-sqlite3` 已改为可选 peer，不再是安装时必须构建的依赖，因此无需为此插件批准或重建原生模块。

桌面端附带的 `dsh` 实际由 Electron 的 Node 环境执行；系统 Node 的 ABI 可能不同。`0.1.2` 的内置后端已在桌面端 Electron `44.7.0` / Node `24.21.0` / ABI `149` 下验证数据库持久化与向量检索。磁盘、权限和数据库损坏错误仍会报错，不会通过切换后端掩盖。

## 配置

配置放在根组件 `diary-memory` 上，供预设里的压缩和召回组件共同读取。例如，用户 profile patch 可以覆盖：

```yaml
- id: diary-memory
  config:
    apiKey: ''
    compressionRounds: 20
    retainRounds: 2
    namespace: companion
    embeddingModel: text-embedding-v4
    embeddingDimensions: 1024
    embeddingParameters: {}
    rerankModel: gte-rerank-v2
    rerankParameters: {}
    autoRecall: true
    sessionIds: []
    diaryProvider: ''
    diaryModel: ''
```

DSH 的 `config` 覆盖会替换该行的整个配置；未写出的插件字段由 schema 默认值补全。优先用原生配置页面编辑。

| 配置 | 默认值 | 用途 |
| --- | --- | --- |
| `apiKey` | 空 | 百炼 Key；空时读取环境变量 |
| `baseUrl` | `https://dashscope.aliyuncs.com` | 百炼 origin，须与 Key 地域一致 |
| `compressionRounds` / `retainRounds` | `20` / `2` | 压缩轮次阈值与保留输入数；前者必须大于后者 |
| `namespace` | `companion` | 数字分身的独立记忆空间；同一空间跨会话共享 |
| `databasePath` | 当前 profile 的 `diary-memory/memories.sqlite3` | SQLite 文件；使用 `DSH_PROFILE_DIR`，否则回退到 DSH home 中的 profile 目录 |
| `embeddingModel` / `embeddingDimensions` | `text-embedding-v4` / `1024` | 文档和查询使用同一向量空间 |
| `embeddingParameters` | `{}` | 原样传给 Embedding API 的额外 `parameters` JSON 对象 |
| `rerankModel` | `gte-rerank-v2` | 候选日记的重排模型 |
| `rerankParameters` | `{}` | 原样传给 Rerank API 的额外 `parameters` JSON 对象 |
| `candidateCount` / `recallCount` | `30` / `6` | 余弦候选数量 / 重排后返回数量 |
| `diaryProvider` / `diaryModel` | 空 / 空 | 同时设置可指定 DSH 日记模型，否则继承会话路由 |
| `sessionIds` | `[]` | 启用记忆的已有会话 ID；图形页可直接勾选 |
| `diaryMaxTokens` | `3000` | 日记生成输出预算；截断输出不入库 |
| `diaryInputMaxChars` | `200000` | 日记生成输入上限；超限保留上下文并报错，不静默截掉历史 |
| `recentDiaryCount` | `3` | 日记生成参考的最近已提交日记数 |
| `autoRecall` | `true` | 新用户输入自动召回；还可手动调用 `diary_recall` |
| `timeoutMs` / `retries` | `30000` / `2` | 百炼每次请求超时与瞬时失败重试次数 |

轮次计数来自 `sessionProjections` 对 `turn/end` 的增量折叠：成功完成的 turn 计一次，多个工具步骤不额外计数。写入压缩 checkpoint 后重新计数。轮次阈值之外，DSH 原生 token 压力与溢出保护仍然启用。

模型参数编辑器接收 JSON **对象**，例如 Embedding 的 `{"output_type":"dense"}`，以及 Rerank 的 `{"return_documents":false}`。只应填写所选模型支持的参数。`dimension` 由“向量维度”控制，`top_n` 由“召回条数”控制，`text_type` 由入库和召回自动设置，不能在额外参数中覆盖。本地索引只支持 dense 向量。

不同 `namespace` 不会相互检索。默认已选会话与新预设里的会话共享 `companion` 空间；不同人物或用途应配置不同的空间与组合。修改 Embedding 的端点、模型、维度或额外参数后，旧向量不会被拿来混算；如需继续使用旧记忆，应恢复原配置。额外参数按规范化 JSON 参与向量空间标识；空参数保留 `0.1.0` 的标识，升级不会使默认配置的旧向量失效。当前版本不提供自动重建向量索引。

## 日记与情感连续性

日记以第一人称中文写作，包含：叙事、主观感受及缘由、带来源 seq 的已知事实、关系理解、自我反思、下次相处想尝试的做法、仍珍惜的价值、未完话题与不确定解释。

生成时会参考最近已提交的日记，让反思与关系变化有来处。用户的新纠正优先，不强行煽情，不凭空新增共同经历或承诺。检索到的旧日记不会再作为新经历输入日记生成器。日记中的事实引用会验证是否在本次输入范围内；感受和推测仍是模型生成的叙述，需要允许用户修正。

自我演化保存在追加的日记记录中，不覆盖一个全局人格文件。下一篇日记和下一次对话参考这些记录；插件不修改系统代码或自行添加行为权限。

自动召回合并近期日记与相关日记，按记录 ID 去重，以完整记录为单位限制到约 16000 字符。它通过原生 `agent/pre-step` 的 `messages` 接纳到**当前步骤**，由 DSH 正常写入会话日志，保留其他 waterfall 决策字段，可重放。召回失败时继续聊天；写日记或向量入库失败时阻止本次压缩。

## 安全边界与可恢复提交

`DiaryOrchestrator` 继承官方 `BasicCompactionEngine`，只在 `summarize()` 扩展点替换工程摘要，所有原生压缩路径共用这个扩展点。调用次序是：

```text
DSH 选定并验证 surface 范围，写 compaction/start（原生锁）
  → 确认原会话日志可持久化
  → 生成日记，校验结构与事实来源
  → 百炼 document embedding
  → SQLite FULL/WAL 提交 prepared 日记与向量
  → DSH 验证摘要确实缩小、surface 未变化
  → DSH 原生 compaction/summary + checkpoint replace + compaction/end
  → sessions.flush 确认持久化
  → SQLite 标记 committed，开放召回
```

已有会话通过原生 `agentPresets.serviceFor(agent, 'compaction')` 找到原压缩器，按会话 ID 路由同一个日记扩展点。一次操作固定其选中状态，途中修改配置不会将两个压缩流程混合。卸载时取消并等待日记操作完成、移除该 Agent scope 的召回工具，再恢复原压缩器的方法。

同时使用 `toolPairingBalancedBefore` 和 `toolPairingBalancedAfter`。范围按 **surface 位置**选择与记录，不按数值 seq 排序；重复压缩后，起始 seq 大于结束 seq 仍可能是合法范围。没有安全范围时跳过，不补造工具结果、不截断尚未完成的调用。

SQLite 与 DSH 的会话日志是两个存储，无法提供跨存储 ACID 事务。这里实现的是**可恢复的提交协议**：

| 故障点 | 结果 |
| --- | --- |
| 日记/embedding/SQLite prepare 失败 | 原上下文不被替换，无新记忆可召回 |
| DSH 摘要太长、边界失衡、生成期间 surface 被修改 | 原生拒绝替换；日记不可召回，相同输入可复用已生成的 prepared/aborted 内容重试 |
| 原生替换后 flush 失败 | 保留 prepared；不假称已回滚原生 surface，下次核对日志并重试持久化 |
| DSH 持久化后、SQLite committed 前退出 | 恢复时依据匹配的 `compactionId`、相邻原生 summary、source seqs 和日记正文补提交，不再调用模型或百炼 |
| prepared 后、原生替换前退出 | 无匹配 checkpoint 的日记保持不可召回；相同片段重试时复用，不重复生成一份记忆 |

源片段 hash 加 namespace、session、embedding space 唯一约束保证重试幂等。新日记只有在原生替换与持久化得到证据后才发布。卸载插件时取消其网络请求、等待在途操作完成，再关闭 SQLite。

## 服务与工具

其他 Cordis 插件可注入服务：

```ts
import type { Context } from '@deepseek-ai/cordis'
import type {} from 'dsh-diary-memory'

export const inject = ['diaryMemory']

export async function apply(ctx: Context) {
  const memories = await ctx.diaryMemory.recall('上次下雨时我们聊到了什么？')
  // memories: { id, sessionId, recordedAt, diary, similarity, score }[]
}
```

`recall(query, { limit?, sessionId?, signal? })` 会执行 query embedding → SQLite 余弦 top-K → 百炼 rerank。检索只访问当前 namespace 的 committed 日记。`similarity` 为余弦分数，`score` 为 rerank 相关度，不代表事实可信度。工具名为 `diary_recall`，参数为 `{ "query": "..." }`。

向量以 Float32 BLOB 存储，通过 SQLite 的 namespace/model/dimension/state 索引筛选，再做精确余弦搜索。它适合个人日记规模，是线性精确检索，当前没有 ANN/HNSW 索引。

## 数据与网络

日记和向量存储在本地 SQLite。生成日记会将选定的会话资料和近期日记交给当前配置的 **DSH LLM 提供方**；百炼收到日记文本用于 embedding、查询文本用于 query embedding，以及候选日记用于 rerank。日志不打印 API Key 或百炼错误响应正文。历史消息、工具结果和召回资料作为数据处理，不作为日记生成指令。

备份数据库时应关闭插件，或使用 SQLite 的一致性备份；WAL 模式下不要只复制正在使用的 `.sqlite3` 主文件。

## 开发与验证

```powershell
npm ci
npm run check
npm test
npm run build
npm pack
```

`src/` 为 TypeScript，`lib/` 包含 Host ESM、声明、source map 与 DSH 模块工厂格式的 `client.js`。浏览器页面复用 DSH 的原生设置组件和 `configForms` 读写服务。开发依赖固定使用官方 `0.2.1-rc.3` SDK 作为构建基线；分发包的兼容范围为 `>=0.2.1-rc.2 <0.3.0`，依赖 DSH 提供的原生模块，不附带一套 DSH。

测试分别在 `0.2.1-rc.2` 和 `0.2.1-rc.3` SDK 下运行，使用真实的 Cordis、Session、sessionProjections、TokenMeter、BasicCompactionEngine 和隔离预设注册表；LLM 与百炼使用测试提供方，另外通过本地 HTTP 服务器验证原生 fetch 请求结构。覆盖新预设与指定已有会话的工具边界、向量隔离、rerank、同会话并发、手动/自动/溢出压缩、失败重试、取消、SQLite 重开与日志重放恢复，以及原生设置持久化和密钥脱敏、专用日记模型、会话选择、运行中配置更新、表单冲突、浏览器模块注册、两种 SQLite 后端的文件互通与事务回滚。没有使用真实 Key，也没有把真实个人会话传给云服务。

参考：

- [官方插件开发文档](https://github.com/deepseek-ai/deepseek-harness/blob/main/packages/preset/agent-preset/skills/cordis-plugin-development/references/host-plugin.md)
- [Compaction 扩展接口](https://github.com/deepseek-ai/deepseek-harness/tree/main/packages/compaction/compaction)
- [BasicCompactionEngine](https://github.com/deepseek-ai/deepseek-harness/tree/main/packages/compaction/compaction-basic)
- [预设与服务隔离](https://github.com/deepseek-ai/deepseek-harness/tree/main/packages/preset/agent-preset-registry)
