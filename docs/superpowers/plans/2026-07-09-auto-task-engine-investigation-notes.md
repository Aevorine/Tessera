# Task 0 调研结果：真实 `claude --output-format stream-json` 行为

日期：2026-07-09。三次真实调用（普通任务、`--resume` 续跑、无跳过权限的写文件任务），样本存于 `modules/file_vault/tests/fixtures/stream_json_sample.jsonl`（第一次调用的完整输出）。

## 1. 必须先知道的一个坑：`--verbose` 是硬性要求

`--print --output-format stream-json` **必须**同时传 `--verbose`，否则直接报错退出（`Error: When using --print, --output-format=stream-json requires --verbose`），不产生任何 stdout。计划里 `task_engine.TaskEngine.spawn` 组装命令行的地方要补上这个参数，之前完全没考虑到。

## 2. `type` 取值枚举（实测出现过的）

- `system`（`subtype: "init"`）——第一行，带 `session_id`、`cwd`、`tools`、`permissionMode`、`model` 等会话元信息。
- `rate_limit_event`——独立事件类型，不是挂在别的事件里。结构：
  ```json
  {"type": "rate_limit_event", "rate_limit_info": {"status": "allowed_warning", "resetsAt": 1783911600, "rateLimitType": "seven_day", "utilization": 0.81, "isUsingOverage": false, "surpassedThreshold": 0.75}, "session_id": "...", "uuid": "..."}
  ```
  这是比"在 result 文本里搜关键词"可靠得多的额度信号来源——`utilization` 是 0~1 的比例，`status` 目前观察到的值是 `"allowed_warning"`（接近但没超限）。没有实测到真正超限时的 `status` 取值（不能故意把账号刷到超额去验证），但这个事件本身的存在和结构已经确认。
- `assistant` / `user`——完整的 Messages API 转录格式（`message.content` 是 block 数组：`text`/`thinking`/`tool_use`），`user` 类型事件其实是"工具执行结果"回灌给模型，不是真的用户输入，带 `tool_use_result`。比计划占位假设的"就是一段文本"复杂得多，但 `classify_event` 完全不需要解析这些，只需要认出 `type` 不是 `result` 就归为 `log_only`。
- `result`——终态事件，唯一需要精确解析的类型。

## 3. `result` 事件的真实字段结构（比原计划占位丰富、也更可靠）

```json
{
  "type": "result",
  "subtype": "success",
  "is_error": false,
  "api_error_status": null,
  "terminal_reason": "completed",
  "session_id": "...",
  "result": "<最终答复文本>",
  "permission_denials": [],
  "total_cost_usd": 0.315,
  ...
}
```

**关键改动**：`classify_event` 不应该像计划 Task 4 占位实现那样在 `result` 文本里搜"usage limit"/"rate limit"关键词，应该优先看这三个字段：
- `terminal_reason == "completed"` 且 `is_error == false` → `done`。
- `api_error_status` 非空（预期是 HTTP 状态码，比如限流会是 429）→ 强信号，指向 `quota_blocked`。
- `terminal_reason` 非 `"completed"` 且 `is_error == true` 但 `api_error_status` 为空 → 归为 `failed`（不是额度问题，是别的执行错误）。
- 保留文本关键词匹配作为兜底（万一以上字段在某个版本/某种错误下缺失），但不再是主判据。

**没有实测到的**：真正因为额度耗尽而中断是什么样子（`api_error_status` 具体值、`terminal_reason` 具体取值），因为不能故意刷爆账号额度去验证——这轮调研已经让当前 7 天额度利用率到了 0.81，不适合再刻意去触发限流。`task_engine.classify_event` 按上面的字段结构实现，把兜底关键词列表也保留，实现完之后如果真的在实际使用中遇到一次限流，把观察到的真实字段值回填进这份笔记和 `QUOTA_EXCEEDED_MARKERS`/字段判断逻辑里。

## 4. `--resume` 确认可用

```
claude --resume <session_id> -p "<追加内容>" --output-format stream-json --verbose [--dangerously-skip-permissions]
```
实测续跑成功：新调用的所有事件 `session_id` 与原会话完全一致，`result.terminal_reason == "completed"`。计划里 `TaskEngine.spawn` 对 `--resume` 参数的用法不需要改。

## 5. "分级自动"的可行性结论：不需要黑名单，默认行为本身就是安全的

**结论比计划设想的简单、也更安全**：不带 `--dangerously-skip-permissions`、不带任何 `--allowedTools`/`--disallowedTools` 时，在非交互 `-p` 模式下，需要授权的工具调用（实测：`Write`）**不会挂起等待批准**，而是被**自动拒绝**——进程正常走完，`terminal_reason: "completed"`，被拒绝的调用记录在 `result.permission_denials` 里（`tool_name`/`tool_use_id`/`tool_input` 都在）。實測命令行本身：

```
claude -p "在当前目录新建一个文件 out.txt，内容写 hello" --output-format stream-json --verbose
# (不带 --dangerously-skip-permissions，也不带任何 allowed/disallowed 参数)
```

结果：`out.txt` 没有被创建，`permission_denials` 里有一条 `Write` 记录，进程正常退出（不是超时/挂起）。

这意味着：
- 之前计划 Task 6/8 里设计的 `DEFAULT_GRADED_DISALLOWED_TOOLS` 黑名单（`Bash(rm -rf*)` 等）**不需要**——默认的"非跳过权限"模式已经是 fail-closed 的，读写风险操作会被自动拒绝而不是执行，也不会把任务挂死占住并发槽位（这是之前一轮计划评审最担心的场景，现在有真实证据可以排除）。
- "分级自动"模式的实现大幅简化为：**就是不传 `--dangerously-skip-permissions`**，任何模式都不需要额外的 `disallowedTools` 逻辑。风险操作自动被拒绝、体现在 `permission_denials` 里，正常任务里可以在 `DONE_PENDING_REVIEW` 阶段把"哪些操作被拒绝了"也展示给用户看（这是原计划没想到的一个改进点，任务详情页可以加一行"有 N 个操作因权限被自动拒绝"）。
- 唯一的代价：这不是"运行中暂停、等你实时批准"的体验（这种机制目前没有确认存在，`-p` 模式下没有找到相关文档化接口），而是"risky 操作直接失败、事后你能看到失败清单"。这跟 spec 原本设想的"分级自动"有出入（spec 想要的是"暂停等待"），但比"根本不知道哪些操作被默默跳过或不知道会不会挂死"更安全、更简单、更好测——建议采纳这个简化版本。

## 6. 需要回填进主计划的改动

- Task 6 `TaskEngine.spawn`：命令行拼接加上 `--verbose`（`-p --output-format stream-json` 时必需）。
- Task 6/Task 8：删除 `DEFAULT_GRADED_DISALLOWED_TOOLS` 常量和 `disallowed_tools` 参数整条链路——graded_auto 模式的 `skip_permissions` 直接是 `False`，不需要再传别的东西。
- Task 4 `classify_event`：改成优先读 `terminal_reason`/`is_error`/`api_error_status`，而不是搜文本关键词；文本关键词降级为兜底。
- Task 9 `rpc_task_review_diff`（或 UI）：可以顺手把 `permission_denials` 展示出来，让分级自动模式下"哪些操作被拦了"对用户可见——这是调研带来的一个加分项，不是必须的，先记下来，看实现 Task 9 时是否顺手做。
