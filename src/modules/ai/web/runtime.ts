/** 在主轮开始时解析网络服务，配置及凭据通过宿主快照注入，不依赖 UI 生命周期。 */
import { resolveProviderBaseURL } from "@/modules/ai/providerRegistry";
import { createDeepSeekWebClient } from "./deepseek";
import type { WebServices } from "./types";

export function prepareWebServices(
  apiKey: string | null,
  baseURL?: string,
): WebServices {
  // 启停已进入智能体有效工具快照，这里不重新读取配置改变同轮可用性。
  return createDeepSeekWebClient(
    apiKey,
    resolveProviderBaseURL("deepseek", baseURL),
  );
}
