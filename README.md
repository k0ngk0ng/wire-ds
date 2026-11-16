# ChatDeepSeek

使用 DeepSeek 官方网页的 macOS / Windows 桌面客户端。全局快捷键呼出快捷聊天窗口，随时展开为完整网页，保留官方登录、历史会话与聊天功能。

## 安装

从 [Releases](https://github.com/k0ngk0ng/wire-ds/releases) 下载：

| 系统 | 安装包 |
| --- | --- |
| Apple Silicon Mac | `ChatDeepSeek-版本-arm64.dmg` |
| Intel Mac | `ChatDeepSeek-版本-x64.dmg` |
| Windows x64 | `ChatDeepSeek-版本-x64.exe` |

macOS 构建使用 ad-hoc 签名，面向个人使用，不要求 Apple 开发者证书。首次从网络下载安装时，按 DMG 内的「首次运行说明.md」执行「安装到本机.command」。脚本将应用安装到 `~/Applications`，验证签名并只移除该应用副本的下载隔离属性；不关闭系统安全检查。详细步骤见 [macOS 安装说明](docs/mac-install.md)。

Windows 安装器支持选择安装目录，不需要管理员权限。无商业证书的安装包可能出现 SmartScreen 提示；确认来源与 SHA256 后可使用「更多信息 → 仍要运行」。

## 更新

v1.0.1 及更早版本没有应用内更新功能，需要先从 [最新 Release](https://github.com/k0ngk0ng/wire-ds/releases/latest) 下载对应安装包，退出旧应用后覆盖安装。登录数据与设置会保留。macOS 使用 DMG 内的安装脚本更新时，应安装到现有应用所在目录，避免保留两个可启动的副本；指定 `/Applications` 的方式见 [macOS 安装说明](docs/mac-install.md)。

从 v1.0.5 开始，可在设置的「应用更新」或菜单中选择「检查更新」，再点击「更新并重启」。应用从本仓库的 GitHub Releases 下载对应系统和架构的更新包，校验 SHA256 后自动安装到原目录并重新启动，保留登录数据与设置。macOS 使用 ZIP 更新包，安装前还会核验应用签名、标识与版本；新版本无法正常启动时会恢复旧版。Windows 使用安装器静默更新。安装目录需要可写，预检失败时应用会保持运行并提示重试。

v1.0.3 和 v1.0.4 的更新入口仍会打开安装包，需要手动覆盖安装到 v1.0.5 一次。安装版启动后会在后台检查版本，下载和重启由点击「更新并重启」触发。

## 使用

| 操作 | macOS | Windows |
| --- | --- | --- |
| 全局呼出 / 收起 | 默认 F2，可在设置中录制修改 | 默认 F2，可在设置中录制修改 |
| 新对话 | ⌘N | Ctrl+N |
| 收起窗口 | ⌘W / 关闭按钮 | Ctrl+W / 关闭按钮 |
| 快捷 / 完整窗口 | ⌘⇧E / 工具栏展开按钮 | Ctrl+Shift+E / 工具栏展开按钮 |
| 设置 | ⌘, / 工具栏设置按钮 | Ctrl+, / 工具栏设置按钮 |
| 退出程序 | ⌘Q / 菜单栏「退出」 | 托盘菜单「退出」 |

关闭窗口会后台驻留，菜单栏或托盘始终显示 DeepSeek 鲸鱼入口。收起与展开不会刷新网页，也不会清空草稿或打断回答。快捷窗口初始约 740 × 360，随着逐行输出平滑向下长高，上沿位置保持不变；达到屏幕底部或默认的 80% 高度上限后，在窗口内滚动。设置中可调整上限或关闭自动高度。新对话直接恢复最小高度，仅增高时使用动画；系统开启「减少动态效果」时直接调整尺寸。快捷键被占用时可以在设置中更换；注册失败会保留旧快捷键。

登录在独立窗口中通过官方页面完成。浏览器会话持久化到本地，重启与升级时保留；官网主动退出或使登录失效时需要重新登录。应用不建立自己的账号系统，不要求 API Key，也不把聊天代理到其他服务器。

界面默认跟随系统主题，设置中可选浅色或深色。设置窗口的标题栏固定，内容区域可滚动，不允许调整大小、最大化或全屏。窗口尺寸、主题、置顶与呼出行为会保存。侧边栏使用官网的原始操作，新对话快捷键优先触发官网入口；入口变化或失效时自动回到新对话首页，保留登录状态并聚焦输入框。

开启 DeepThink 时，思考区域默认自动折叠，可点击官网标题手动展开。

## 本地开发与验证

需要 Node.js 24 和 npm。macOS 打包需要 macOS，Windows 安装器由 Windows Actions Runner 构建。

```sh
npm ci
npm run dev
```

```sh
npm run verify
npm run package:mac
# Intel Mac
npm run build
node scripts/package.mjs --mac --x64
# Windows 上
npm run package:win
```

本地开发、测试和打包缓存都在仓库内：`.runtime/`、`.cache/`、`artifacts/`、`test-results/`、`playwright-report/`、`release/`，均不会提交 Git。开发版使用 `.runtime/development`，正式版使用操作系统的应用数据目录。可用 `WIRE_DS_DATA_DIR` 指定一个独立的数据目录。

E2E 在真实 Electron 进程中验证窗口、持久化、快捷键注册、冲突、中文组合输入、主题、错误恢复和安全隔离；本地 HTTP 服务代替不可控制的第三方网站，不代替桌面功能。测试产出 HTML 报告、JSON 结果、截图和失败 trace。官网登录与系统级快捷键另外做实机验证，不能用本地服务测试推断通过。验收范围见 [验收约定](docs/acceptance.md)。

生成与本机架构匹配的安装包后，可运行 `npm run test:install` 验证原生更新。测试使用仓库内的独立应用副本和数据目录；Windows 的静默安装验证仅在隔离 CI 环境运行。

## GitHub Actions

推送到 `main`、创建 `v*` 标签或手动运行 [Build installers](https://github.com/k0ngk0ng/wire-ds/actions/workflows/build.yml)，自动构建 macOS arm64、macOS x64 和 Windows x64。每个安装包附 SHA256 校验和。`v*` 标签构建成功后自动创建 Release；普通构建可从 Actions 的 Artifacts 下载。

不需要上传 Apple 证书、Apple 账号或 Windows 签名证书。CI 的聊天行为使用本地测试服务，原生更新在独立目录安装并重启测试应用，不包含个人登录会话。

## 数据与权限

正式版沿用以下数据目录，以兼容更名前的登录数据和设置：

- macOS：`~/Library/Application Support/Wire DeepSeek`
- Windows：`%APPDATA%/Wire DeepSeek`

设置与官网浏览器数据分开保存。卸载不自动删除登录数据。远程网页不具备 Node.js 或本地设置 IPC 权限；外链交由系统浏览器处理。附件通过官网与系统文件选择器操作，下载通过保存对话框确认路径。

应用图标、工具栏、设置和菜单栏 / 托盘使用 [DeepSeek 官网提供的鲸鱼标志](https://fe-static.deepseek.com/chat/favicon.svg)。DeepSeek 名称、标志和官网内容归其权利人所有；这是独立客户端，不是 DeepSeek 官方产品。源码使用 MIT 许可证，官方标志不包含在该许可证授权范围中。
