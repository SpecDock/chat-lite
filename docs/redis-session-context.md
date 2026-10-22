# Redis 会话上下文

进行中的模型上下文放在 Redis。一个会话同时只有一把锁。每完成一个稳定步就用版本做 CAS 写入 Redis。Kafka broker 列表非空时，同一次成功写入再投递一条消息，由消费者按会话顺序写入 Postgres。Redis 里没有上下文时，才从 Postgres 的 current 快照装回。下面按文件说明改了什么、为什么改。

## 改动文件

### go/config/config.go

新增 `Kafka` 配置。`brokers` 在 YAML 里是一个字符串，`BrokerList` 按逗号拆开并去掉空白，得到 broker 切片；切片为空就表示整条 Kafka 路径关闭。`topic` 去掉空白后如果是空的，就用 `chatlite-context`。这样代码能同时决定要不要投递、要不要启动消费者和清理循环，地址本身仍只来自环境变量。

### go/config/config.yaml

在 `redis` 段后面增加 `kafka.brokers: ${KAFKA_BROKERS}` 和 `topic: chatlite-context`。进程启动读配置时，会像其它字段一样把 `${...}` 换成环境变量。broker 地址不写进仓库，topic 用固定名字，避免请求端和消费者各写一套。

### .env.example

在 Redis 变量旁边增加 `KAFKA_BROKERS=`。留空时 broker 列表为空，服务不投递、不消费、不清理 Redis，请求仍直接写 Postgres 快照。要开启时填逗号分隔的地址，例如 `127.0.0.1:9092`。

### go/docker-compose.yml

增加单节点 KRaft 的 `kafka` 服务，镜像是 `apache/kafka:3.9.1`。宿主机端口是 `9092:9092`，对外广告地址是 `PLAINTEXT://127.0.0.1:9092`，控制器仍留在容器内的 9093。偏移量主题和事务状态日志的复制因子都是 1，没有账号和密码。这次只把编排写进文件，不在本机启动容器。

### go/go.mod 与 go/go.sum

直接依赖增加 `github.com/segmentio/kafka-go v0.4.51`，请求端和消费者都用这个客户端。`go.sum` 写入该模块以及 lz4、scram 等传递依赖的校验和。`go mod tidy` 还把代码里已经直接 import、原先标成 indirect 的 `minio-go`、`gopkg.in/yaml.v3` 和 `golang.org/x/image` 挪到直接 require，版本没有改。

### go/internal/infrastructure/contextstore/store.go

阶段 1 的锁、`SaveCAS` 和 `Warm` 没有改：锁仍是 `chatlite:lock:{id}` 上带令牌的 `SET NX PX`，`SaveCAS` 仍只在版本相等时覆盖整份文档，`Warm` 仍用 `SET NX`，避免旧 Postgres 盖住新 Redis。阶段 3 只新增 `chatlite:ctxdb:{id}` 的读写，以及 `SCAN chatlite:ctx:*`；扫描会命中 ctxdb 前缀，所以先丢掉 `chatlite:ctxdb:`。删除放在一条 Lua 里，锁存在、ctxdb 不存在、版本不同或空闲不足 1800 秒都保留；三条都满足才 `DEL` 上下文键和 ctxdb 键，不删锁。

### go/internal/application/chat/agent.go

这次没有改 `Persist` 的调用点。阶段 2 给 `Input` 加了 `Persist`：没有 `tool_calls` 的正文回合立刻持久化；有工具时，要等每个工具结果都追加进 `messages`，并且 `view_image` 选出的图片也放进去之后才持久化；步数用尽后的最终回答同样持久化。取消或上下文结束如果发生在这些点之前，半截正文和半截工具参数不会进入 Redis，也不会成为下一轮前缀。`Persist` 为 nil 时 `persistStep` 直接返回，Redis 未配置时主循环保持原来的内存行为。

### go/internal/interfaces/httpapi/chat.go

`loadPrior` 在 Redis 开启时仍用原来的 `SaveCAS`。CAS 成功且 Kafka 开启时，同步发出一条消息：key 是 `conversationID`，`version` 用返回的 `newVersion`，`message_id` 用当前 `assistantID`，`messages` 是这次写入的完整数组，`updated_unix` 与写进 Redis 的时间相同。`WriteMessages` 失败只记日志，不让这一步失败，因为后面更高的版本会带上完整消息。Kafka 开启时成功结束和取消都不再直接写 Postgres 快照，避免和消费者抢写；Kafka 关闭时 `saveContextSnapshot` 和 `saveCancelledContext` 保持原样，而 `finishMessage`、RAG 和用量记录在两种情况下都留在请求里。

### go/internal/interfaces/httpapi/conversations.go

阶段 2 增加 `POST /api/conversations/{id}/stop`，用来取消本进程里这场生成，让主循环停在下一个稳定点之前。生成已经 `commit` 完成时，回复保持 `completed`，不会被改回中断。本进程没有这场生成时，把仍是 `streaming` 的助手消息改成 `interrupted`：已有正文保留，空内容写成「已取消」。因此停止生成不会把最后一个已经写完的步从消息记录里擦掉。

### src/web/features/chat/ChatPage.tsx

取消时用 `retainInterrupted` 保留已经流到界面上的文字，只有空内容才显示「已取消」，状态改为 `interrupted`。取消会调用停止接口，而不是只断开浏览器连接、让服务端继续写。`stopRequestedRef` 用来挡住停止请求还没结束时的消息刷新，避免气泡被刷回 `streaming`。当前会话在服务端仍是 `streaming`、而本页没有本地任务时，每 1.5 秒拉一次消息；输入框也会把这种会话算作正在生成。

### src/web/shared/api/client.ts

新增 `api.stopGeneration`，向 `POST /api/conversations/{id}/stop` 发请求。`ChatPage` 取消生成时用它通知服务端。没有这个调用，服务端看不到浏览器已经中止，锁和生成上下文都会继续占着。

### go/schema.sql

`conversation_context_snapshots` 增加可空列 `source_version INTEGER`，用来保存这条快照对应的 Redis 版本。表上的 `UNIQUE(conversation_id, user_id, version)` 没变，所以 Postgres 自己的 `version` 仍然必须是 `MAX+1`，不能把 Redis 版本直接填进那一列。建表语句后面另有 `ADD COLUMN IF NOT EXISTS`，因为已经存在的库只执行 `CREATE TABLE IF NOT EXISTS` 不会加列。

### go/internal/infrastructure/postgres/db.go

`ApplySchema` 执行完 `schema.sql` 之后，再单独执行一次 `ALTER TABLE conversation_context_snapshots ADD COLUMN IF NOT EXISTS source_version INTEGER`。启动建表因此不依赖「整份脚本里刚好带了这条 ALTER」。新库上这一列已经在 `CREATE TABLE` 里，这条语句是空操作。

### go/internal/application/chat/snapshot.go

新增 `SaveSnapshotWithSourceVersion`，消费者用它写快照，不复用会自己拿 `MAX(version)+1` 来决定能不能覆盖的 `SaveSnapshot`。事务里先锁住 current 行：如果它的 `source_version` 大于或等于这次的 Redis 版本，就什么都不写并返回。否则插入新行，Postgres `version` 仍用 `MAX+1`，`source_version` 存 Redis 版本，旧 current 改成 `superseded`，新行再改成 `current`。`covered_message_created_at` 仍从 `messages` 表读，读不到就用当前时间；空数组会拒绝，避免盖掉一条有效的 current 快照。

### go/cmd/server/main.go

配置加载成功后，只有 Kafka broker 切片和 Redis 地址都非空，才打开 `contextstore` 并启动消费者和清理循环。这时如果 Postgres 没有配置，进程直接退出，避免开了 Kafka 却没有地方落快照。收到退出信号并结束 HTTP 之后，`Close` 会取消这两个循环，再关闭 Reader 和 Writer。broker 列表为空时这里什么都不启动。

### go/internal/infrastructure/contextkafka/publish.go

`Publish` 把 `SnapshotEvent` 编成 JSON，key 使用 `conversation_id`。Writer 按约定使用 `kafka.TCP`、`kafka.Hash`、`kafka.RequireAll` 和 `AllowAutoTopicCreation: true`。`BatchTimeout` 设成 1 毫秒，避免这个库默认等 1 秒凑批，把对话里的每一步都卡住。写入是同步的；调用方收到错误只记日志。

### go/internal/infrastructure/contextkafka/consume.go

消费者组固定为 `chatlite-context`，新组从最早位移读，避免服务晚启动时丢掉已经发出的快照。同一会话因 Hash 进入同一分区，失败的消息会就地重试，成功后才提交位移。`version` 不是正整数、身份为空或 `messages` 不是非空 JSON 数组时记日志并跳过；`version` 小于或等于 `chatlite:ctxdb:{conversationID}` 时也跳过，这个键不存在就视为 0。通过检查后调用 `SaveSnapshotWithSourceVersion`，成功再把 ctxdb 设成这个 version；外键错误记日志后跳过。清理不在启动时扫描，也不每分钟扫描。每个实例睡到上海时间凌晨 3 点，用 `SET chatlite:cleanup:当天日期 NX` 抢锁，租约留到当天中午，不主动释放。只有抢到的实例 `SCAN` 一次。没抢到的当晚不再扫。broker 列表为空时不启动。

### docs/redis-session-context.md

本文件就是这份说明，放在仓库里给使用和接手的人看。它按文件写明 Redis 上下文、会话锁、Kafka 投递、Postgres 快照和空闲清理各自落在哪里，以及为什么要动那个文件。行为以当前代码为准，不代替 `schema.sql` 或环境变量本身。

## 运行规则

### 一步何时写入

一步指三种时刻：模型这一轮没有 `tool_calls`、正文已经收完；或者这一轮的工具参数已经拼齐，并且每个工具结果和 `view_image` 图片都放进 `messages`；或者步数用尽后的最终回答已经生成。`agent.go` 在这三个点调用 `Persist`。Redis 开启时，`Persist` 就是 `SaveCAS`：版本不对就不写，成功后内存里的期望版本改成返回的 `newVersion`。Kafka 开启时，同一次成功写入再同步投递一条消息，key 是会话 ID，正文带上这个新版本和完整消息数组。投递失败只记日志，不把这一步判失败。

### 取消留下什么

取消如果发生在上面的稳定点之前，半截正文和半截工具参数不会写入 Redis，也不会成为下一轮前缀。Redis 里留下的是上一个成功 `SaveCAS` 的完整消息数组。助手消息在 Postgres 里改成 `interrupted`：已经生成并交给前端的文字保留，没有文字时内容是「已取消」。界面用同样的规则显示。Kafka 开启时，取消路径不再直接写 Postgres 快照，Postgres 只接收已经投递出去的稳定步。Kafka 关闭时，`saveCancelledContext` 从 Redis 读出这个最后稳定步，再调用原来的 `SaveSnapshot`。

### Kafka 关闭时的回退

`KAFKA_BROKERS` 为空或只有空白、逗号时，broker 切片为空，整条 Kafka 路径关闭：不创建 Writer，不启动消费者，不扫描清理 Redis。这时请求里的 `saveContextSnapshot` 和 `saveCancelledContext` 仍会直接写 Postgres，和接上 Kafka 之前一样。broker 非空时，这两处调用去掉，改由消费者按 `source_version` 写入，避免两边同时把 current 快照改来改去。无论 Kafka 是否开启，`finishMessage`、RAG 索引和用量记录都还在请求路径里。消费者和清理还要求 Redis 地址非空；只填了 broker、没有 Redis 时，请求会跳过直接写快照，消费者也不会启动，所以要沿用原来的写库方式就必须把 `KAFKA_BROKERS` 留空。

### 清理删除前的三个条件

清理只看 `chatlite:ctx:*`，用 `SCAN`，不用 `KEYS`，并且跳过 `chatlite:ctxdb:`。下面三条同时成立才删除，缺一条就留下：

1. `chatlite:lock:{id}` 不存在。会话还在生成就不删。
2. 文档里的 `version` 等于 `chatlite:ctxdb:{id}`，而且 ctxdb 这个键必须存在。键不存在，或者两边版本不同，都说明 Postgres 还没确认到 Redis 里的这个版本。
3. 文档的 `updated_unix` 距今不少于 1800 秒，也就是 30 分钟。不足 1800 秒就跳过。

删除的只是上下文键，不删除 `chatlite:ctxdb:{id}`，也不删除锁。ctxdb 是版本高水位。Redis 没有上下文时，下一步的期望版本是 `ctxdb` 和 Postgres 当前行 `source_version` 里较大的那个；键不存在时 `SaveCAS` 直接写成这个期望版本加一，不会从 1 重新开始。当前行已被作废，或快照正文不能用时，仍然保留已经读到的 `source_version`。判断和删除在同一条 Lua 里完成，避免刚加上锁或版本刚变化时把键删掉。

### 消费者如何拒绝旧版本

有两道检查，旧事件不能覆盖更新的快照。

第一道在写 Postgres 之前：读取 `chatlite:ctxdb:{conversationID}`。键不存在视为 0。消息里的 `version` 小于或等于这个值就跳过，不写库，也不改 ctxdb。`version` 不是正整数的消息另作无效消息，记日志后跳过。

第二道在事务里：如果该会话已经有 `status='current'` 的行，而且它的 `source_version` 大于或等于这次的 Redis 版本，就什么都不插入，也不把旧行改成 `superseded`。Postgres 行自己的 `version` 只用于满足原有唯一约束，不拿来判断事件新旧。
