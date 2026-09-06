/**
 * 本文件实现个人微信 iLink 的扫码授权、HTTP 长轮询和文本回复。
 * 协议参考 nanobot 与腾讯插件；只接受扫码账号本人私聊，令牌始终留在适配器或密钥存储。
 */

import i18n from "@/i18n";
import { createHttpFetch } from "@/lib/http";
import {
  type ChannelAdapter,
  ChannelError,
  type ChannelInbound,
  type ChannelSnapshot,
  channelDelay,
  type ReceiveContext,
} from "@/modules/channels/types";
import { invoke } from "@tauri-apps/api/core";
import { z } from "zod";

const BASE_URL = "https://ilinkai.weixin.qq.com";
const VERSION = "2.4.6";
const BASE_INFO = { channel_version: VERSION, bot_agent: "Terax" };
const SECRET_SERVICE = "app.crynta.terax.channels";
const credentialsSchema = z
  .object({
    token: z.string().min(1).max(8192),
    baseUrl: z.string().max(512),
    botId: z.string().min(1).max(256),
    userId: z.string().min(1).max(256),
  })
  .strict();
export type WeixinCredentials = z.infer<typeof credentialsSchema>;
type Payload = Record<string, unknown>;

/** 平台返回的地址也必须验证，防止授权头被送到任意主机。 */
export function weixinBaseUrl(value: string): string {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    !(
      url.hostname === "ilinkai.weixin.qq.com" ||
      url.hostname.endsWith(".weixin.qq.com")
    ) ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    throw new ChannelError("protocol");
  return url.origin;
}

function record(value: unknown): Payload {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new ChannelError("protocol");
  return value as Payload;
}

function requiredText(value: unknown, max = 8192): string {
  if (typeof value !== "string" || !value || value.length > max)
    throw new ChannelError("protocol");
  return value;
}

/** 执行一条封闭 iLink 请求，错误只暴露类别，不暴露平台原始正文。 */
async function request(
  base: string,
  endpoint: string,
  signal: AbortSignal,
  options: {
    connectionId: string;
    body?: Payload;
    token?: string;
    timeoutMs?: number;
    fetch?: typeof fetch;
  },
): Promise<Payload> {
  const random = crypto.getRandomValues(new Uint32Array(1))[0];
  let response: Response;
  try {
    response = await (
      options.fetch ??
      createHttpFetch({
        networkTarget: { kind: "channel", id: options.connectionId },
        timeoutMs: options.timeoutMs ?? 15_000,
      })
    )(`${weixinBaseUrl(base)}/ilink/bot/${endpoint}`, {
      method: options.body ? "POST" : "GET",
      headers: {
        "Content-Type": "application/json",
        AuthorizationType: "ilink_bot_token",
        "X-WECHAT-UIN": btoa(String(random)),
        "iLink-App-Id": "bot",
        "iLink-App-ClientVersion": String((2 << 16) | (4 << 8) | 6),
        ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
      redirect: "error",
      signal,
    });
  } catch (error) {
    signal.throwIfAborted();
    if (error instanceof ChannelError) throw error;
    throw new ChannelError("network");
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    if (response.status === 401 || response.status === 403)
      throw new ChannelError("auth");
    throw new ChannelError(
      response.status >= 500 || response.status === 429
        ? "network"
        : "protocol",
    );
  }
  let body: string;
  try {
    body = await response.text();
  } catch {
    signal.throwIfAborted();
    throw new ChannelError("network");
  }
  let data: Payload;
  try {
    data = record(JSON.parse(body));
  } catch {
    throw new ChannelError("protocol");
  }
  const errors = [data.ret, data.errcode].filter(
    (code) => typeof code === "number" && code !== 0,
  );
  if (errors.includes(-14)) throw new ChannelError("auth");
  if (errors.includes(-2)) throw new ChannelError("delivery");
  if (errors.length) throw new ChannelError("protocol");
  return data;
}

/** 读取连接自己的凭据，账号之间不能共用 keychain 条目。 */
export async function loadWeixinCredentials(
  id: string,
): Promise<WeixinCredentials> {
  const raw = await invoke<string | null>("secrets_get", {
    service: SECRET_SERVICE,
    account: id,
  });
  if (!raw) throw new ChannelError("auth");
  try {
    const value = credentialsSchema.parse(JSON.parse(raw));
    value.baseUrl = weixinBaseUrl(value.baseUrl);
    return value;
  } catch {
    throw new ChannelError("auth");
  }
}

/** 扫码成功后才替换凭据，失败不会覆盖已有有效登录。 */
export async function saveWeixinCredentials(
  id: string,
  credentials: WeixinCredentials,
): Promise<void> {
  await invoke("secrets_set", {
    service: SECRET_SERVICE,
    account: id,
    password: JSON.stringify(credentialsSchema.parse(credentials)),
  });
}

/** 删除连接时回收它自己的账号凭据。 */
export function deleteWeixinCredentials(id: string): Promise<void> {
  return invoke("secrets_delete", { service: SECRET_SERVICE, account: id });
}

export type WeixinLogin = {
  qrContent: string;
  poll: (verifyCode?: string) => Promise<{
    state: NonNullable<ChannelSnapshot["login"]>["state"];
    credentials?: WeixinCredentials;
  }>;
};

/** 创建独立扫码流程；重定向和验证码属于当前流程，不改变已经运行的连接。 */
export async function beginWeixinLogin(
  connectionId: string,
  signal: AbortSignal,
  fetchImpl?: typeof fetch,
): Promise<WeixinLogin> {
  const qr = await request(BASE_URL, "get_bot_qrcode?bot_type=3", signal, {
    connectionId,
    body: { local_token_list: [] },
    fetch: fetchImpl,
  });
  const qrId = requiredText(qr.qrcode);
  const qrContent = requiredText(qr.qrcode_img_content);
  let baseUrl = BASE_URL;
  return {
    qrContent,
    poll: async (verifyCode) => {
      const query = new URLSearchParams({ qrcode: qrId });
      if (verifyCode) {
        if (!/^\d{1,8}$/.test(verifyCode)) throw new ChannelError("protocol");
        query.set("verify_code", verifyCode);
      }
      const data = await request(
        baseUrl,
        `get_qrcode_status?${query}`,
        signal,
        { connectionId, timeoutMs: 45_000, fetch: fetchImpl },
      );
      if (data.status === "confirmed") {
        const credentials = credentialsSchema.parse({
          token: requiredText(data.bot_token),
          baseUrl: weixinBaseUrl(requiredText(data.baseurl, 512)),
          botId: requiredText(data.ilink_bot_id, 256),
          userId: requiredText(data.ilink_user_id, 256),
        });
        return { state: "scanned", credentials };
      }
      if (data.status === "scaned_but_redirect") {
        const host = requiredText(data.redirect_host, 512);
        baseUrl = weixinBaseUrl(
          host.startsWith("https://") ? host : `https://${host}`,
        );
        return { state: "scanned" };
      }
      if (data.status === "need_verifycode") return { state: "verify" };
      if (data.status === "expired" || data.status === "verify_code_blocked")
        return { state: "expired" };
      if (data.status === "scaned") return { state: "scanned" };
      if (data.status === "wait") return { state: "waiting" };
      throw new ChannelError("protocol");
    },
  };
}

/** 只归一化已授权对端的完成态私聊文本，其他消息不会进入 Agent。 */
export function parseWeixinMessage(
  value: unknown,
  userId: string,
): ChannelInbound | null {
  const data = record(value);
  if (
    data.message_type !== 1 ||
    data.from_user_id !== userId ||
    data.group_id ||
    userId.endsWith("@chatroom")
  )
    return null;
  if (data.message_state !== undefined && data.message_state !== 2) return null;
  if (!Array.isArray(data.item_list)) return null;
  const text = data.item_list
    .flatMap((item) => {
      const value = record(item);
      if (value.type !== 1 || !value.text_item) return [];
      const text = record(value.text_item).text;
      if (typeof text !== "string" || text.length > 32000)
        throw new ChannelError("protocol");
      return [text];
    })
    .join("\n");
  if (!text.trim() || text.length > 32000 || !data.context_token) return null;
  const identity = data.message_id ?? data.seq;
  if (
    (typeof identity !== "string" && typeof identity !== "number") ||
    String(identity).length > 128
  )
    return null;
  return {
    id: `${userId}:${identity}:${String(data.create_time_ms ?? "")}`,
    senderId: userId,
    text,
    receivedAt: Date.now(),
    replyContext: requiredText(data.context_token),
  };
}

/** 按 Unicode 字符拆分，避免切断 emoji 或其他代理对。 */
export function splitWeixinText(text: string): string[] {
  const characters = Array.from(text);
  const chunks: string[] = [];
  for (let offset = 0; offset < characters.length; offset += 1800)
    chunks.push(characters.slice(offset, offset + 1800).join(""));
  return chunks;
}

/** 一个账号的独立适配器，接收与回复共用凭据但不共用取消控制器。 */
export class WeixinAdapter implements ChannelAdapter {
  readonly cursorScope: string;

  constructor(
    private readonly credentials: WeixinCredentials,
    private readonly connectionId: string,
    private readonly fetchImpl?: typeof fetch,
  ) {
    this.cursorScope = credentials.botId;
  }

  async receive(context: ReceiveContext): Promise<void> {
    let cursor = context.cursor;
    let timeoutMs = 45_000;
    let failures = 0;
    while (!context.signal.aborted) {
      let data: Payload;
      try {
        data = await this.call(
          "getupdates",
          { get_updates_buf: cursor },
          context.signal,
          timeoutMs,
        );
        failures = 0;
        context.status("online");
      } catch (error) {
        context.signal.throwIfAborted();
        if (!(error instanceof ChannelError) || error.issue !== "network")
          throw error;
        context.status("reconnecting");
        await channelDelay(
          Math.min(30_000, 1000 * 2 ** Math.min(failures++, 5)) +
            Math.random() * 500,
          context.signal,
        );
        continue;
      }
      if (typeof data.longpolling_timeout_ms === "number")
        timeoutMs = Math.min(
          70_000,
          Math.max(15_000, data.longpolling_timeout_ms + 10_000),
        );
      const messages = data.msgs ?? [];
      if (!Array.isArray(messages)) throw new ChannelError("protocol");
      for (const raw of messages) {
        const message = parseWeixinMessage(raw, this.credentials.userId);
        if (message) await context.receive(message);
      }
      const nextCursor = data.get_updates_buf ?? cursor;
      if (typeof nextCursor !== "string" || nextCursor.length > 262144)
        throw new ChannelError("protocol");
      await context.checkpoint(nextCursor);
      cursor = nextCursor;
      if (!messages.length) await channelDelay(250, context.signal);
    }
  }

  async send(
    message: ChannelInbound,
    text: string,
    signal: AbortSignal,
  ): Promise<void> {
    let contextToken = message.replyContext;
    // 长任务先刷新原对端的回复上下文，绝不改用另一个入站消息的目标。
    if (Date.now() - message.receivedAt > 60_000) {
      const config = await this.call(
        "getconfig",
        { ilink_user_id: message.senderId, context_token: contextToken },
        signal,
      );
      if (typeof config.context_token === "string" && config.context_token)
        contextToken = config.context_token;
    }
    const chunks = splitWeixinText(text);
    if (chunks.length > 8) {
      chunks.length = 8;
      chunks[7] = `${Array.from(chunks[7]).slice(0, 1500).join("")}\n${i18n.t("channels:longReply")}`;
    }
    const deliveryId = `terax-${crypto.randomUUID()}`;
    for (let index = 0; index < chunks.length; index++) {
      for (let attempt = 0; ; attempt++) {
        try {
          await this.call(
            "sendmessage",
            {
              msg: {
                from_user_id: "",
                to_user_id: message.senderId,
                client_id: `${deliveryId}-${index}`,
                message_type: 2,
                message_state: 2,
                context_token: contextToken,
                item_list: [{ type: 1, text_item: { text: chunks[index] } }],
              },
            },
            signal,
          );
          break;
        } catch (error) {
          signal.throwIfAborted();
          if (
            !(error instanceof ChannelError) ||
            error.issue !== "network" ||
            attempt >= 2
          )
            throw new ChannelError("delivery");
          await channelDelay(1000 * 2 ** attempt, signal);
        }
      }
    }
  }

  private call(
    endpoint: string,
    body: Payload,
    signal: AbortSignal,
    timeoutMs?: number,
  ): Promise<Payload> {
    return request(this.credentials.baseUrl, endpoint, signal, {
      connectionId: this.connectionId,
      body: { ...body, base_info: BASE_INFO },
      token: this.credentials.token,
      timeoutMs,
      fetch: this.fetchImpl,
    });
  }
}
