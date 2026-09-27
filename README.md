<div align="center">

# dsh-workspace-monitor 0.2.0

[![npm version](https://img.shields.io/npm/v/dsh-workspace-monitor)](https://www.npmjs.com/package/dsh-workspace-monitor)
[![License](https://img.shields.io/npm/l/dsh-workspace-monitor)](LICENSE)

<img src="https://raw.githubusercontent.com/Rainier-Z/dsh-workspace-monitor/main/banner.png" alt="dsh-workspace-monitor" width="800">

</div>

## 安装

```bash
dsh plugin --profile desktop add dsh-workspace-monitor
```

## 快速开始

可以直接在当前会话中使用自然语言操作监测任务：

- "开始监测当前工作区"
- "列出监测"
- "把 `<taskId>` 改为每分钟"
- "停止监测 `<taskId>`"
- "继续监测 `<taskId>`"

同一个会话可以同时创建多个监测任务。每个任务都有独立的 `taskId`、工作区、扫描基线和运行状态；"列出监测"只列出当前会话拥有的任务。

## 运行规则

- 新任务默认每 60 秒扫描一次（`intervalMs: 60000`）。
- 可以在运行时修改间隔，例如"把 `<taskId>` 改为每分钟"；修改会立即作用于后续调度，不需要重启。
- 创建任务时先扫描一次并静默建立基线，不发送首轮变化通知。
- 从第二轮开始，每个周期都会发送扫描摘要；发现变化时列出新增、修改和删除，未发现变化时也会明确报告无变化。
- 扫描只读取文件元数据，不读取文件内容，也不写入被监测工作区。默认忽略 `.git`、`node_modules` 和 `.dsh-workspace-monitor`，并可通过配置调整扫描规模与摘要中的变化数量。
- "停止监测"会暂停任务；"继续监测"会恢复任务并执行一次补偿扫描，然后按原间隔继续运行。
- 任务归属于当前会话的 `sessionId`，不依赖某一个暂时存活的 Agent 实例；Agent 释放后，任务仍保持运行。
- 每轮扫描先把基线、时间和待投递报告一起持久化，再尝试送达。Agent 忙、暂时不可用或持久化确认失败时，报告会保留并在后续重试；只有 `sessions.flush()` 成功且 revision 仍一致时才清除。
- 扫描失败也会形成可恢复的待投递通知，且不会推进文件基线。
- Session 归档前会报告仍在运行的监测任务；如果归档流程要求停止活动，任务会保留配置并转为 `PAUSED(session_archived)`，不会删除历史基线。

### 重启后的状态

持久化任务在运行环境重启后会恢复为原状态。原为 `ACTIVE` 的任务会重新进入调度；到期任务只执行一次补偿扫描，未送达的报告也会从持久状态恢复。手动暂停任务仍保持暂停。旧版本留下的 `restart_requires_confirmation` 或 `agent_disposed` 系统暂停原因会在启动时自动迁移为 `ACTIVE`。

## 配置与集成边界

插件包自带 `cordis.patch.yml`，默认配置如下：

```yaml
- insert:
    - id: dsh-workspace-monitor
      name: dsh-workspace-monitor
      config:
        intervalMs: 60000
        ignore: [.git, node_modules, .dsh-workspace-monitor]
        maxEntries: 100000
        maxChanges: 200
```

Desktop profile 是当前配置的主入口；旧的 Web 配置已移除。侧边任务栏集成留待后续阶段，本阶段尚未实现。

## 本地验证

在本项目目录执行：

```powershell
npm test
npm run check
npm run pack:check
```
