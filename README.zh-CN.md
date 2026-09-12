# yjs-v13-deletion-attribution

一个用于 Yjs v13 的删除归属库。

它解决的问题是：**Yjs 能知道哪些 CRDT item 被删除，却不会在删除墓碑中保存执行删除的用户**。本项目在协同事务发生时捕获用户身份和 Yjs clock 区间，在生成快照时再把这些区间映射回当前文档中的墓碑位置，从而得到删除作者。

## 适用场景

- Yjs + Hocuspocus 协同编辑
- 需要在版本历史或 diff 中显示“谁删除了这段内容”
- 删除内容已经从当前文档消失，但仍要保留删除作者
- 需要把删除作者写入快照、审计日志或外部事件

本库只负责删除归属算法和存储边界，不绑定 NestJS、Hocuspocus、Redis 或某个数据库。

## 为什么不能从 Yjs 快照直接反推删除者

Yjs 的 DeleteSet 只能表达：

```text
被删除内容所属的 clientID + clock 区间
```

它不表达：

```text
执行这次删除的业务用户
```

删除完成后，Yjs tombstone 可能只剩 `ContentDeleted`，原始内容和删除者都不可靠地保留。因此必须在删除事务发生时记录：

```text
(被删 item 的 clientID, clock 起点, clock 终点, authenticated username)
```

本项目中的类型是：

```ts
interface DeletionRecord {
  client: number
  from: number
  to: number
  author: string
}
```

## 工作流程

```text
客户端 SYNC_UPDATE
        │
        ├─ 解析本帧声明的 DeleteSet
        │
        ├─ Yjs applyUpdate 产生事务 deleteSet
        │
        ├─ 声明范围 ∩ 实际生效范围
        │
        ├─ 校验被删 item 在事务前已存在
        │
        ├─ 加上认证用户，生成 DeletionRecord
        │
        ├─ 写入 Redis / 内存队列
        │
        └─ 创建快照时 claim，匹配 tombstone 并输出 DeletionMark
```

输出采用零宽标记：

```ts
{ at: 7, author: 'alice' }
```

`at` 是删除内容在当前文档坐标中的锚点。删除内容已经不存在，因此不能可靠地表示为当前坐标中的 `[from, to)` 区间。

## 安全归属规则

### 不要只使用 `transaction.origin`

`origin` 只能说明哪个连接触发了 Yjs 事务，不能证明事务中的所有删除都由该用户发起。以下情况会造成误归属：

- `SyncStep2` 携带了其他用户的历史删除；
- Yjs `pendingDs` 在后续其他连接的事务中重放；
- 并发重复删除，后一次删除实际没有产生新的 deleteSet。

因此本库要求把“帧声明的删除”与“事务实际生效的删除”求交。

### 只允许删除服务端已知的 item

如果某个被删 item 在事务开始前还不存在于服务端，说明它可能是随本次离线同步一起到达、再被删除的。这个场景无法可靠区分“用户真实删除”与“同步历史”，本库选择跳过，避免把删除错误地归给无关用户。

### 使用 Yjs clock，不要保存编辑器位置

ProseMirror/Tiptap 坐标会随着后续编辑变化；Yjs clock 是稳定身份。位置只在读取快照时，根据当前 Y.Doc 中的墓碑重新计算。

## 快速开始

安装依赖：

```bash
npm install
```

运行测试：

```bash
npm run check
```

运行完整生命周期示例：

```bash
npm run example
```

示例代码位于 [`examples/complete-flow.ts`](./examples/complete-flow.ts)，展示：

1. 客户端生成包含删除的 Yjs update；
2. 服务端解析本帧 DeleteSet；
3. `DeletionClaimTracker` 将帧声明和事务按连接排队配对；
4. `captureDeletionRecords()` 生成带作者的删除记录；
5. `MemoryDeletionStore` 暂存并 claim 记录；
6. `attributeDeletions()` 从快照状态生成零宽删除归属。

## API 用法

```ts
import {
  attributeDeletions,
  captureDeletionRecords,
  collectTransactionDeletions,
  MemoryDeletionStore,
} from 'yjs-v13-deletion-attribution'

const store = new MemoryDeletionStore()

// 在 afterTransaction 中调用：
const records = captureDeletionRecords(
  {
    // clientID -> 事务开始前服务端已知的下一个 clock
    beforeState,
    deleteSet: transaction.deleteSet,
  },
  claimedRanges,       // 当前 SYNC_UPDATE 帧声明的删除范围
  authenticatedUser,   // 当前连接对应的业务用户名
)

await store.append(documentId, records)

// 创建快照时调用：
const claimed = await store.claim(documentId)
const deletions = attributeDeletions(doc, 'default', claimed, {
  // ProseMirror schema 中 nodeSize === 1 的节点需要标记为 leaf
  isLeaf: nodeName => nodeName === 'image',
})
```

`attributeDeletions()` 返回：

```ts
[
  { at: 7, author: 'alice' },
  { at: 7, author: 'bob' },
]
```

同一位置出现多个作者是合法结果：Yjs 可能把相邻删除合并成同一个墓碑，clock 区间可以把它重新切回不同作者。展示层可以选择显示第一个作者、显示人数或在悬浮层展开。

## Hocuspocus 接入方式

Hocuspocus 适配层需要做四件事。

### 1. 在 `beforeHandleMessage` 解析帧声明

只有实时 `SYNC_UPDATE` 可以归属到当前用户。`SyncStep2` 必须入队一个空声明，以保证声明队列和 Yjs 事务数量对齐：

```ts
beforeHandleMessage({ connection, update }) {
  const frame = decodeSyncFrame(update)
  tracker.record(
    connection,
    frame?.syncType === SYNC_UPDATE ? frame.claimedDeletions : [],
  )
}
```

仓库提供 `decodeSyncFrame()`，可直接解析标准 sync envelope 并提取 `SYNC_UPDATE` 的 `clientID/clock/length` 范围。宿主仍需根据实际 Hocuspocus 版本确认消息是否带有文档名 envelope；如果网关已经剥离 envelope，可以直接把 payload 用 `Y.decodeUpdate()` 解码后构造同样的 `claimedRanges`。

### 2. 在 `afterTransaction` 消费声明

```ts
afterTransaction({ transaction, documentName }) {
  const claimed = tracker.consume(transaction.origin as object)
  if (claimed === null) return

  const records = captureDeletionRecords(
    {
      beforeState,
      deleteSet: transaction.deleteSet,
    },
    claimed,
    resolveAuthenticatedUser(transaction.origin),
  )

  void deletionStore.append(documentName, records)
}
```

声明必须在事务产生前入队，且每一个会产生事务的消息都要入队。否则后续声明会错配到其他事务，风险比漏记更严重。

### 3. 创建快照时 claim

```ts
const deletionRecords = await deletionStore.claim(documentId)
const attribution = attributeDeletions(
  activeDoc,
  'default',
  deletionRecords,
  { isLeaf },
)
```

删除作者不在 Yjs state 中，所以 claim 后必须把 `attribution.deletions` 写入快照或其他持久化字段。只保存 Yjs state，之后无法恢复删除者。

### 4. 写入失败时 restore

`claim` 和快照落库之间如果失败，需要把记录归还：

```ts
const records = await deletionStore.claim(documentId)
try {
  await persistSnapshot({ state, attribution: attributeDeletions(doc, 'default', records) })
} catch (error) {
  await deletionStore.restore(documentId, records)
  throw error
}
```

## Redis 存储要求

仓库内的 `MemoryDeletionStore` 用于示例和单进程测试。生产环境可以实现相同的 `DeletionStore` 接口：

```ts
interface DeletionStore {
  append(documentId: string, records: readonly DeletionRecord[]): Promise<void>
  claim(documentId: string): Promise<DeletionRecord[]>
  restore(documentId: string, records: readonly DeletionRecord[]): Promise<void>
}
```

Redis 实现应满足：

- 按 `documentId` 隔离记录；
- `append` 批量写入，避免每个删除范围一次网络往返；
- `claim` 原子地“读取并清空”；
- `restore` 在快照落库失败时恢复记录；
- 设置 TTL，避免连接异常或永远不创建快照导致无限积累；
- 对同一文档串行化 `append/claim/restore`，避免 claim 先于 append 执行。

仓库现在提供了 `RedisDeletionStore`。它只依赖一个兼容 `eval(script, numberOfKeys, ...args)` 的 Redis 客户端，因此可以注入 ioredis 或 node-redis，而不把客户端 SDK 固定为运行时依赖。

```ts
import Redis from 'ioredis'
import { RedisDeletionStore } from 'yjs-v13-deletion-attribution'

const redis = new Redis(process.env.REDIS_URL)
const deletionStore = new RedisDeletionStore(redis, {
  keyPrefix: 'eva:deletions:',
  ttlSeconds: 24 * 60 * 60,
  maxRecords: 5000,
})
```

`append`、`claim`、`restore` 分别使用 Redis Lua 脚本完成批量写入、原子读取并清空、失败恢复；同一进程内还会按文档串行化这些操作，避免 `claim` 先于前一个 `append` 执行。多实例部署时，Redis 脚本提供跨实例的原子性。

## 数据结构建议

快照中可以保存如下 JSON：

```json
{
  "kind": "ranges",
  "ranges": [],
  "deletions": [
    { "at": 7, "author": "alice" }
  ]
}
```

普通新增内容的 `ranges` 可以由 Yjs state 和状态向量基线重新推导；删除作者的 `deletions` 必须在写入快照时落库，因为它来自外部删除记录。

## 已知边界

- 客户端先写入、再离线删除，且被删内容从未到达服务端：为避免误归属，可能漏记。
- Redis 记录过期、append 失败或 claim 后 restore 失败，会导致删除作者无法恢复。
- 删除归属是外部记录与 Yjs tombstone 的组合，不是 Yjs 原生历史能力。
- `isLeaf` 必须使用与生成 Y.Doc 的 ProseMirror schema 一致的判断，否则后续节点坐标会发生偏移。
- `MemoryDeletionStore` 不适合多进程或多实例部署。

## 文件结构

```text
src/index.ts                  核心类型、捕获、存储边界、墓碑映射
src/sync-frame.ts             Hocuspocus sync envelope 与 DeleteSet 解析
src/redis-store.ts            Redis 原子 append/claim/restore 实现
test/index.test.ts            真实 Yjs 事务测试
examples/complete-flow.ts     无外部服务的完整生命周期示例
examples/README.md            Hocuspocus 接入提示
```

## 开发命令

```bash
npm run build     # 生成 dist 和类型声明
npm test          # 运行真实 Yjs 测试
npm run check     # build + test
npm run example   # 运行完整流程示例
```

## License

MIT
