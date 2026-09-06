/**
 * 本文件提供 Alpha 业务页面统一的服务可用性边界。
 * 服务未运行时阻止业务页面挂载，避免通过失败的业务请求判断服务状态。
 */

import { Button } from "@/components/controls/button";
import { AlphaLoading } from "@/modules/alpha/components/AlphaPagePrimitives";
import { useAlphaServiceStatus } from "@/modules/alpha/query";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

type Props = {
  visible: boolean;
  children: ReactNode;
};

/** 仅在共享 Alpha 服务运行时挂载业务页面。 */
export function AlphaServiceBoundary({ visible, children }: Props) {
  const { t } = useTranslation("alpha");
  const service = useAlphaServiceStatus(visible);

  if (!service.data) {
    if (service.error && !service.isFetching) {
      return (
        <ServiceNotice
          title={t("errors.status")}
          description={String(service.error)}
          action={
            <Button variant="outline" onClick={() => void service.refetch()}>
              {t("common.retry")}
            </Button>
          }
        />
      );
    }
    return <AlphaLoading label={t("service.loading")} />;
  }

  if (!service.data?.running) {
    const description =
      service.data?.issue === "portConflict"
        ? t("service.portConflict", { port: service.data.port })
        : service.data?.configured
          ? t("service.startRequired")
          : t("service.configureRequired");
    return (
      <ServiceNotice
        title={t("service.unavailableTitle")}
        description={description}
      />
    );
  }

  return children;
}

/** 渲染占满页面的 Alpha 服务状态说明。 */
function ServiceNotice({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="grid h-full place-items-center p-6">
      <div className="flex max-w-md flex-col items-center gap-3 text-center">
        <div>
          <h1 className="text-sm font-medium text-foreground">{title}</h1>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            {description}
          </p>
        </div>
        {action}
      </div>
    </div>
  );
}
