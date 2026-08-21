/**
 * dsh-ollama-web-search — Ollama 云 web_search provider（host 插件）
 *
 * web_search 工具 → ctx.web.search() → 按 searchProvider 配置选 provider。
 * 本插件注册 id=`ollama-web-search` 的 provider：search(query) 直连
 * ollama.com/api/web_search（Ollama 云原生搜索 API，POST {query, max_results}
 * 返回 {results:[{title,url,content}]}），转成 dsh 的 sources 格式
 * [{url, title, snippet}]。
 *
 * 对比 ollama launch dsh 的官方集成：那个方案让本地 Ollama 当代理（模型生成
 * 查询词 → 中间件调同一端点 → 模型总结 → 包装 Anthropic 格式），本插件直连
 * 同一个搜索后端，去掉代理层与模型开销，不装本地 Ollama。
 */
import z from "@deepseek-ai/schemastery";
import { credentialRef } from "@deepseek-ai/dsh-credentials";
import { installSettingsSection, settingsNamespace } from "@deepseek-ai/dsh-settings";
import { launchEnvironmentOf } from "@deepseek-ai/dsh-launch-environment";
import { WebError } from "@deepseek-ai/dsh-web";

/** Stable provider id（web row 的 searchProvider 配这个）。 */
const PROVIDER_ID = "ollama-web-search";
/** Ollama 云原生搜索端点。 */
const DEFAULT_BASE_URL = "https://ollama.com/api/web_search";
/** 凭据引用：OLLAMA_API_KEY（credentials 或环境变量）。 */
const DEFAULT_API_KEY_ENV = "OLLAMA_API_KEY";
/** 默认返回结果数上限。 */
const DEFAULT_MAX_RESULTS = 5;
/** 请求头 User-Agent。 */
const USER_AGENT = "dsh-ollama-web-search/0.1.0";
/** Settings namespace：`ollama-web-search` 段（配置页/设置可覆盖）。 */
const SETTINGS_NAMESPACE = settingsNamespace("ollama-web-search");

const Config = z.object({
  apiKey: z.string().role("secret"),
  apiKeyEnv: z.string().role("credential-ref").default(DEFAULT_API_KEY_ENV),
  baseURL: z.string().default(DEFAULT_BASE_URL),
  maxResults: z.number().step(1).min(1).default(DEFAULT_MAX_RESULTS),
});

/** Ollama 云搜索 provider：search(query) → ollama.com/api/web_search → sources。 */
class OllamaWebSearchProvider {
  id = PROVIDER_ID;
  resolveOptions;
  constructor(resolveOptions) {
    this.resolveOptions = resolveOptions;
  }
  available() {
    const o = this.resolveOptions();
    return (o.apiKey?.length > 0 || o.resolveApiKey !== void 0) && URL.canParse(o.baseURL);
  }
  async search(request, signal) {
    const options = this.resolveOptions();
    const apiKey = await this.apiKey(options, signal);
    throwIfSearchAborted(signal);
    // ollama 官方工具带 ts 参数（签名用）；Bearer key 认证下非必需，加上无害。
    const url = new URL(options.baseURL);
    url.searchParams.set("ts", String(Math.floor(Date.now() / 1000)));
    let response;
    try {
      response = await fetch(url, {
        method: "POST",
        redirect: "error",
        headers: {
          "authorization": `Bearer ${apiKey}`,
          "content-type": "application/json",
          "accept": "application/json",
          "user-agent": USER_AGENT,
        },
        body: JSON.stringify({ query: request.query, max_results: options.maxResults }),
        ...signal !== void 0 ? { signal } : {},
      });
    } catch (error) {
      if (signal?.aborted === true || isAbortError(error)) throw searchAborted(signal, error);
      throw new WebError(`Ollama web search request failed: ${String(error)}`, "WEB_PROVIDER_ERROR", { cause: error });
    }
    if (!response.ok) {
      let message = `Ollama web search API error (HTTP ${response.status})`;
      try {
        const parsed = await response.json();
        const detail = typeof parsed.error === "string" ? parsed.error : parsed.error?.message ?? parsed.message;
        if (detail !== void 0 && detail.length > 0) message = detail;
      } catch { /* ignore */ }
      throw new WebError(message, "WEB_PROVIDER_ERROR");
    }
    try {
      const data = await response.json();
      const sources = [];
      const seen = /* @__PURE__ */ new Set();
      for (const item of data.results ?? []) {
        if (!item || typeof item.url !== "string" || item.url.length === 0 || seen.has(item.url)) continue;
        seen.add(item.url);
        sources.push({
          url: item.url,
          ...item.title != null && item.title.length > 0 ? { title: item.title } : {},
          ...item.content != null && item.content.length > 0 ? { snippet: item.content } : {},
        });
      }
      return { sources, truncated: false };
    } catch (error) {
      if (signal?.aborted === true || isAbortError(error)) throw searchAborted(signal, error);
      if (error instanceof WebError) throw error;
      throw new WebError(`Ollama web search returned an unprocessable response body: ${String(error)}`, "WEB_PROVIDER_ERROR", { cause: error });
    }
  }
  /** 解析一次操作的凭据（不保留在 provider 上）。 */
  async apiKey(options, signal) {
    throwIfSearchAborted(signal);
    if (options.apiKey !== void 0 && options.apiKey.length > 0) return options.apiKey;
    let resolved;
    try {
      resolved = await options.resolveApiKey?.() ?? Promise.resolve(void 0);
    } catch (error) {
      throw new WebError(`Ollama web search credential resolution failed: ${String(error)}`, "WEB_PROVIDER_ERROR", { cause: error });
    }
    if (resolved !== void 0 && resolved.length > 0) return resolved;
    throw new WebError(`Ollama web search has no API key for "${options.apiKeyEnv ?? DEFAULT_API_KEY_ENV}"; store it through the credentials service or export it in the launching environment`, "WEB_PROVIDER_CREDENTIAL_MISSING");
  }
}

/** 把当前 settings section 投影成 provider 下一次搜索的 options。 */
function resolveOptions(ctx, config) {
  const apiKeyEnv = credentialRef(config.apiKeyEnv ?? DEFAULT_API_KEY_ENV);
  const literalApiKey = config.apiKey !== void 0 && config.apiKey.length > 0 ? config.apiKey : void 0;
  return {
    ...literalApiKey === void 0 ? {} : { apiKey: literalApiKey },
    resolveApiKey: async () => {
      const credentials = ctx.get("credentials");
      if (credentials !== void 0) return (await credentials.resolve(apiKeyEnv))?.value;
      const ambient = launchEnvironmentOf(ctx).get(apiKeyEnv);
      return ambient !== void 0 && ambient.value.length > 0 ? ambient.value : void 0;
    },
    apiKeyEnv,
    baseURL: config.baseURL ?? DEFAULT_BASE_URL,
    maxResults: config.maxResults ?? DEFAULT_MAX_RESULTS,
  };
}

/** Cordis 插件名。 */
export const name = "ollama-web-search";
/** 需要 ctx.web（注册搜索 provider）。 */
export const inject = ["web"];

export function apply(ctx, config) {
  let current = () => config;
  installSettingsSection(ctx, SETTINGS_NAMESPACE, Config, config, {
    setSource: (source) => { current = source; },
    onChange: () => {},
  });
  ctx.web.registerSearchProvider(new OllamaWebSearchProvider(() => resolveOptions(ctx, current())));
}

/** 抛 provider 稳定的取消错误（调用方已中止时）。 */
function throwIfSearchAborted(signal) {
  if (signal?.aborted === true) throw searchAborted(signal);
}
/** 构建 provider 稳定的取消错误，保留调用方 reason。 */
function searchAborted(signal, fallback) {
  return new WebError("Ollama web search aborted", "WEB_ABORTED", { cause: signal?.aborted === true ? signal.reason : fallback });
}
/** 判断 fetch/AbortSignal 中止。 */
function isAbortError(error) {
  return error instanceof DOMException && error.name === "AbortError";
}

export { Config, PROVIDER_ID, OllamaWebSearchProvider };
