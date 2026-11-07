# Hello

OnlyChat 的最小示例插件，用来验证宿主 ABI、wasm 运行时和插件目录是否正常。

## 功能

- 实现 `init` / `on_tick` / `on_event` / `on_config` / `shutdown` 全部入口
- 状态序列化往返（写入 `hello-state`），验证宿主状态通道
- 不申请权限、不发送聊天、不访问网络，安装后可以放心启用

## 权限

无。

## 用途

插件加载异常时先安装并启用 Hello：日志里出现 `hello plugin initialised`，说明宿主、wasm 运行时和插件目录都正常，再去排查具体业务插件。
