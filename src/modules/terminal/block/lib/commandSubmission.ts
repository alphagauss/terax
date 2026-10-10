/** 按 Shell 实际协商的输入能力提交命令，拒绝把多行拆成多个独立执行。 */
export function commandSubmission(
  text: string,
  powershellInput: boolean,
  bracketedPaste: boolean,
): string | null {
  if (powershellInput) {
    const bytes = new TextEncoder().encode(text);
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    // 专用 PSReadLine 按键先恢复全文，再一次性 AcceptLine；不修改剪贴板。
    return `#terax:${btoa(binary)}\x1b[24;5~`;
  }
  const normalized = text.replace(/\r\n?/g, "\n");
  if (/[\x00-\x08\x0b-\x1f\x7f]/.test(normalized)) return null;
  if (normalized.includes("\n") && !bracketedPaste) return null;
  const input = normalized.replace(/\n/g, "\r");
  return bracketedPaste ? `\x1b[200~${input}\x1b[201~\r` : `${input}\r`;
}
