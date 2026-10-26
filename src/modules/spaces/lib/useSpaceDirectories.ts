/** 统一当前环境中的 Space 目录选择、授权与创建，异步操作始终绑定发起时的目标。 */
import { native } from "@/modules/ai/lib/native";
import { documentEventPath, documentPathIdentity } from "@/lib/pathIdentity";
import { DEFAULT_SPACE_ID } from "@/modules/workbench/types";
import { currentWorkspaceEnv } from "@/modules/workspace";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { useCallback, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { reportError } from "@/lib/errors";
import { normalizeSpaceRoot, useSpaces } from "./useSpaces";

/** 目录校验成功后才授权；WSL 保留发行版路径，不使用授权接口返回的宿主路径。 */
export async function prepareSpaceDirectory(path: string): Promise<string> {
  const workspace = currentWorkspaceEnv();
  const canonical = documentEventPath(
    workspace,
    await native.canonicalize(path),
  );
  const stat = await invoke<{ kind: string }>("fs_stat", {
    path: canonical,
    workspace,
  });
  if (stat.kind !== "dir") throw new Error("not-directory");
  await native.workspaceAuthorize(canonical);
  return normalizeSpaceRoot(canonical);
}

export function useSpaceDirectories(
  createWorkbench: (spaceId: string) => void,
  ensureWorkspaceReady: () => Promise<string | null>,
) {
  const { t } = useTranslation("spaces");
  const [request, setRequest] = useState<{ spaceId: string | null } | null>(
    null,
  );
  const requestRef = useRef(request);
  requestRef.current = request;

  const createSpace = useCallback(
    (root: string | null = null) => {
      const store = useSpaces.getState();
      const space = store.create({
        root,
        name: t("untitledSpace", { number: store.spaces.length + 1 }),
      });
      createWorkbench(space.id);
      store.setActive(space.id);
      return space.id;
    },
    [createWorkbench, t],
  );

  const openDirectory = useCallback(
    async (
      path: string,
      spaceId: string | null,
      isCurrent: () => boolean = () => true,
    ): Promise<boolean> => {
      try {
        if (!(await ensureWorkspaceReady()) || !isCurrent()) return false;
        const root = await prepareSpaceDirectory(path);
        if (!isCurrent()) return false;
        if (spaceId && spaceId !== DEFAULT_SPACE_ID) {
          if (
            !useSpaces.getState().spaces.some((space) => space.id === spaceId)
          )
            return false;
          useSpaces.getState().setRoot(spaceId, root);
        } else createSpace(root);
        return true;
      } catch (error) {
        if (isCurrent())
          reportError(t("directoryFailed"), {
            description:
              error instanceof Error && error.message === "not-directory"
                ? t("directoryInvalid")
                : String(error),
          });
        return false;
      }
    },
    [createSpace, ensureWorkspaceReady, t],
  );

  /** 系统打开目录只复用已锁定的项目 Space，不改变解锁 Space 的跟随状态。 */
  const openDirectories = useCallback(
    async (paths: string[]) => {
      for (const path of paths) {
        try {
          const root = await prepareSpaceDirectory(path);
          const store = useSpaces.getState();
          const workspace = currentWorkspaceEnv();
          const identity = documentPathIdentity(workspace, root);
          const matches = store.spaces.filter(
            (space) =>
              space.id !== DEFAULT_SPACE_ID &&
              space.rootLocked &&
              space.root &&
              documentPathIdentity(
                workspace,
                normalizeSpaceRoot(space.root),
              ) === identity,
          );
          const existing =
            matches.find((space) => space.id === store.activeId) ?? matches[0];
          if (existing) store.setActive(existing.id);
          else createSpace(root);
        } catch (error) {
          reportError(t("directoryFailed"), { error });
        }
      }
    },
    [createSpace, t],
  );

  const chooseDirectory = useCallback(
    async (spaceId: string | null) => {
      if (currentWorkspaceEnv().kind !== "local") {
        const next = { spaceId };
        requestRef.current = next;
        setRequest(next);
        return;
      }
      try {
        const selected = await open({
          directory: true,
          multiple: false,
          title: t(
            spaceId && spaceId !== DEFAULT_SPACE_ID
              ? "changeDirectory"
              : "newFromDirectory",
          ),
        });
        if (typeof selected === "string")
          await openDirectory(selected.replace(/\\/g, "/"), spaceId);
      } catch (error) {
        reportError(t("directoryFailed"), { error });
      }
    },
    [openDirectory, t],
  );

  const closeDialog = useCallback(() => {
    requestRef.current = null;
    setRequest(null);
  }, []);

  const submitDialog = useCallback(
    async (path: string) => {
      const current = requestRef.current;
      if (!current) return;
      if (
        await openDirectory(
          path,
          current.spaceId,
          () => requestRef.current === current,
        )
      )
        closeDialog();
    },
    [closeDialog, openDirectory],
  );

  return {
    createSpace,
    openDirectory,
    openDirectories,
    chooseDirectory,
    request,
    closeDialog,
    submitDialog,
  };
}
