/**
 * 本文件实现工作台图表的懒加载指标选择与编辑对话框。
 * Dialog 按需查询服务端 definition，只管理有界实例配置，不执行指标计算。
 */

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/controls/select";
import { Button } from "@/components/controls/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/controls/dialog";
import { Input } from "@/components/controls/input";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import { getAlphaStudyDefinitions } from "@/modules/alpha/api";
import {
  countSeparateChartStudies,
  createChartStudyInstance,
  MAX_CHART_STUDIES,
  MAX_SEPARATE_CHART_STUDIES,
  validateChartStudyParams,
  type ChartStudyDefinition,
  type ChartStudyInstance,
  type ChartStudyStyle,
  type ChartStudyType,
} from "@/modules/alpha/chart/studies/model";
import { alphaQueryKeys } from "@/modules/alpha/query";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

type Props = {
  open: boolean;
  editingInstanceId: string | null;
  instances: readonly ChartStudyInstance[];
  onOpenChange: (open: boolean) => void;
  onChange: (instances: ChartStudyInstance[]) => void;
};

const LINE_WIDTHS = [1, 2, 3, 4] as const;

/** 创建不会与已持久化实例冲突的稳定指标 ID。 */
function createInstanceId(type: ChartStudyType): string {
  return `${type}-${crypto.randomUUID()}`;
}

/** 懒加载的指标目录与参数编辑对话框。 */
export default function IndicatorDialog({
  open,
  editingInstanceId,
  instances,
  onOpenChange,
  onChange,
}: Props) {
  const { t } = useTranslation("alpha");
  const definitionsQuery = useQuery({
    queryKey: alphaQueryKeys.studyDefinitions,
    queryFn: getAlphaStudyDefinitions,
    enabled: open,
    staleTime: 5 * 60_000,
  });
  const [search, setSearch] = useState("");
  const [editTargetId, setEditTargetId] = useState<string | null>(null);
  const [selectedType, setSelectedType] = useState<ChartStudyType | null>(null);
  const [params, setParams] = useState<Record<string, number>>({});
  const [styles, setStyles] = useState<Record<string, ChartStudyStyle>>({});
  const [invalid, setInvalid] = useState(false);
  const definitions = definitionsQuery.data ?? [];
  const definition =
    definitions.find((item) => item.type === selectedType) ?? null;
  const filteredDefinitions = useMemo(() => {
    const keyword = search.trim().toLocaleLowerCase();
    if (!keyword) return definitions;
    return definitions.filter((item) =>
      `${item.type} ${t(`data.chart.studies.types.${item.type}`)}`
        .toLocaleLowerCase()
        .includes(keyword),
    );
  }, [definitions, search, t]);

  useEffect(() => {
    if (!open || definitions.length === 0) return;
    const editing = instances.find(
      (instance) => instance.instanceId === editingInstanceId,
    );
    if (editing) {
      setEditTargetId(editing.instanceId);
      setSelectedType(editing.type);
      setParams({ ...editing.params });
      setStyles(
        Object.fromEntries(
          Object.entries(editing.styles).map(([key, style]) => [
            key,
            { ...style },
          ]),
        ),
      );
      setInvalid(false);
    }
  }, [definitions.length, editingInstanceId, instances, open]);

  const selectDefinition = (next: ChartStudyDefinition) => {
    const draft = createChartStudyInstance(next, `${next.type}-draft`);
    setEditTargetId(null);
    setSelectedType(next.type);
    setParams(draft.params);
    setStyles(draft.styles);
    setInvalid(false);
  };

  const separateLimitReached =
    definition?.pane === "separate" &&
    editTargetId === null &&
    countSeparateChartStudies(instances) >= MAX_SEPARATE_CHART_STUDIES;
  const totalLimitReached =
    editTargetId === null && instances.length >= MAX_CHART_STUDIES;

  const save = () => {
    if (
      !definition ||
      !validateChartStudyParams(definition, params) ||
      separateLimitReached ||
      totalLimitReached
    ) {
      setInvalid(true);
      return;
    }
    if (editTargetId) {
      onChange(
        instances.map((instance) =>
          instance.instanceId === editTargetId
            ? { ...instance, params: { ...params }, styles: { ...styles } }
            : instance,
        ),
      );
    } else {
      onChange([
        ...instances,
        {
          ...createChartStudyInstance(
            definition,
            createInstanceId(definition.type),
          ),
          params: { ...params },
          styles: { ...styles },
        },
      ]);
    }
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        className="grid h-[min(38rem,calc(100vh-3rem))] w-[min(46rem,calc(100vw-2rem))] max-w-none grid-rows-[auto_minmax(0,1fr)_auto] gap-0 overflow-hidden p-0 sm:max-w-none"
      >
        <DialogHeader className="border-b border-border/60 px-5 py-4">
          <DialogTitle>{t("data.chart.studies.dialog.title")}</DialogTitle>
          <DialogDescription>
            {t("data.chart.studies.dialog.description")}
          </DialogDescription>
        </DialogHeader>
        <div className="grid min-h-0 grid-cols-[minmax(12rem,0.8fr)_minmax(16rem,1.2fr)]">
          <div className="min-h-0 border-r border-border/60 p-3">
            <Input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder={t("data.chart.studies.dialog.search")}
              aria-label={t("data.chart.studies.dialog.search")}
            />
            <div className="mt-3 max-h-[calc(100%-2.75rem)] space-y-1 overflow-y-auto">
              {definitionsQuery.isPending ? (
                <div className="flex items-center gap-2 px-2 py-3 text-xs text-muted-foreground">
                  <Spinner className="size-3.5" />
                  {t("common.loading")}
                </div>
              ) : definitionsQuery.isError ? (
                <div className="px-2 py-3 text-xs text-destructive">
                  {t("data.chart.studies.dialog.loadError")}
                </div>
              ) : (
                filteredDefinitions.map((item) => (
                  <button
                    key={item.type}
                    type="button"
                    className="flex w-full items-center justify-between rounded-md px-2.5 py-2 text-left text-xs hover:bg-muted/70"
                    data-selected={selectedType === item.type}
                    aria-pressed={selectedType === item.type}
                    onClick={() => selectDefinition(item)}
                  >
                    <span>{t(`data.chart.studies.types.${item.type}`)}</span>
                    <span className="text-[10px] text-muted-foreground">
                      {t(`data.chart.studies.panes.${item.pane}`)}
                    </span>
                  </button>
                ))
              )}
            </div>
          </div>
          <div className="min-h-0 overflow-y-auto p-4">
            {definition ? (
              <div className="space-y-5">
                <div>
                  <div className="text-sm font-medium">
                    {t(`data.chart.studies.types.${definition.type}`)}
                  </div>
                  <div className="mt-1 text-xs text-muted-foreground">
                    {t(`data.chart.studies.panes.${definition.pane}`)}
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  {definition.params.map((param) => (
                    <div key={param.key} className="space-y-1.5">
                      <Label htmlFor={`study-param-${param.key}`}>
                        {t(`data.chart.studies.params.${param.key}`)}
                      </Label>
                      <Input
                        id={`study-param-${param.key}`}
                        type="number"
                        min={param.min}
                        max={param.max}
                        step={param.step}
                        value={params[param.key] ?? ""}
                        onChange={(event) => {
                          setParams((current) => ({
                            ...current,
                            [param.key]: event.target.valueAsNumber,
                          }));
                          setInvalid(false);
                        }}
                      />
                    </div>
                  ))}
                </div>
                <div className="space-y-3">
                  {definition.outputs.map((output) => {
                    const style = styles[output.id] ?? {
                      color: "#8b94a7",
                      lineWidth: 2,
                    };
                    const updateStyle = (next: Partial<ChartStudyStyle>) =>
                      setStyles((current) => ({
                        ...current,
                        [output.id]: { ...style, ...next },
                      }));
                    return (
                      <div
                        key={output.id}
                        className="rounded-md border border-border/60 p-3"
                      >
                        <div className="mb-2 text-xs font-medium">
                          {t(
                            `data.chart.studies.outputs.${definition.type}.${output.id}`,
                          )}
                        </div>
                        <div className="grid grid-cols-2 gap-3">
                          <div className="space-y-1.5">
                            <Label>
                              {t("data.chart.studies.styles.color")}
                            </Label>
                            <Input
                              type="color"
                              value={style.color}
                              aria-label={t("data.chart.studies.styles.color")}
                              onChange={(event) =>
                                updateStyle({ color: event.target.value })
                              }
                              className="p-1"
                            />
                          </div>
                          <div className="space-y-1.5">
                            <Label>
                              {t("data.chart.studies.styles.width")}
                            </Label>
                            <Select
                              value={String(style.lineWidth)}
                              onValueChange={(value) =>
                                updateStyle({
                                  lineWidth: Number(value) as 1 | 2 | 3 | 4,
                                })
                              }
                            >
                              <SelectTrigger
                                aria-label={t(
                                  "data.chart.studies.styles.width",
                                )}
                              >
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                {LINE_WIDTHS.map((width) => (
                                  <SelectItem key={width} value={String(width)}>
                                    {width}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          </div>
                          {output.kind === "histogram" ? (
                            <>
                              <div className="space-y-1.5">
                                <Label>
                                  {t("data.chart.studies.styles.positive")}
                                </Label>
                                <Input
                                  type="color"
                                  value={style.positiveColor ?? "#73c991"}
                                  aria-label={t(
                                    "data.chart.studies.styles.positive",
                                  )}
                                  onChange={(event) =>
                                    updateStyle({
                                      positiveColor: event.target.value,
                                    })
                                  }
                                  className="p-1"
                                />
                              </div>
                              <div className="space-y-1.5">
                                <Label>
                                  {t("data.chart.studies.styles.negative")}
                                </Label>
                                <Input
                                  type="color"
                                  value={style.negativeColor ?? "#f85149"}
                                  aria-label={t(
                                    "data.chart.studies.styles.negative",
                                  )}
                                  onChange={(event) =>
                                    updateStyle({
                                      negativeColor: event.target.value,
                                    })
                                  }
                                  className="p-1"
                                />
                              </div>
                            </>
                          ) : null}
                        </div>
                      </div>
                    );
                  })}
                </div>
                {invalid ? (
                  <div className="text-xs text-destructive">
                    {separateLimitReached
                      ? t("data.chart.studies.dialog.paneLimit")
                      : totalLimitReached
                        ? t("data.chart.studies.dialog.totalLimit")
                        : t("data.chart.studies.dialog.invalidParams")}
                  </div>
                ) : null}
              </div>
            ) : (
              <div className="grid h-full place-items-center text-xs text-muted-foreground">
                {t("data.chart.studies.dialog.select")}
              </div>
            )}
          </div>
        </div>
        <DialogFooter className="border-t border-border/60 px-5 py-3">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t("data.chart.studies.actions.cancel")}
          </Button>
          <Button disabled={!definition} onClick={save}>
            {editTargetId
              ? t("data.chart.studies.actions.save")
              : t("data.chart.studies.actions.add")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
