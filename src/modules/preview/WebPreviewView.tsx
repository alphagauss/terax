import type { WebPreviewTab } from "@/modules/workbench";
import { useCallback } from "react";
import { WebPreviewPane, type WebPreviewPaneHandle } from "./WebPreviewPane";

type Props = {
  tab: WebPreviewTab;
  visible: boolean;
  registerHandle: (id: number, handle: WebPreviewPaneHandle | null) => void;
  onUrlChange: (id: number, url: string) => void;
};

export function WebPreviewView({
  tab,
  visible,
  registerHandle,
  onUrlChange,
}: Props) {
  const handleRef = useCallback(
    (handle: WebPreviewPaneHandle | null) => registerHandle(tab.id, handle),
    [registerHandle, tab.id],
  );
  const handleUrlChange = useCallback(
    (url: string) => onUrlChange(tab.id, url),
    [onUrlChange, tab.id],
  );

  return (
    <WebPreviewPane
      ref={handleRef}
      url={tab.url}
      visible={visible}
      onUrlChange={handleUrlChange}
    />
  );
}
