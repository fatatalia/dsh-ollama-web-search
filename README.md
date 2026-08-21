# dsh-ollama-web-search

让 dsh 的 `web_search` 工具直连 **Ollama 云搜索服务**（`ollama.com/api/web_search`），替代 DeepSeek 官方搜索。

无需本地 Ollama、无需模型中间件，零模型开销——`web_search` 调用一次 HTTP 直接拿结果。

## 背景

dsh 自带的 `web_search` 工具默认走 `deepseek-official` provider（DeepSeek 的 Anthropic 兼容 Messages API + `web_search_20250305` 服务端工具），需要 DeepSeek API key。

[ollama launch dsh 官方集成](https://docs.ollama.com/integrations/deepseek-harness) 的做法是：本地 Ollama 当代理（模型生成查询词 → 中间件调 `ollama.com/api/web_search` → 模型总结 → 包装成 Anthropic `web_search_tool_result`）。这个方案：
- 需要安装并常驻本地 Ollama
- 每次搜索要 2 次模型推理（生成查询词 + 总结结果）
- 模型与搜索强耦合

本插件**直连同一个搜索后端**（`ollama.com/api/web_search`），去掉代理层与模型开销。

## 原理

```
web_search 工具 → ctx.web.search() → 按 searchProvider 配置选 provider
  → ollama-web-search provider
  → POST https://ollama.com/api/web_search  {query, max_results}
  → {results: [{title, url, content}]}
  → 转成 dsh 的 sources 格式 [{url, title, snippet}] 返回给模型
```

认证用 `OLLAMA_API_KEY`（Bearer），不需要 Ollama 官方集成用的签名机制。

## 安装

```sh
dsh plugin --profile web add dsh-ollama-web-search@latest
```

或从源码：

```sh
git clone https://github.com/fatatalia/dsh-ollama-web-search
cd dsh-ollama-web-search
dsh plugin --profile web add .
```

装完重启 dsh web 生效。插件会：
1. 注册 `ollama-web-search` 搜索 provider
2. 把 `web` 服务的 `searchProvider` 切到 `ollama-web-search`

## 配置

凭据：`~/.dsh/.credentials.yaml` 或环境变量 `OLLAMA_API_KEY`（与 ollama 模型 provider 共用）。

可选的 settings 段（`~/.dsh/settings.yaml`）：

```yaml
ollama-web-search:
  apiKeyEnv: OLLAMA_API_KEY   # 凭据引用
  baseURL: https://ollama.com/api/web_search  # 搜索端点
  maxResults: 5               # 默认返回结果数上限
```

## 验证

装好后调用 `web_search` 工具即可：

```
web_search("DeepSeek 最新动态") → 返回多条来源（title/url/snippet）
```

也可直接 curl 验证端点：

```bash
curl -s -X POST https://ollama.com/api/web_search \
  -H "Authorization: Bearer $OLLAMA_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"query":"test","max_results":3}'
```

## 与 DeepSeek 官方搜索的差异

| | 本插件 | DeepSeek 官方（deepseek-official） |
|---|---|---|
| 搜索后端 | ollama.com 云 | api.deepseek.com |
| 认证 | OLLAMA_API_KEY | DEEPSEEK_API_KEY |
| 模型调用 | 无（直出结果） | 1 次模型 turn（服务端搜索） |
| 依赖 | 无 | DeepSeek API |

## 许可

MIT
