/**
 * 统一渲染随应用打包的 Provider 品牌图标。
 * 彩色标记保留品牌色，单色标记以遮罩跟随主题文字色；未知 Provider 使用通用连接图标。
 */
import type { ProviderId } from "@/modules/ai/config";
import { cn } from "@/lib/utils";
import PlugIcon from "@hugeicons/core-free-icons/Plug01Icon";
import { HugeiconsIcon } from "@hugeicons/react";
import openai from "@lobehub/icons-static-svg/icons/openai.svg";
import anthropic from "@lobehub/icons-static-svg/icons/anthropic.svg";
import gemini from "@lobehub/icons-static-svg/icons/gemini-color.svg";
import grok from "@lobehub/icons-static-svg/icons/grok.svg";
import cerebras from "@lobehub/icons-static-svg/icons/cerebras-color.svg";
import groq from "@lobehub/icons-static-svg/icons/groq.svg";
import deepseek from "@lobehub/icons-static-svg/icons/deepseek-color.svg";
import mistral from "@lobehub/icons-static-svg/icons/mistral-color.svg";
import openrouter from "@lobehub/icons-static-svg/icons/openrouter.svg";
import lmstudio from "@lobehub/icons-static-svg/icons/lmstudio.svg";
import apple from "@lobehub/icons-static-svg/icons/apple.svg";
import ollama from "@lobehub/icons-static-svg/icons/ollama.svg";
import zhipu from "@lobehub/icons-static-svg/icons/zhipu-color.svg";

const ICON_BY_PROVIDER: Partial<
  Record<ProviderId, { src: string; color?: boolean }>
> = {
  openai: { src: openai },
  anthropic: { src: anthropic },
  google: { src: gemini, color: true },
  xai: { src: grok },
  cerebras: { src: cerebras, color: true },
  groq: { src: groq },
  deepseek: { src: deepseek, color: true },
  mistral: { src: mistral, color: true },
  openrouter: { src: openrouter },
  lmstudio: { src: lmstudio },
  mlx: { src: apple },
  ollama: { src: ollama },
  zhipu: { src: zhipu, color: true },
};

/** 图标仅作品牌提示，可访问名称由相邻文本或宿主按钮提供。 */
export function ProviderIcon({
  provider,
  size = 14,
  className,
}: {
  provider: ProviderId;
  size?: number;
  className?: string;
}) {
  const icon = ICON_BY_PROVIDER[provider];
  if (!icon) {
    return (
      <HugeiconsIcon
        icon={PlugIcon}
        size={size}
        strokeWidth={1.75}
        className={cn("shrink-0", className)}
        aria-hidden="true"
      />
    );
  }
  const image = `url("${icon.src}")`;
  return (
    <span
      aria-hidden="true"
      className={cn("inline-block shrink-0 align-middle", className)}
      style={{
        width: size,
        height: size,
        ...(icon.color
          ? {
              backgroundImage: image,
              backgroundSize: "contain",
              backgroundPosition: "center",
              backgroundRepeat: "no-repeat",
            }
          : {
              backgroundColor: "currentColor",
              mask: `${image} center / contain no-repeat`,
              WebkitMask: `${image} center / contain no-repeat`,
            }),
      }}
    />
  );
}
