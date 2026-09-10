/** 复用模型定义呈现会话与补全的参数选择，不解释参数的业务含义。 */
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/controls/select";
import type {
  ModelParameter,
  ParameterSelections,
} from "@/modules/ai/lib/modelParameters";
import { selectedParameterOption } from "@/modules/ai/lib/modelParameters";

export function ModelParameterFields({
  parameters,
  selections,
  onChange,
  disabled = false,
  compact = false,
}: {
  parameters: readonly ModelParameter[];
  selections: ParameterSelections;
  onChange: (value: ParameterSelections) => void;
  disabled?: boolean;
  compact?: boolean;
}) {
  return (
    <div
      className={compact ? "flex flex-col gap-2" : "flex flex-col gap-field"}
    >
      {parameters.map((p) => {
        const value = selectedParameterOption(p, selections)?.id ?? "";
        const selectOption = (id: string) =>
          onChange({ ...selections, [p.id]: id });
        return (
          <div
            key={p.id}
            className="grid min-w-0 grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)] items-center gap-3"
          >
            <span className="min-w-0 flex-1 truncate text-xs">{p.label}</span>
            <Select
              disabled={disabled}
              value={value}
              onValueChange={selectOption}
            >
              <SelectTrigger
                aria-label={p.label}
                size={compact ? "sm" : "default"}
                className="w-full"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {p.options.map((o) => (
                  <SelectItem
                    key={o.id}
                    value={o.id}
                    // 同值选择不会触发 Radix 的 onValueChange，但主动选择默认值也要形成覆盖。
                    onPointerUp={() => {
                      if (value === o.id) selectOption(o.id);
                    }}
                    onKeyDown={(event) => {
                      if (
                        value === o.id &&
                        (event.key === "Enter" || event.key === " ")
                      )
                        selectOption(o.id);
                    }}
                  >
                    {o.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        );
      })}
    </div>
  );
}
