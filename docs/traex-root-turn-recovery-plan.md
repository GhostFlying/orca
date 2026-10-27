# TraeX 根回合结束检测与可信恢复事实

## 目标与事实修正

TraeX 根回合失败后，即使结束 hook 缺失、没有子代理，也应独立观测根结束并发布结构化事实；后台工作是否收敛独立判断。

最初调查把按会话 ID 模糊匹配到的 `.jsonl.lock` 当成 JSONL，空历史的结论无效。按原生元数据的精确 rollout 路径复核，实际 JSONL 有完整 session_meta 和带 error 的 task_complete。paginated 模式不意味着 JSONL 为空。修复仍覆盖原生分页历史，但不能用错误的空文件假设证明本次原因。

## 实施

1. 先用带明确失败事件的真实格式 JSONL 重现 TraeX 根结束漏检，扩展已有 Codex-compatible 根观察，保持 provider 身份和 turn 归属校验。
2. 根未结束时每五秒有界补查，独立于子代理；原生只读历史接口支持分页持久历史，复用既有 app-server 连接及进程管理，不读取私有 SQLite schema、不启动模型或恢复线程。
3. 对外输出可选 rootTurn 事实和 runtime capability；包括 session/turn/终端归属、状态、来源、规范化错误、操作收敛 settled/pending/unknown；不输出错误正文或完整历史。
4. 旧回合、子线程、人工接管与终端更换不覆盖新身份；读取失败保持 unknown；根失败不替代后台停止证明。
5. 保持 CLI/RPC、桌面/远程 server、Git/folder workspace 的一致语义。

## 验证和发布

覆盖 hook 缺失、根失败且背景仍忙、旧事件迟到、错误分类、历史读取失败、分页历史及新旧 client/server。执行定向测试、changed gate 和独立 review。

基于当前生产 fork 创建 fix 分支，经正式 hotfix intake 构造 candidate/fork-hotfix；维护路径不混入业务补丁。完整 Desktop/Mobile、server template、发布产物校验、正式 finalizer 和保护 refs 前后审计均是交付条件。仅更新 CLI 不算完成，实际处理 worker 的 server 也必须更新；保留 PTY daemon 与工作区。

## 原生读取边界验证

TraeX 0.211.1 的独立只读连接可能把另一连接仍在执行的回合投影为 interrupted，且没有 completedAt。结束状态必须同时具备原生持久结束时间，并满足不早于 startedAt；缺失时报告 unknown，继续补查，不据此判定人工中断或停止后台工作。

隔离的 paginated 会话在 JSONL 被人工截断为零字节后，原生读取同样可能不可用，因此此情形只能报告 unknown，不能声称数据库历史一定足以恢复。本次真实故障的 JSONL 完整；无子代理、缺失结束 hook 时，实际原生 failed 事实须在两个补查周期内被观测。测试中的截断仅针对本轮创建的隔离会话。
