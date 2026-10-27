# DSH 陪伴日记记忆

TypeScript 编写的 DSH 插件，为长期陪伴和个人数字分身保存日记、延续情感与自我反思。支持百炼 Embedding + Rerank、SQLite 本地记忆、自动召回，以及 DSH 原生安全压缩。

目标运行时：**DSH `0.2.1-rc.3`**，已对照该版本原生实现和 [DeepSeek Harness 官方仓库](https://github.com/deepseek-ai/deepseek-harness)。`engines.dsh` 限定了这个版本；升级 DSH 后应先用相应 SDK 验证，再调整版本范围。

## 安装与开始使用

可直接从 [GitHub Releases](https://github.com/cyhddyx/dsh-diary-memory/releases) 下载已编译的 `.tgz` 安装包。若从源码开始，先克隆仓库并进入项目目录：

```powershell
git clone https://github.com/cyhddyx/dsh-diary-memory.git
cd dsh-diary-memory
```

1. 在此项目执行 `npm ci`、`npm run build`；分发包已包含编译后的 `lib/`，使用分发包时不需要编译。
2. 在 DSH 的插件管理器中安装本地组合包，目标选择这个项目目录或生成的 `dsh-diary-memory-0.1.0.tgz`。也可以让 DSH 的插件管理工具执行：

   ```json
   { "action": "install_bundle", "target": "E:\\Project\\dsh-diary-memory" }
   ```

   由 DSH 的插件管理器维护 profile 配置与依赖。安装结果显示 `restart-required` 时重启 DSH。这是组合包安装，不是 MCP 服务器配置。

3. 在插件组件 `diary-memory` 的配置中填写百炼 `apiKey`，或给 **DSH 进程**设置 `DSH_DIARY_BAILIAN_API_KEY` / `DASHSCOPE_API_KEY` 环境变量。Key 在 schema 中标记为 `secret`，不要写进仓库。
4. 新建会话，选择 **“陪伴日记”**（preset ID `diary-companion`），并配置正常的 DSH 会话模型。日记默认使用该模型生成；百炼负责向量与重排。
5. 默认完成 20 轮后，在下一次 `agent/pre-step` 触发日记压缩，保留最近 2 个用户输入及其后续消息。`/compact` 手动压缩和原生上下文溢出恢复也会先保存日记。

安装包会新增预设，不会给现有的工作型预设添加记忆。已有会话保留原先的预设组合；要用于已有的自定义数字分身，应在其预设的原生 compaction 隔离组中，把 `@deepseek-ai/dsh-compaction-basic` 替换为 `dsh-diary-memory/compaction`，并在预设中加入 `dsh-diary-memory/tools`。保留自己的 persona 与其他工具。**不要在同一隔离组同时启用两个 compaction 提供方。**

`better-sqlite3` 是本机原生模块。安装器若提示它的构建脚本待处理，应按 DSH 的提示处理；其二进制必须匹配 DSH **宿主 Node.js** 的 ABI。开发时如果 npm 禁用了安装脚本，可针对这个依赖执行 `npm rebuild better-sqlite3 --ignore-scripts=false`。无需改用 Electron 渲染进程的 ABI。

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
    rerankModel: gte-rerank-v2
    autoRecall: true
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
| `rerankModel` | `gte-rerank-v2` | 候选日记的重排模型 |
| `candidateCount` / `recallCount` | `30` / `6` | 余弦候选数量 / 重排后返回数量 |
| `diaryProvider` / `diaryModel` | 空 / 空 | 同时设置可指定 DSH 日记模型，否则继承会话路由 |
| `diaryMaxTokens` | `3000` | 日记生成输出预算；截断输出不入库 |
| `diaryInputMaxChars` | `200000` | 日记生成输入上限；超限保留上下文并报错，不静默截掉历史 |
| `recentDiaryCount` | `3` | 日记生成参考的最近已提交日记数 |
| `autoRecall` | `true` | 新用户输入自动召回；还可手动调用 `diary_recall` |
| `timeoutMs` / `retries` | `30000` / `2` | 百炼每次请求超时与瞬时失败重试次数 |

轮次计数来自 `sessionProjections` 对 `turn/end` 的增量折叠：成功完成的 turn 计一次，多个工具步骤不额外计数。写入压缩 checkpoint 后重新计数。轮次阈值之外，DSH 原生 token 压力与溢出保护仍然启用。

不同 `namespace` 不会相互检索。默认新预设里的会话共享 `companion` 空间；不同人物或用途应配置不同的空间与组合。修改 embedding 的端点、模型或维度后，旧向量不会被拿来混算；如需继续使用旧记忆，应恢复原配置。当前版本不提供自动重建向量索引。

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

`src/` 为 TypeScript，`lib/` 为 ESM、声明与 source map。开发依赖固定使用官方 `0.2.1-rc.3` SDK；分发包依赖 DSH 提供的原生模块，不附带一套 DSH。

测试使用真实的 Cordis、Session、sessionProjections、TokenMeter 和 BasicCompactionEngine；LLM 与百炼使用测试提供方，另外通过本地 HTTP 服务器验证原生 fetch 请求结构。覆盖工具边界、向量隔离、rerank、同会话并发、手动/自动/溢出压缩、失败重试、取消、SQLite 重开与日志重放恢复。没有使用真实 Key，也没有把真实个人会话传给云服务。

参考：

- [官方插件开发文档](https://github.com/deepseek-ai/deepseek-harness/blob/main/packages/preset/agent-preset/skills/cordis-plugin-development/references/host-plugin.md)
- [Compaction 扩展接口](https://github.com/deepseek-ai/deepseek-harness/tree/main/packages/compaction/compaction)
- [BasicCompactionEngine](https://github.com/deepseek-ai/deepseek-harness/tree/main/packages/compaction/compaction-basic)
- [预设与服务隔离](https://github.com/deepseek-ai/deepseek-harness/tree/main/packages/preset/agent-preset-registry)
