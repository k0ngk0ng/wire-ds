# macOS 个人使用安装

下载适合芯片的 DMG：Apple Silicon（M 系列）使用 `arm64`，Intel 使用 `x64`。应用已经过 ad-hoc 签名，不需要 Apple 开发者账号。

首次从 GitHub 下载后，macOS 可能因为应用未经过 Apple 公证而阻止打开。DMG 中附带「安装到本机.command」，用于将应用复制到 `~/Applications/ChatDeepSeek.app`，验证签名，并只移除该应用副本的下载隔离属性。它不修改全局 Gatekeeper、SIP 或系统安全设置，不需要管理员权限。

1. 打开 DMG。
2. 在终端输入 `bash `（注意末尾空格），将 DMG 内的「安装到本机.command」拖入终端，按回车。
3. 安装完成后应用自动启动。后续从「应用程序」或 Spotlight 打开，或者用已配置的全局快捷键呼出。

v1.0.8 及以后版本可在设置中检查更新，再选择「更新并重启」，应用会下载、校验并替换原目录中的应用，然后自动重新启动。此过程保留登录和设置；安装目录不可写或预检失败时不会退出原应用，新版本无法启动时会自动恢复旧版。

早期版本升级或手动安装时，先从菜单栏退出应用，再运行新 DMG 中的同一脚本。旧版本保留为带日期的备份；登录数据和设置位于 `~/Library/Application Support/Wire DeepSeek`，更新时保留。

安装脚本默认写入 `~/Applications`。如果现有应用位于 `/Applications`，需指定同一目录：

```sh
bash "/Volumes/ChatDeepSeek/安装到本机.command" --target /Applications
```

若 DMG 挂载目录带有数字后缀，使用实际目录替换命令中的 `/Volumes/ChatDeepSeek`。从 v1.0.3 开始，可从设置或菜单中的「检查更新」下载并校验最新安装包，再按上述步骤覆盖安装。

也可以手动拖入 Applications 后，在终端仅对这个应用执行：

```sh
xattr -dr com.apple.quarantine "/Applications/ChatDeepSeek.app"
open "/Applications/ChatDeepSeek.app"
```

如果系统提示「应用已损坏」，先重新下载并核对 Release 中的 SHA256 校验和。安装脚本会验证签名；签名验证失败时会停止，不覆盖已安装版本。
