# 0002 演员请求经由 SillyTavern 后端发出，不在浏览器直连供应商

日期：2026-09-24 · 状态：已采用

## 背景

每个演员要能配置不同的接口地址、密钥、模型（OpenAI 兼容 / Claude / Gemini / 中转站）。可选方案：
1. 浏览器 `fetch` 直连供应商；
2. 走酒馆后端 `/api/backends/chat-completions/generate`。

## 决定

走酒馆后端，通过 `SillyTavern.getContext().ChatCompletionService.processRequest(payload, {}, extract, signal)` 发起。各类型映射（依据 release 分支 `src/endpoints/backends/chat-completions.js` 与 `public/scripts/custom-request.js`）：

| 连接类型 | `chat_completion_source` | 地址字段 | 密钥字段 |
|---|---|---|---|
| OpenAI 兼容 | `custom` | `custom_url` | `secret_id`（`api_key_custom`）或 `custom_include_headers` |
| Claude 官方地址 | `claude` | — | `secret_id`（`api_key_claude`） |
| Claude 自定义地址 | `claude` | `reverse_proxy` | `proxy_password` |
| Gemini 官方地址 | `makersuite` | — | `secret_id`（`api_key_makersuite`） |
| Gemini 自定义地址 | `makersuite` | `reverse_proxy` | `proxy_password` |
| DeepSeek 官方 | `deepseek` | — | `secret_id`（`api_key_deepseek`） |
| 连接配置 | 由 `ConnectionManagerRequestService.sendRequest(profileId, …)` 处理 | | |
| 酒馆当前连接 | 读取 `chatCompletionSettings` 的 source/model/custom_url | | 当前活动密钥 |

后端对 `custom` 源的请求头是 `{ Authorization: 'Bearer ' + apiKey, ...custom_include_headers }`，后者覆盖前者。

## 理由

- 浏览器直连受供应商 CORS 限制（OpenAI 官方不允许），酒馆后端没有这个问题。
- Claude / Gemini 的消息格式转换、system 合并、prefill、思考参数、流式解析都由酒馆后端与 `custom-request.js` 完成，不必自己维护一套。
- 密钥可以放酒馆自己的密钥库（见 ADR-0003）。

## 代价

- 依赖 `ChatCompletionService` 这个 context 导出（1.13+ 存在）。缺失时降级到 `generateRaw`，只能用酒馆当前连接。
- Claude 没有 `/status` 模型列表端点，只能内置常用列表 + 手填。
