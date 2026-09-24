# 0003 API 密钥默认存酒馆密钥库，插件设置只存引用

日期：2026-09-24 · 状态：已采用

## 背景

`STDB/D6 §6` 引用官方警告："Never store API keys in extensionSettings"，任何能读 `getContext()` 的扩展或角色卡 iframe 都能读到。但用户明确要求每个演员可配独立密钥。

## 决定

- 默认：密钥通过 `POST /api/secrets/write { key, value, label }` 写入酒馆服务端 `secrets.json`，key 使用该供应商的标准名（`api_key_custom` / `api_key_claude` / `api_key_makersuite` / `api_key_deepseek`），label 形如 `PersonaArena · 连接名`。插件设置只保存返回的 `secret_id`。
- 写入会把该 key 下的新密钥设为"活动"，为不影响酒馆主界面，写入后读取写入前的活动 id 并调用 `/api/secrets/rotate` 轮换回去。
- 例外：Claude / Gemini 使用非官方地址时，后端只接受 `proxy_password`（请求体明文），密钥必须在浏览器可得。此时允许在插件设置里明文保存，界面显示明确警告，并建议改用 OpenAI 兼容中转。
- 密钥输入框写入后立即清空，界面只显示掩码与 label。

## 理由

与酒馆自身、连接配置（Connection Manager 的 `secret-id`）一致；泄露面与酒馆本身相同而不是更大。

## 代价

- 用户删除连接时要同步删除对应密钥（`/api/secrets/delete`），否则密钥库会积累无主条目。
- 明文例外仍然存在，只是缩小到必要场景。
