/**
 * 本文件隔离辅助窗口页面的加载和渲染错误。
 * 失败时仍显示统一窗口外壳和可关闭的本地化错误页，避免隐藏窗口永久残留。
 */

import { AuxiliaryWindowLayout } from "@/auxiliary/AuxiliaryWindowLayout";
import { Component, type ErrorInfo, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

type BoundaryProps = {
  children: ReactNode;
  fallback: ReactNode;
};

type BoundaryState = {
  failed: boolean;
};

class RenderBoundary extends Component<BoundaryProps, BoundaryState> {
  state: BoundaryState = { failed: false };

  static getDerivedStateFromError(): BoundaryState {
    return { failed: true };
  }

  componentDidCatch(error: unknown, info: ErrorInfo): void {
    console.error("辅助窗口页面渲染失败", error, info);
  }

  render(): ReactNode {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

/** 捕获已注册辅助页面的渲染异常并显示公共错误页。 */
export function AuxiliaryWindowErrorBoundary({
  children,
}: {
  children: ReactNode;
}) {
  const fallback = <AuxiliaryWindowUnavailablePage />;
  return <RenderBoundary fallback={fallback}>{children}</RenderBoundary>;
}

/** 显示辅助页面无法加载或渲染时的安全回退内容。 */
export function AuxiliaryWindowUnavailablePage() {
  const { t } = useTranslation("app");
  return (
    <AuxiliaryWindowLayout title={t("auxiliaryWindow.loadFailedTitle")}>
      <main className="grid min-h-0 flex-1 place-items-center p-8 text-center">
        <div className="max-w-sm">
          <h1 className="text-sm font-semibold">
            {t("auxiliaryWindow.loadFailedTitle")}
          </h1>
          <p className="mt-2 text-xs leading-5 text-muted-foreground">
            {t("auxiliaryWindow.loadFailedDescription")}
          </p>
        </div>
      </main>
    </AuxiliaryWindowLayout>
  );
}
