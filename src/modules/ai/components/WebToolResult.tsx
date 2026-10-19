/** 网络工具结果以来源与纯文本展示，不执行网页内容或自动加载站点图片。 */
import { useTranslation } from "react-i18next";
import { openUrl } from "@tauri-apps/plugin-opener";
import { reportError } from "@/lib/errors";
import { isWebUrl } from "@/modules/ai/web/types";

export function WebToolResult({ output }: { output: unknown }) {
  const { t } = useTranslation("ai");
  if (!output || typeof output !== "object") return null;
  const value = output as Record<string, unknown>;
  const pages = Array.isArray(value.results) ? value.results : [value];
  return (
    <div className="space-y-3">
      {pages.length === 0 ? <p>{t("chat.web.empty")}</p> : null}
      {pages.map((page, index) => {
        if (
          !page ||
          typeof page !== "object" ||
          typeof page.url !== "string" ||
          !isWebUrl(page.url)
        )
          return null;
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: 单次工具结果顺序不可变，同一来源可能返回多个片段。
          <div key={`${index}:${page.url}`} className="space-y-1">
            <a
              className="text-primary underline break-all"
              href={page.url}
              onClick={(event) => {
                event.preventDefault();
                void openUrl(page.url).catch((error) =>
                  reportError(t("chat.web.openError"), { error }),
                );
              }}
            >
              {typeof page.title === "string" && page.title
                ? page.title
                : page.url}
            </a>
            <div className="text-muted-foreground break-all">{page.url}</div>
            <p className="whitespace-pre-wrap break-words">
              {typeof page.content === "string" ? page.content : ""}
            </p>
            {page.truncated === true ? (
              <p className="text-muted-foreground">{t("chat.web.truncated")}</p>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
