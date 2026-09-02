/**
 * 本文件统一渲染 AI Provider 图标。
 * 未配置专属图标的新 Provider 自动使用通用连接图标，不影响注册和运行。
 */

import type { ProviderId } from "@/modules/ai/config";
import {
  AppleIcon,
  ChatGptIcon,
  ClaudeIcon,
  ComputerIcon,
  CpuIcon,
  DeepseekIcon,
  FlashIcon,
  GlobeIcon,
  GoogleGeminiIcon,
  Grok02Icon,
  MistralIcon,
  PlugIcon,
  ServerStack01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";

const ICON_BY_PROVIDER: Partial<Record<ProviderId, typeof ChatGptIcon>> = {
  openai: ChatGptIcon,
  anthropic: ClaudeIcon,
  google: GoogleGeminiIcon,
  xai: Grok02Icon,
  cerebras: CpuIcon,
  groq: FlashIcon,
  deepseek: DeepseekIcon,
  mistral: MistralIcon,
  openrouter: GlobeIcon,
  "openai-compatible": PlugIcon,
  lmstudio: ComputerIcon,
  mlx: AppleIcon,
  ollama: ServerStack01Icon,
};

/** 渲染 Provider 专属图标，未登记图标时使用通用连接图标。 */
export function ProviderIcon({
  provider,
  size = 14,
  className,
}: {
  provider: ProviderId;
  size?: number;
  className?: string;
}) {
  return (
    <HugeiconsIcon
      icon={ICON_BY_PROVIDER[provider] ?? PlugIcon}
      size={size}
      strokeWidth={1.75}
      className={className}
    />
  );
}
