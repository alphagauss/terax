/** 本地文件引用链接的共用交互，负责延迟解析、打开和右键文件操作。 */
import { Hint } from "@/components/controls/tooltip";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuTrigger,
} from "@/components/menu/context-menu";
import {
  resolveFileReference,
  type FileTarget,
} from "@/modules/file-actions/actions";
import { FileActionItems } from "@/modules/file-actions/FileActionItems";
import type { FileReference } from "@/modules/file-actions/references";
import { useState, type ComponentPropsWithoutRef } from "react";
import { useTranslation } from "react-i18next";
import { reportError } from "@/lib/errors";

type Props = Omit<ComponentPropsWithoutRef<"a">, "href"> & {
  href: string;
  reference: FileReference;
  onOpen: (path: string, line?: number) => void | Promise<void>;
  onOpenDirectory?: (path: string) => void | Promise<void>;
};

/** 文件状态只在用户操作时读取，避免渲染 Markdown 时批量访问文件系统。 */
export function FileReferenceLink({
  href,
  reference,
  onOpen,
  onOpenDirectory,
  children,
  ...props
}: Props) {
  const [resolved, setResolved] = useState<FileTarget | null>(null);
  const { t } = useTranslation("common");
  const resolve = () => resolveFileReference(reference);

  return (
    <ContextMenu
      onOpenChange={(isOpen) => {
        if (isOpen)
          void resolve()
            .then(setResolved)
            .catch(() => setResolved(null));
      }}
    >
      <ContextMenuTrigger asChild>
        <Hint content={reference.literalPath}>
          <a
            {...props}
            href={href}
            data-streamdown="link"
            onAuxClick={(event) => event.preventDefault()}
            onClick={(event) => {
              event.preventDefault();
              void resolve()
                .then((file) =>
                  file.isDir
                    ? onOpenDirectory?.(file.path)
                    : onOpen(file.path, file.line),
                )
                .catch((error) =>
                  reportError(t("fileActions.failed"), {
                    error,
                  }),
                );
            }}
          >
            {children}
            {reference.line !== undefined && (
              <> {t("fileActions.lineReference", { line: reference.line })}</>
            )}
          </a>
        </Hint>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <FileActionItems
          target={
            resolved ?? {
              path: reference.path,
              line: reference.line,
              isDir: false,
            }
          }
          resolve={resolve}
          onOpen={onOpen}
          onOpenDirectory={onOpenDirectory}
        />
      </ContextMenuContent>
    </ContextMenu>
  );
}
