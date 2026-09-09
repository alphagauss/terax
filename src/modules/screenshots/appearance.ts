/** 截图会话开始时读取当前主题，不订阅隐藏页面不需要的完整偏好运行时。 */
import { readSharedStore } from "@/lib/sharedStore";
import { applyTheme } from "@/modules/theme/applyTheme";
import { listCustomThemes } from "@/modules/theme/customThemes";
import { getBuiltinTheme, getDefaultTheme } from "@/modules/theme/themes";

export async function applyScreenshotTheme() {
  const settings = await readSharedStore("settings");
  const mode =
    settings.theme === "light" || settings.theme === "dark"
      ? settings.theme
      : settings.theme === "system"
        ? matchMedia("(prefers-color-scheme: dark)").matches
          ? "dark"
          : "light"
        : "dark";
  const id =
    typeof settings.themeId === "string"
      ? settings.themeId
      : getDefaultTheme().id;
  let theme = getBuiltinTheme(id);
  if (!theme)
    theme = (await listCustomThemes()).find((candidate) => candidate.id === id);
  document.documentElement.classList.toggle("dark", mode === "dark");
  applyTheme(theme ?? getDefaultTheme(), mode);
}
