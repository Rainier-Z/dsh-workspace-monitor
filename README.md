# dsh-Monitor

`dsh-monitor` 是一个无界面的 DeepSeek Harness / Cordis 插件。它为每个活动 Agent 监测其会话工作区，按固定间隔递归扫描文件元数据，并将本轮结果作为插件来源消息发送到对应会话。

## 当前功能

- 默认每 60 秒扫描一次，可通过 `intervalMs` 调整。
- 首次扫描只建立基线，不产生误报。
- 识别文件新增、修改和删除；重命名表现为删除加新增。
- 报告文件相对路径、大小和最后修改时间变化。
- 不跟随符号链接，避免越出工作区或形成循环。
- 默认忽略 `.git`、`node_modules` 和 `.dsh-monitor`。
- 扫描串行执行；插件卸载、热重载或 Agent 销毁时停止定时器。
- 默认每轮都报告；可将 `reportUnchanged` 设为 `false`，只报告变化或警告。

## 配置

插件包自带 `cordis.patch.yml`：

```yaml
- insert:
    - id: dsh-monitor
      name: dsh-monitor
      config:
        intervalMs: 60000
        workspace: ''
        ignore: [.git, node_modules, .dsh-monitor]
        reportUnchanged: true
        maxEntries: 100000
        maxChanges: 200
```

`workspace` 留空时，每个 Agent 使用 `session.header.cwd`；设置绝对或相对路径时，所有 Agent 都监测该路径。相对路径按 DSH 进程启动目录解析。

`ignore` 中不含 `/` 的项目匹配任意层级的同名文件或目录；含 `/` 的项目匹配工作区相对路径及其子路径。当前版本不解释 glob 通配符。

## 本地安装

在本项目父目录执行：

```powershell
dsh plugin --profile default add ./dsh-Monitor
dsh --profile default --dump-config
dsh --profile default
```

若使用其他 profile，将 `default` 替换为对应名称。卸载：

```powershell
dsh plugin --profile default remove dsh-monitor
```

## 验证

```powershell
npm run check
npm test
npm run pack:check
```

该插件只读取工作区元数据，不读取文件内容，也不写入被监测工作区。
