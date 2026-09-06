/**
 * 本文件实现 SSH 主机密钥确认对话框。
 * 未知密钥与已变更密钥使用不同风险提示，确认结果直接交给原生校验流程。
 */

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/controls/alert-dialog";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { remoteNative } from "./native";
import type { HostKeyPrompt } from "./types";

type Props = {
  prompt: HostKeyPrompt | null;
  onResolved: () => void;
};

/** 展示服务端指纹并等待用户决定是否信任本次 SSH 连接。 */
export function HostKeyDialog({ prompt, onResolved }: Props) {
  const { t } = useTranslation("common");
  const [remember, setRemember] = useState(true);

  const resolve = async (accepted: boolean) => {
    if (!prompt) return;
    try {
      await remoteNative.confirmHostKey(prompt.requestId, accepted, remember);
    } finally {
      setRemember(true);
      onResolved();
    }
  };

  return (
    <AlertDialog open={prompt !== null}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {t(
              prompt?.changed
                ? "remoteWorkspace.hostKey.changedTitle"
                : "remoteWorkspace.hostKey.unknownTitle",
            )}
          </AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-3 text-left">
              <p>
                {t(
                  prompt?.changed
                    ? "remoteWorkspace.hostKey.changedDescription"
                    : "remoteWorkspace.hostKey.unknownDescription",
                )}
              </p>
              <div className="rounded-md bg-muted/70 p-3 font-mono text-[11px] leading-relaxed text-foreground">
                <div>
                  {prompt?.host}:{prompt?.port} ({prompt?.keyType})
                </div>
                <div className="break-all">{prompt?.fingerprint}</div>
              </div>
              <div className="flex items-center gap-2">
                <Checkbox
                  id="ssh-remember-host-key"
                  checked={remember}
                  onCheckedChange={(value) => setRemember(value === true)}
                />
                <Label htmlFor="ssh-remember-host-key">
                  {t("remoteWorkspace.hostKey.remember")}
                </Label>
              </div>
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={() => void resolve(false)}>
            {t("remoteWorkspace.hostKey.cancel")}
          </AlertDialogCancel>
          <AlertDialogAction
            variant={prompt?.changed ? "destructive" : "default"}
            onClick={() => void resolve(true)}
          >
            {t(
              prompt?.changed
                ? "remoteWorkspace.hostKey.trustChanged"
                : "remoteWorkspace.hostKey.trust",
            )}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
