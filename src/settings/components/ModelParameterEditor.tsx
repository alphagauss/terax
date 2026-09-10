/** 编辑模型的枚举参数定义；请求路径使用官方 API 命名，保存时校验值类型。 */
import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/controls/button";
import { Input } from "@/components/controls/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/controls/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/controls/dialog";
import { Switch } from "@/components/ui/switch";
import {
  type ModelRef,
  modelRefKey,
  resolveProviderInstance,
} from "@/modules/ai/config";
import {
  type ModelParameter,
  STANDARD_PARAMETER_PATHS,
  parseParameterValue,
  selectedParameterOption,
  validateModelParameters,
} from "@/modules/ai/lib/modelParameters";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { setModelParameters } from "@/modules/settings/store";

type Draft = Omit<ModelParameter, "options"> & {
  options: { id: string; label: string; value: string; omit?: boolean }[];
};
const EMPTY: ModelParameter[] = [];

export function ModelParameterEditor({ model }: { model: ModelRef }) {
  const { t } = useTranslation("settings");
  const key = modelRefKey(model);
  const fieldId = useId();
  const parameters = usePreferencesStore(
    (s) => s.modelParameters[key] ?? EMPTY,
  );
  const customProviders = usePreferencesStore((s) => s.customProviders);
  const adapter = resolveProviderInstance(model.providerId, { customProviders })
    .runtime.adapter;
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const text = (key: string) => t(`models.requestParameters.${key}`);
  const update = (patch: Partial<Draft>) =>
    setDraft((current) => (current ? { ...current, ...patch } : current));
  const save = async (next: ModelParameter[]) => {
    const invalid = validateModelParameters(next, adapter);
    if (invalid) {
      setError(text(invalid));
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await setModelParameters(model, next);
      setDraft(null);
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  };
  const edit = (p?: ModelParameter) => {
    setError(null);
    const firstOptionId = crypto.randomUUID();
    setDraft(
      p
        ? {
            ...p,
            defaultOption: selectedParameterOption(p)?.id ?? null,
            options: p.options.map((o) => ({
              ...o,
              value: o.omit ? "" : String(o.value),
            })),
          }
        : {
            id: crypto.randomUUID(),
            label: "",
            target: "provider",
            path: "",
            valueType: "string",
            options: [{ id: firstOptionId, label: "", value: "" }],
            defaultOption: firstOptionId,
            showInSummary: true,
          },
    );
  };
  const commitDraft = () => {
    if (!draft) return;
    if (
      draft.options.some(
        (o) =>
          !o.omit &&
          ((draft.valueType === "number" && !o.value.trim()) ||
            (draft.valueType === "boolean" &&
              !["true", "false"].includes(o.value))),
      )
    ) {
      setError(text("invalidOptions"));
      return;
    }
    const parsed: ModelParameter = {
      ...draft,
      label: draft.label.trim(),
      path: draft.path.trim(),
      options: draft.options.map((o) => ({
        ...o,
        label: o.label.trim(),
        value: o.omit ? null : parseParameterValue(draft.valueType, o.value),
      })),
    };
    const current = usePreferencesStore.getState().modelParameters[key] ?? [];
    void save(
      current.some((p) => p.id === parsed.id)
        ? current.map((p) => (p.id === parsed.id ? parsed : p))
        : [...current, parsed],
    );
  };
  return (
    <div className="flex flex-col gap-field">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium">{text("title")}</span>
        <Button
          size="sm"
          variant="outline"
          disabled={saving}
          onClick={() => edit()}
        >
          {text("add")}
        </Button>
      </div>
      {!parameters.length && (
        <p className="text-xs text-muted-foreground">{text("empty")}</p>
      )}
      {parameters.length > 0 && (
        <div className="divide-y divide-border/60">
          {parameters.map((p) => (
            <div
              key={p.id}
              className="flex items-center justify-between gap-3 py-2 last:pb-0"
            >
              <div className="min-w-0">
                <p className="truncate text-xs">{p.label}</p>
                <p className="truncate font-mono text-[11px] text-muted-foreground">
                  {p.path}
                </p>
                <p className="text-[11px] text-muted-foreground">
                  {text("default")}: {selectedParameterOption(p)?.label}
                </p>
              </div>
              <div className="flex shrink-0 gap-1">
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={saving}
                  onClick={() => edit(p)}
                >
                  {text("edit")}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={saving}
                  onClick={() =>
                    void save(parameters.filter((item) => item.id !== p.id))
                  }
                >
                  {text("delete")}
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}
      {error && !draft && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
      <Dialog
        open={draft !== null}
        onOpenChange={(open) => {
          if (!open && !saving) setDraft(null);
        }}
      >
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>{text("editTitle")}</DialogTitle>
          </DialogHeader>
          {draft && (
            <div className="flex flex-col gap-field">
              <label
                htmlFor={`${fieldId}-name`}
                className="flex flex-col gap-1 text-xs"
              >
                {text("name")}
                <Input
                  id={`${fieldId}-name`}
                  value={draft.label}
                  onChange={(e) => update({ label: e.target.value })}
                />
              </label>
              <div className="flex flex-wrap gap-3">
                <div className="flex min-w-40 flex-1 flex-col gap-1">
                  <span className="text-xs">{text("target")}</span>
                  <Select
                    value={draft.target}
                    onValueChange={(value) =>
                      update({
                        target: value as ModelParameter["target"],
                        ...(value === "standard"
                          ? {
                              valueType: "number" as const,
                              path: "temperature",
                            }
                          : {}),
                      })
                    }
                  >
                    <SelectTrigger aria-label={text("target")}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="standard">
                        {text("standard")}
                      </SelectItem>
                      <SelectItem value="provider">
                        {text("provider")}
                      </SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="flex min-w-40 flex-1 flex-col gap-1">
                  <span className="text-xs">{text("type")}</span>
                  <Select
                    disabled={draft.target === "standard"}
                    value={draft.valueType}
                    onValueChange={(value) =>
                      update({
                        valueType: value as ModelParameter["valueType"],
                        options: draft.options.map((o) => ({
                          ...o,
                          value:
                            value === "boolean"
                              ? o.value === "false"
                                ? "false"
                                : "true"
                              : o.value,
                        })),
                      })
                    }
                  >
                    <SelectTrigger aria-label={text("type")}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {["string", "number", "boolean"].map((type) => (
                        <SelectItem key={type} value={type}>
                          {text(type)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <p className="text-xs text-muted-foreground">
                {text(
                  draft.target === "standard" ? "standardHelp" : "providerHelp",
                )}
              </p>
              {draft.target === "standard" ? (
                <Select
                  value={draft.path}
                  onValueChange={(path) => update({ path })}
                >
                  <SelectTrigger aria-label={text("path")}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {STANDARD_PARAMETER_PATHS.map((path) => (
                      <SelectItem key={path} value={path}>
                        {path}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : (
                <label
                  htmlFor={`${fieldId}-path`}
                  className="flex flex-col gap-1 text-xs"
                >
                  {text("path")}
                  <Input
                    className="font-mono"
                    id={`${fieldId}-path`}
                    value={draft.path}
                    onChange={(e) => update({ path: e.target.value })}
                    placeholder="chat_template_kwargs.enable_thinking"
                  />
                </label>
              )}
              {draft.target === "provider" && (
                <p className="text-xs text-muted-foreground">
                  {text("pathHelp")}
                </p>
              )}
              <div className="flex items-center justify-between">
                <span className="text-xs">{text("options")}</span>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    const option = {
                      id: crypto.randomUUID(),
                      label: "",
                      value: draft.valueType === "boolean" ? "true" : "",
                    };
                    update({
                      options: [...draft.options, option],
                      defaultOption: draft.defaultOption ?? option.id,
                    });
                  }}
                >
                  {text("addOption")}
                </Button>
              </div>
              <div className="grid grid-cols-[minmax(0,1fr)_6rem_minmax(0,1fr)_1.75rem] gap-2 text-xs text-muted-foreground">
                <span>{text("optionLabel")}</span>
                <span>{text("sendMode")}</span>
                <span>{text("optionValue")}</span>
                <span />
              </div>
              {draft.options.map((o) => (
                <div
                  className="grid grid-cols-[minmax(0,1fr)_6rem_minmax(0,1fr)_1.75rem] items-center gap-2"
                  key={o.id}
                >
                  <Input
                    className="min-w-0"
                    aria-label={text("optionLabel")}
                    placeholder={text("optionLabel")}
                    value={o.label}
                    onChange={(e) =>
                      update({
                        options: draft.options.map((item) =>
                          item.id === o.id
                            ? { ...item, label: e.target.value }
                            : item,
                        ),
                      })
                    }
                  />
                  <Select
                    value={o.omit ? "omit" : "value"}
                    onValueChange={(mode) =>
                      update({
                        options: draft.options.map((item) =>
                          item.id === o.id
                            ? {
                                ...item,
                                omit: mode === "omit",
                                label:
                                  mode === "omit" && !item.label.trim()
                                    ? text("server")
                                    : item.label,
                                value:
                                  mode === "value" &&
                                  draft.valueType === "boolean" &&
                                  !["true", "false"].includes(item.value)
                                    ? "true"
                                    : item.value,
                              }
                            : item,
                        ),
                      })
                    }
                  >
                    <SelectTrigger
                      aria-label={text("sendMode")}
                      className="w-full"
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="value">{text("sendValue")}</SelectItem>
                      <SelectItem
                        value="omit"
                        disabled={draft.options.some(
                          (item) => item.id !== o.id && item.omit,
                        )}
                      >
                        {text("server")}
                      </SelectItem>
                    </SelectContent>
                  </Select>
                  {o.omit ? (
                    <span />
                  ) : draft.valueType === "boolean" ? (
                    <Select
                      value={o.value === "false" ? "false" : "true"}
                      onValueChange={(value) =>
                        update({
                          options: draft.options.map((item) =>
                            item.id === o.id ? { ...item, value } : item,
                          ),
                        })
                      }
                    >
                      <SelectTrigger
                        aria-label={text("optionValue")}
                        className="w-full"
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="true">true</SelectItem>
                        <SelectItem value="false">false</SelectItem>
                      </SelectContent>
                    </Select>
                  ) : (
                    <Input
                      className="min-w-0"
                      aria-label={text("optionValue")}
                      placeholder={text("optionValue")}
                      value={o.value}
                      onChange={(e) =>
                        update({
                          options: draft.options.map((item) =>
                            item.id === o.id
                              ? { ...item, value: e.target.value }
                              : item,
                          ),
                        })
                      }
                    />
                  )}
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    aria-label={text("deleteOption")}
                    onClick={() =>
                      update({
                        options: draft.options.filter(
                          (item) => item.id !== o.id,
                        ),
                        defaultOption:
                          draft.defaultOption === o.id
                            ? (draft.options.find((item) => item.id !== o.id)
                                ?.id ?? null)
                            : draft.defaultOption,
                      })
                    }
                  >
                    ×
                  </Button>
                </div>
              ))}
              {draft.valueType === "string" && (
                <p className="text-xs text-muted-foreground">
                  {text("nullHelp")}
                </p>
              )}
              <div className="flex items-center justify-between gap-3">
                <span className="text-xs">{text("default")}</span>
                <Select
                  value={draft.defaultOption ?? ""}
                  onValueChange={(value) => update({ defaultOption: value })}
                >
                  <SelectTrigger
                    aria-label={text("default")}
                    className="max-w-64"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {draft.options.map((o, index) => (
                      <SelectItem value={o.id} key={o.id}>
                        {o.label || `${text("optionLabel")} ${index + 1}`}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <label
                htmlFor={`${fieldId}-summary`}
                className="flex items-center justify-between gap-3 text-xs"
              >
                {text("summary")}
                <Switch
                  id={`${fieldId}-summary`}
                  checked={draft.showInSummary}
                  onCheckedChange={(showInSummary) => update({ showInSummary })}
                />
              </label>
              {error && (
                <p role="alert" className="text-xs text-destructive">
                  {error}
                </p>
              )}
            </div>
          )}
          <DialogFooter>
            <Button
              variant="ghost"
              disabled={saving}
              onClick={() => setDraft(null)}
            >
              {text("cancel")}
            </Button>
            <Button disabled={saving} onClick={commitDraft}>
              {text("save")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
