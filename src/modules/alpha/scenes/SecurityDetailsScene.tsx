/** 证券资料场景只消费权威目录，不把数据覆盖时间当作实时行情时间。 */
import { getAlphaSecurity } from "@/modules/alpha/api";
import { alphaQueryKeys } from "@/modules/alpha/query";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";

export function SecurityDetailsScene({
  symbol,
  visible,
}: {
  symbol: string;
  visible: boolean;
}) {
  const { t } = useTranslation("alpha");
  const query = useQuery({
    queryKey: alphaQueryKeys.security(symbol),
    queryFn: () => getAlphaSecurity(symbol),
    enabled: visible,
  });
  if (query.error)
    return (
      <p role="alert" className="p-3 text-xs text-destructive">
        {String(query.error)}
      </p>
    );
  if (!query.data)
    return (
      <p className="p-3 text-xs text-muted-foreground">{t("common.loading")}</p>
    );
  const data = query.data;
  return (
    <div className="space-y-4 p-3 text-xs">
      <div>
        <strong>{data.name}</strong>
        <p className="mt-1 font-mono text-muted-foreground">{data.vt_symbol}</p>
      </div>
      <dl className="space-y-3">
        {[
          ["exchange", data.exchange],
          ["timezone", data.timezone],
          ["intervals", data.intervals.join(", ")],
          [
            "coverage",
            data.data_start && data.data_end
              ? `${data.data_start} / ${data.data_end}`
              : null,
          ],
          ["updated", data.latest_updated_at],
        ].map(([field, value]) => (
          <div key={field}>
            <dt className="text-muted-foreground">
              {t(`desk.details.${field}`)}
            </dt>
            <dd className="mt-1 break-words">
              {value || t("common.unavailable")}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
