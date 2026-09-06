/**
 * 本文件实现设置窗口的关于页面。
 * 页面展示应用版本、项目入口和用户可见的第三方图表引擎署名。
 */

import { Button } from "@/components/controls/button";
import { PageHeader } from "@/components/layout/PageHeader";
import { GithubIcon, Globe02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { getName, getVersion } from "@tauri-apps/api/app";
import { openUrl } from "@tauri-apps/plugin-opener";
import { arch, platform } from "@tauri-apps/plugin-os";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

const REPO_URL = "https://github.com/crynta/terax-ai";
const WEBSITE = "https://terax.app";
const TRADINGVIEW_URL = "https://www.tradingview.com/";

const PLATFORM_LABEL: Record<string, string> = {
  macos: "macOS",
  windows: "Windows",
  linux: "Linux",
  ios: "iOS",
  android: "Android",
  freebsd: "FreeBSD",
};

/** 展示 Terax 构建信息、项目链接和必要的第三方署名。 */
export function AboutSection() {
  const { t } = useTranslation();
  const [version, setVersion] = useState("");
  const [name, setName] = useState("Terax");
  const [build, setBuild] = useState("");

  useEffect(() => {
    void getVersion().then(setVersion);
    void getName().then(setName);
    try {
      const p = platform();
      const a = arch();
      const platformLabel = PLATFORM_LABEL[p] ?? p;
      setBuild(`${platformLabel} · ${a}`);
    } catch {
      setBuild("");
    }
  }, []);

  return (
    <div className="flex flex-col gap-section">
      <PageHeader title={t("about.header.title")} description="" />

      <div className="flex items-center gap-3 rounded-lg border border-border/60 bg-card/60 p-3">
        <img src="/logo.png" alt="" className="size-12" draggable={false} />
        <div className="flex min-w-0 flex-col">
          <span className="text-[15px] font-semibold tracking-tight">
            {name}
          </span>
          <span className="text-[11px] text-muted-foreground">
            {t("about.tagline")}
          </span>
          <span className="mt-1 font-mono text-[11px] text-muted-foreground">
            v{version || "-"}
          </span>
        </div>
      </div>

      <dl className="grid grid-cols-[110px_minmax(0,1fr)] gap-y-field text-xs leading-[18px]">
        <dt className="text-muted-foreground">{t("about.build")}</dt>
        <dd className="font-mono text-xs">
          {build ? `${build} · v${version}` : `v${version}`}
        </dd>

        <dt className="text-muted-foreground">{t("about.bundleId")}</dt>
        <dd className="font-mono text-xs">app.crynta.terax</dd>

        <dt className="text-muted-foreground">{t("about.license")}</dt>
        <dd>Apache 2.0</dd>

        <dt className="text-muted-foreground">{t("about.chartEngine")}</dt>
        <dd>
          <button
            type="button"
            onClick={() => void openUrl(TRADINGVIEW_URL)}
            className="inline-flex items-center gap-1.5 rounded-md text-[12px] underline-offset-2 hover:text-foreground hover:underline"
          >
            <HugeiconsIcon icon={Globe02Icon} size={12} strokeWidth={1.75} />
            {t("about.tradingViewAttribution")}
          </button>
        </dd>

        <dt className="text-muted-foreground">{t("about.sourceCode")}</dt>
        <dd>
          <button
            type="button"
            onClick={() => void openUrl(REPO_URL)}
            className="inline-flex items-center gap-1.5 rounded-md text-[12px] underline-offset-2 hover:text-foreground hover:underline"
          >
            <HugeiconsIcon icon={GithubIcon} size={12} strokeWidth={1.75} />
            crynta/terax-ai
          </button>
        </dd>
        <dt className="text-muted-foreground">{t("about.website")}</dt>
        <dd>
          <button
            type="button"
            onClick={() => void openUrl(WEBSITE)}
            className="inline-flex items-center gap-1.5 rounded-md text-[12px] underline-offset-2 hover:text-foreground hover:underline"
          >
            <HugeiconsIcon icon={Globe02Icon} size={12} strokeWidth={1.75} />
            terax.app
          </button>
        </dd>
      </dl>

      <div className="flex gap-2">
        <Button
          variant="outline"
          onClick={() => void openUrl(REPO_URL)}
          className="gap-1.5"
        >
          <HugeiconsIcon icon={GithubIcon} size={12} strokeWidth={1.75} />
          {t("about.viewOnGitHub")}
        </Button>
        <Button
          variant="ghost"
          onClick={() => void openUrl(`${REPO_URL}/issues/new`)}
        >
          {t("about.reportIssue")}
        </Button>
      </div>
    </div>
  );
}
