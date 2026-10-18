/**
 * 本文件实现尚未配置模型时的 AI 侧栏连接提示。
 * 只负责引导用户打开模型设置，不读取或保存密钥。
 */

import { Button } from "@/components/controls/button";
import Key01Icon from "@hugeicons/core-free-icons/Key01Icon";
import { HugeiconsIcon } from "@hugeicons/react";
import { useTranslation } from "react-i18next";

export function AiInputBarConnect({ onAdd }: { onAdd: () => void }) {
  const { t } = useTranslation("ai");
  return (
    <div className="relative z-10 shrink-0 px-3 pt-2 pb-3">
      <div className="flex flex-col items-start gap-2 rounded-2xl border border-border/70 bg-card p-3 text-xs shadow-[0_10px_32px_rgba(0,0,0,0.16),0_2px_8px_rgba(0,0,0,0.08)]">
        <span className="text-muted-foreground">
          {t("composer.connectDescription")}
        </span>
        <Button size="xs" onClick={onAdd}>
          <HugeiconsIcon icon={Key01Icon} />
          {t("composer.connectProvider")}
        </Button>
      </div>
    </div>
  );
}
