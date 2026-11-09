/** 探测当前 WSL 发行版，丢弃工作区或重检轮次变化后的响应。 */

import type { CapabilityReport } from "@/modules/workspace/capabilities";
import { useWorkspaceEnvStore } from "@/modules/workspace";
import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";
import { CapabilityPopover } from "./CapabilityPopover";

const CHECKING: CapabilityReport = {
  state: "checking",
  checkedAt: null,
  features: [],
  commands: [],
};
const UNKNOWN: CapabilityReport = { ...CHECKING, state: "unknown" };

/** 自动检测当前 WSL Workspace，并复用状态栏的显式重检入口。 */
export function WslCapabilityControl() {
  const distro = useWorkspaceEnvStore((state) =>
    state.env.kind === "wsl" ? state.env.distro : null,
  );
  const [revision, setRevision] = useState(0);
  const [result, setResult] = useState<{
    distro: string;
    revision: number;
    report: CapabilityReport | null;
  }>();

  useEffect(() => {
    if (!distro) return;
    let active = true;
    const apply = (report: CapabilityReport | null) => {
      if (active) setResult({ distro, revision, report });
    };
    void invoke<CapabilityReport>("wsl_capabilities_probe").then(apply, () =>
      apply(null),
    );
    return () => {
      active = false;
    };
  }, [distro, revision]);

  if (!distro) return null;
  const current =
    result?.distro === distro && result.revision === revision
      ? (result.report ?? UNKNOWN)
      : CHECKING;
  return (
    <CapabilityPopover
      kind="wsl"
      report={current}
      onRecheck={() => setRevision((value) => value + 1)}
    />
  );
}
