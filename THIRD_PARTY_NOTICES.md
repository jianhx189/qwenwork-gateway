# 第三方说明 / Third-Party Notices

## 协议实现

`lib/` 目录下的协议实现（`wasm.mjs` / `chat.mjs` / `account.mjs` / `constants.mjs` / `errors.mjs` / `runtime.mjs`）
来自 **tianyn1990/qwenwork-magpie**（MIT License）：

- 仓库：https://github.com/tianyn1990/qwenwork-magpie
- 许可证：MIT（见 `LICENSE`，保留原作者版权声明）
- 其自身声明改编自 XuePengJu/dsh-our-free-model 的 channel-pack（MIT，Copyright (c) 2026 Jet）

本项目在该协议层之上提供独立 HTTP 服务、账号池、令牌体系、调用日志与管理后台
（`server.mjs` / `admin.html` 为本项目编写）。

## 签名组件（不随仓库分发）

`qoder_auth_wasm_bg.wasm` 是**千问办公官方客户端**附带的厂商组件，用于请求签名。

- **本仓库不包含、不分发该文件**（`.gitignore` 已排除 `*.wasm`）。
- 使用者需自行从官方安装包提取，提取方法见 `README.md`。
- 该组件的版权与使用条款归千问办公（阿里云）所有；提取并用于自己账号的调用，
  其合规性由使用者自行判断与承担。

上游项目同样不分发该组件（见其 `THIRD_PARTY_NOTICES.md` 中 “Vendor WASM is loaded
locally and is not distributed”）。

## 与服务官方的关系

本项目为独立社区实现，与千问办公、Magpie 均无隶属关系。
上游登录、加密与计费协议若发生变化，本项目可能随时失效，不作长期可用性承诺。
