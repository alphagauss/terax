/** 截图覆盖窗口独立入口，只加载图片编辑器和公共提示，不挂载 Workspace 运行时。 */
import { Hint, TooltipProvider } from "@/components/controls/tooltip";
import { applyScreenshotTheme } from "@/modules/screenshots/appearance";
import {
  screenshotError,
  screenshotMessages,
} from "@/modules/screenshots/messages";
import {
  SCREENSHOT_EVENT,
  type ScreenshotFrame,
} from "@/modules/screenshots/types";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { type ReactNode, useEffect, useRef, useState } from "react";
import Screenshots from "react-screenshots";

interface LoadedFrame {
  frame: ScreenshotFrame;
  url: string;
}
interface EditorButton {
  label: string;
  className: string;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}

function renderButton({
  label,
  className,
  disabled,
  onClick,
  children,
}: EditorButton) {
  return (
    <Hint content={label}>
      <button
        type="button"
        aria-label={label}
        className={className}
        disabled={disabled}
        onClick={onClick}
      >
        {children}
      </button>
    </Hint>
  );
}

/** 图片通过一次性二进制响应读取，替换和结束会话时立即撤销 Blob URL。 */
export function ScreenshotEditor() {
  const [loaded, setLoaded] = useState<LoadedFrame | null>(null);
  const [size, setSize] = useState({ width: innerWidth, height: innerHeight });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const current = useRef<LoadedFrame | null>(null);
  const exporting = useRef(false);
  const messages = screenshotMessages(loaded?.frame.language ?? "en");

  useEffect(() => {
    let disposed = false;
    let queue = Promise.resolve();
    const release = () => {
      if (current.current) URL.revokeObjectURL(current.current.url);
      current.current = null;
    };
    const refresh = () => {
      queue = queue
        .then(async () => {
          if (disposed) return;
          const frame = await invoke<ScreenshotFrame | null>(
            "screenshot_frame",
          );
          if (disposed || frame?.token === current.current?.frame.token) return;
          release();
          setLoaded(null);
          setError(null);
          if (!frame) return;
          const [bytes] = await Promise.all([
            invoke<ArrayBuffer>("screenshot_image", { token: frame.token }),
            applyScreenshotTheme(),
          ]);
          if (disposed) return;
          const url = URL.createObjectURL(
            new Blob([bytes], { type: "image/png" }),
          );
          current.current = { frame, url };
          document.documentElement.lang = frame.language;
          setSize({ width: innerWidth, height: innerHeight });
          setLoaded(current.current);
        })
        .catch((reason: unknown) => {
          if (!disposed) setError(String(reason));
        });
      return queue;
    };
    const subscription = listen(SCREENSHOT_EVENT, () => {
      void refresh();
    });
    void subscription
      .then(async () => {
        await document.fonts.ready;
        if (disposed) return;
        await refresh();
      })
      .catch((reason: unknown) => {
        if (!disposed) setError(String(reason));
      });
    const resize = () => setSize({ width: innerWidth, height: innerHeight });
    window.addEventListener("resize", resize);
    return () => {
      disposed = true;
      release();
      window.removeEventListener("resize", resize);
      void subscription.then((unlisten) => unlisten());
    };
  }, []);

  async function cancel() {
    const entry = current.current;
    if (!entry || exporting.current) return;
    try {
      await invoke("screenshot_cancel", { token: entry.frame.token });
    } catch (reason) {
      setError(String(reason));
    }
  }

  async function exportImage(action: "copy" | "save", blob: Blob) {
    const entry = current.current;
    if (!entry || exporting.current) return;
    exporting.current = true;
    setBusy(true);
    setError(null);
    try {
      await invoke<boolean>("screenshot_export", await blob.arrayBuffer(), {
        headers: {
          "x-screenshot-token": entry.frame.token,
          "x-screenshot-action": action,
        },
      });
    } catch (reason) {
      setError(String(reason));
    } finally {
      exporting.current = false;
      setBusy(false);
    }
  }

  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (exporting.current) return;
      if (event.key === "Escape") {
        event.preventDefault();
        const entry = current.current;
        if (entry)
          void invoke("screenshot_cancel", { token: entry.frame.token }).catch(
            (reason: unknown) => setError(String(reason)),
          );
      } else if (
        event.key === "Enter" &&
        !(event.target instanceof HTMLTextAreaElement) &&
        !(event.target instanceof HTMLInputElement)
      ) {
        event.preventDefault();
        document
          .querySelector<HTMLButtonElement>(".screenshots-button:has(.icon-ok)")
          ?.click();
      }
    };
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  }, []);

  return (
    <TooltipProvider>
      {loaded && (
        <div className="screenshot-editor" inert={busy}>
          <Screenshots
            key={loaded.frame.token}
            url={loaded.url}
            width={size.width}
            height={size.height}
            lang={messages.editor}
            renderButton={renderButton}
            onReady={() => {
              void document.fonts.ready
                .then(() =>
                  invoke("screenshot_present", { token: loaded.frame.token }),
                )
                .catch((reason: unknown) => setError(String(reason)));
            }}
            onOk={(blob: Blob) => {
              void exportImage("copy", blob);
            }}
            onSave={(blob: Blob) => {
              void exportImage("save", blob);
            }}
            onCancel={() => {
              void cancel();
            }}
            onError={(reason: unknown) => setError(String(reason))}
          />
          <div className="screenshot-hint">{messages.hint}</div>
        </div>
      )}
      {busy && (
        <div role="status" className="screenshot-feedback">
          {messages.processing}
        </div>
      )}
      {error && (
        <div role="alert" className="screenshot-feedback">
          {screenshotError(error, loaded?.frame.language ?? "en")}
          <button type="button" onClick={() => setError(null)}>
            {messages.dismiss}
          </button>
        </div>
      )}
    </TooltipProvider>
  );
}
