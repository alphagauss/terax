/** 会话参数只影响下一轮；面板复用模型定义，运行中的快照保持不变。 */

import { reportError } from "@/lib/errors";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/controls/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { ModelParameterFields } from "@/modules/ai/components/ModelParameterFields";
import { modelRefKey, modelRefsEqual } from "@/modules/ai/config";
import {
  resolveModelParameters,
  selectedParameterOption,
} from "@/modules/ai/lib/modelParameters";
import { useComposer } from "@/modules/ai/lib/composer";
import { parseExternalAgentBinding } from "@/modules/ai/external-agents/runtime";
import { sessionMetadata, useChatStore } from "@/modules/ai/store/chatStore";
import { openSettingsWindow } from "@/modules/settings/openSettingsWindow";
import { usePreferencesStore } from "@/modules/settings/preferences";

export function ModelParametersPopover() {
  const { t } = useTranslation("settings");
  const { isBusy, readOnly } = useComposer();
  const model = useChatStore((s) => s.selectedModel);
  const sessionId = useChatStore((s) => s.activeSessionId);
  const selectionsBySession = useChatStore(
    (s) => s.parameterSelectionsBySession,
  );
  const snapshots = useChatStore((s) => s.modelSnapshotsBySession);
  const externalDraft = useChatStore((s) => s.draftExternalAgentId);
  const draftId = useChatStore((s) => s.draftSessionId);
  const channel = useChatStore(
    (s) => s.sessions.find((item) => item.id === s.activeSessionId)?.channelId,
  );
  const definitions = usePreferencesStore((s) => s.modelParameters);
  if (
    !model ||
    !sessionId ||
    channel ||
    (sessionId === draftId && externalDraft) ||
    parseExternalAgentBinding(sessionMetadata.get(sessionId))
  )
    return null;
  const key = modelRefKey(model);
  const parameters = definitions[key] ?? [];
  const selections = selectionsBySession[sessionId]?.[key] ?? {};
  const snapshot = snapshots[sessionId];
  const changed =
    isBusy &&
    snapshot &&
    (!modelRefsEqual(model, snapshot.model) ||
      JSON.stringify(resolveModelParameters(parameters, selections)) !==
        JSON.stringify(snapshot.parameters));
  const text = (key: string) => t(`models.requestParameters.${key}`);
  const summary = parameters
    .filter((p) => p.showInSummary)
    .map(
      (p) =>
        `${p.label} · ${selectedParameterOption(p, selections)?.label ?? ""}`,
    );
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          disabled={readOnly}
          size="sm"
          variant="ghost"
          className="my-1 min-w-0 max-w-44 shrink"
          aria-label={text("sessionTitle")}
        >
          <span className="truncate">
            {summary.slice(0, 2).join(" / ") || text("title")}
            {summary.length > 2 ? ` +${summary.length - 2}` : ""}
            {changed ? ` · ${text("next")}` : ""}
          </span>
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className="w-80 max-w-[calc(100vw-2rem)] rounded-lg p-3"
      >
        <div className="flex flex-col gap-2.5">
          <p className="border-b border-border pb-2 text-sm font-medium">
            {text("sessionTitle")}
          </p>
          {parameters.length ? (
            <ModelParameterFields
              parameters={parameters}
              selections={selections}
              compact
              onChange={(next) => {
                void useChatStore
                  .getState()
                  .setParameterSelections(sessionId, model, next)
                  .catch((e) =>
                    reportError(t("common:errors.saveFailed"), { error: e }),
                  );
              }}
            />
          ) : (
            <p className="text-xs text-muted-foreground">{text("empty")}</p>
          )}
          {isBusy && (
            <p role="status" className="text-xs text-muted-foreground">
              {text("nextTurn")}
            </p>
          )}
          <div className="flex justify-between gap-2 border-t border-border pt-2">
            <Button
              size="xs"
              variant="ghost"
              disabled={!Object.keys(selections).length}
              onClick={() =>
                void useChatStore
                  .getState()
                  .setParameterSelections(sessionId, model, {})
                  .catch((e) =>
                    reportError(t("common:errors.saveFailed"), { error: e }),
                  )
              }
            >
              {text("reset")}
            </Button>
            <Button
              size="xs"
              variant="ghost"
              onClick={() => void openSettingsWindow("models")}
            >
              {text("configure")}
            </Button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
