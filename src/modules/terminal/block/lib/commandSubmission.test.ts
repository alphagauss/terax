import { expect, it } from "vitest";
import { commandSubmission } from "./commandSubmission";

it("PowerShell 完整传输多行、中文、引号和超过 256 字符的命令", () => {
  const command = `Write-Output '你好'\n# ${"x".repeat(300)}\nWrite-Output 'second'`;
  const data = commandSubmission(command, true, false);
  if (data === null) throw new Error("缺少 PowerShell 输入载荷");
  expect(data.endsWith("\x1b[24;5~")).toBe(true);
  const encoded = data.slice(7, -7);
  expect(
    new TextDecoder().decode(
      Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0)),
    ),
  ).toBe(command);
  expect(data).not.toMatch(/[\r\n]/);
});

it("仅在协商能力后发送 bracketed paste，并统一终端换行", () => {
  expect(commandSubmission("echo one\r\necho two", false, true)).toBe(
    "\x1b[200~echo one\recho two\x1b[201~\r",
  );
  expect(commandSubmission("echo one\necho two", false, false)).toBeNull();
  expect(commandSubmission("echo ok", false, false)).toBe("echo ok\r");
  expect(commandSubmission("echo \x1b[201~bad", false, true)).toBeNull();
});
