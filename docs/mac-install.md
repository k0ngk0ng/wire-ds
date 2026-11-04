# macOS 个人使用安装

下载适合芯片的 DMG：Apple Silicon（M 系列）使用 `arm64`，Intel 使用 `x64`。应用已经过 ad-hoc 签名，不需要 Apple 开发者账号。

首次从 GitHub 下载后，macOS 可能因为应用未经过 Apple 公证而阻止打开。DMG 中附带「安装到本机.command」，用于将应用复制到 `~/Applications/Wire DeepSeek.app`，验证签名，并只移除该应用副本的下载隔离属性。它不修改全局 Gatekeeper、SIP 或系统安全设置，不需要管理员权限。

1. 打开 DMG。
2. 在终端输入 `bash `（注意末尾空格），将 DMG 内的「安装到本机.command」拖入终端，按回车。
3. 安装完成后应用自动启动。后续从「应用程序」或 Spotlight 打开，或者用已配置的全局快捷键呼出。

如需更新，先从菜单栏退出应用，再运行新 DMG 中的同一脚本。旧版本保留为带日期的备份；登录数据和设置位于 `~/Library/Application Support/Wire DeepSeek`，更新时保留。

也可以手动拖入 Applications 后，在终端仅对这个应用执行：

```sh
xattr -dr com.apple.quarantine "/Applications/Wire DeepSeek.app"
open "/Applications/Wire DeepSeek.app"
```

如果系统提示「应用已损坏」，先重新下载并核对 Release 中的 SHA256 校验和。安装脚本会验证签名；签名验证失败时会停止，不覆盖已安装版本。
