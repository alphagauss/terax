/** 网络工具的供应商中立协议；结果只包含可供模型引用的网页事实。 */
export type WebResult = {
  title: string;
  url: string;
  content: string;
  truncated: boolean;
};

export type WebClient = {
  search(
    input: { query: string; count: number },
    signal?: AbortSignal,
  ): Promise<WebResult[]>;
  fetch(url: string, signal?: AbortSignal): Promise<WebResult>;
};

export type WebServices = Partial<WebClient>;

/** 只允许无凭据的 HTTP 网页地址，供参数及供应商结果共同校验。 */
export function isWebUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      value.length <= 8192 &&
      ["http:", "https:"].includes(url.protocol) &&
      !!url.hostname &&
      !url.username &&
      !url.password
    );
  } catch {
    return false;
  }
}
