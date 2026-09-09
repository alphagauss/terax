/** 截图独立入口只加载本功能翻译，语言始终由原生读取的 language 设置决定。 */
import en from "@/i18n/locales/en/screenshot.json";
import zhCN from "@/i18n/locales/zh-CN/screenshot.json";

export function screenshotMessages(language: string) {
  return language === "zh-CN" ? zhCN : en;
}

export function screenshotError(error: unknown, language: string): string {
  const messages = screenshotMessages(language);
  const code = String(error).split(":")[0];
  return (
    messages.errors[code as keyof typeof messages.errors] ??
    messages.errors.generic
  );
}
