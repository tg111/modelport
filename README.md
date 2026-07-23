# ModelPort

ModelPort 是一个面向 Codex 和 OpenAI 兼容平台的本地 AI API 网关。它提供管理后台、渠道管理、代理模型名、渠道轮询和使用记录。

项目优先支持 Codex 使用的 Responses API，同时也提供 Chat Completions 和图片生成/编辑接口，便于接入第三方聊天平台和生图渠道。

在线演示：<https://tg111.github.io/modelport/>

## 功能

* 使用同一个 API Key 访问管理后台和 Codex 反代接口。
* 在后台添加 OpenAI-compatible 渠道：渠道名称、渠道官网、API 地址和密钥。
* 渠道协议默认自动识别，也可手动选择 `Responses 原生` 或 `Chat Completions 兼容`。
* 从渠道 API 获取模型列表，选择要启用的上游模型 ID，并设置代理模型名。
* 请求时按代理模型名匹配渠道，同一代理模型名存在多个渠道时自动轮询。
* 当前渠道失败时自动尝试下一个匹配渠道。
* 记录使用时间、模型、源模型、渠道和成功状态。
* 支持 OpenAI Responses API 非流式和流式 SSE 透传。
* 支持 OpenAI Chat Completions API 非流式和流式 SSE 透传。
* 支持 OpenAI 图片生成和图片编辑接口中转。

## 快速开始

macOS / Linux：

```bash
./start.sh
```

Windows：

```bat
start.bat
```

Docker：

```bash
cp .env.example .env
docker build -t modelport .
docker run -d \
  --name modelport \
  --env-file .env \
  -p 8880:8880 \
  -v modelport-data:/app/data \
  modelport
```

Docker Compose：

```bash
cp .env.example .env
docker compose up -d --build
```

项目配置放在根目录的 `.env`：

```dotenv
PORT=8880
HOST_PORT=8880
PROXY_API_KEY=pwd
```

`PORT` 是容器或 Node 进程内部监听端口，`HOST_PORT` 是 Docker Compose 暴露到宿主机的端口。Compose 会自动读取项目根目录 `.env` 来替换 `docker-compose.yml` 里的端口变量。

默认 API Key 是 `pwd`。如果服务会暴露到本机以外，请务必设置 `PROXY_API_KEY`。

打开管理后台：

```text
http://localhost:8880/admin
```

## Codex 配置

在 `~/.codex/config.toml` 中添加自定义 provider：

```toml
model = "你的代理模型名"
model_provider = "modelport"

[model_providers.modelport]
name = "ModelPort"
base_url = "http://127.0.0.1:8880/v1"
env_key = "MODELPORT_API_KEY"
wire_api = "responses"
```

设置环境变量：

```bash
export MODELPORT_API_KEY="pwd"
```

后台中启用的代理模型名会出现在 `/v1/models`。客户端请求某个代理模型名时，本服务会把它映射到渠道里的上游模型 ID。

本服务同时兼容带 `/v1` 和不带 `/v1` 的入口。Codex 的 `base_url` 可以填写 `http://127.0.0.1:8880/v1`，也可以填写 `http://127.0.0.1:8880`。

## 第三方聊天平台配置

如果平台支持 OpenAI Chat Completions，配置：

```text
Base URL: http://127.0.0.1:8880/v1
API Key: .env 里的 PROXY_API_KEY
Model: 后台设置的代理模型名
```

注意：支持 `/v1/chat/completions` 不等于一定兼容所有聊天平台。它覆盖标准 OpenAI Chat Completions 请求；如果平台依赖私有字段、特殊工具调用格式或非 OpenAI 协议，需要按平台实测。

## 渠道要求

渠道按用途需要支持对应的 OpenAI 格式接口：

```text
GET  /v1/models
POST /v1/responses
POST /v1/chat/completions
POST /v1/images/generations
POST /v1/images/edits
```

本服务使用 Bearer token 调用上游渠道。

添加渠道时，渠道协议默认 `自动识别`。保存后会在后台优先探测 `/v1/responses`，如果渠道不支持 Responses API，再探测 `/v1/chat/completions`，并把渠道协议异步更新为实际识别到的类型。自动识别会向上游发送一次最小化协议探测请求，明确禁止测试请求的渠道请手动选择协议。

如果某个渠道只支持 `/v1/chat/completions`，可以手动把渠道协议设为 `Chat Completions 兼容`。此时 Codex 请求 `/v1/responses` 会被桥接到上游 `/v1/chat/completions`。

添加渠道时，API 地址只支持服务根地址或 `/v1` 地址：

```text
https://api.openai.com
https://api.openai.com/v1
```

不要填写具体 endpoint，例如 `/v1/responses` 或 `/v1/chat/completions`。

## API

管理后台 API 和 Codex 反代 API 都需要：

```http
Authorization: Bearer <.env 里的 PROXY_API_KEY>
```

常用接口：

* `GET /api/preferences`
* `PUT /api/preferences`（持久化管理后台的渠道展示范围和排序方式）
* `GET /api/channels`
* `POST /api/channels`
* `POST /api/channels/:id/fetch-models`
* `POST /api/channels/:id/test`
* `PUT /api/channels/:id/models`
* `DELETE /api/channels/:id`
* `GET /api/usage`（支持 `status`、`model`、`channelId`、`page`、`pageSize` 查询参数；记录包含保留 1 位小数的 `durationSeconds`，以及上游返回的 `inputTokens`、`outputTokens`、`totalTokens`，上游未提供 usage 时对应字段为空）
* `GET /v1/models`
* `POST /v1/responses`
* `POST /v1/chat/completions`
* `POST /v1/images/generations`
* `POST /v1/images/edits`

兼容入口：

* `GET /models`
* `POST /responses`
* `POST /chat/completions`
* `POST /images/generations`
* `POST /images/edits`

## 数据目录

数据默认保存在：

```text
data/
```

包含：

* `db.json`：渠道配置、代理模型名和使用记录。

## 注意事项

* `Responses 原生` 渠道按请求路径透传，只替换 `model`。
* `Chat Completions 兼容` 渠道会把 `/v1/responses` 请求转换成 `/v1/chat/completions`，并把 Chat 响应转换回 Responses 形态。
* 标准 OpenAI `tools`、`tool_choice`、`parallel_tool_calls`、Responses `function_call` / `function_call_output` 会尽量桥接；复杂 reasoning 和 provider 私有字段只做保守处理。
* 图片编辑接口使用 `multipart/form-data`，本服务会替换其中的 `model` 字段并保留文件内容。
* 工具调用是否可用取决于上游渠道和模型本身是否支持；本服务不执行工具，只转换/转发工具调用协议结构。
* 使用记录最多保留最近 1000 条。
