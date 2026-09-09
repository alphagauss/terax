/** 截图覆盖窗口的轻量启动入口，不挂载 Workspace 运行时。 */
import "@/styles/globals.css";
import "./screenshot.css";
import { ScreenshotEditor } from "@/modules/screenshots/ScreenshotEditor";
import { createRoot } from "react-dom/client";

createRoot(document.getElementById("screenshot-root") as HTMLElement).render(
  <ScreenshotEditor />,
);
