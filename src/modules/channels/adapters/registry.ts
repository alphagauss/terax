/** 平台注册表是服务唯一的平台选择入口，登录与凭据格式由各平台模块拥有。 */
import type {
  ChannelConnection,
  ChannelSnapshot,
} from "@/modules/channels/types";
import { ChannelError } from "@/modules/channels/types";
import { prepareChannelWorkspace } from "@/modules/channels/workspace";

type LoginState = NonNullable<ChannelSnapshot["login"]>["state"];
export type ChannelLogin = {
  qrContent: string;
  poll: (code?: string) => Promise<{
    state: LoginState;
    authorization?: { accountId: string; save: () => Promise<void> };
  }>;
};

const adapters = {
  weixin: {
    async create(connection: ChannelConnection) {
      const { loadWeixinCredentials, WeixinAdapter } = await import(
        "@/modules/channels/adapters/weixin"
      );
      const credentials = await loadWeixinCredentials(connection.id);
      if (credentials.userId !== connection.accountId)
        throw new ChannelError("account-mismatch");
      return new WeixinAdapter(credentials, connection.id, {
        root: await prepareChannelWorkspace(connection),
        ownerSessionId: connection.id,
        permissionMode: "full-access",
      });
    },
    async login(id: string, signal: AbortSignal): Promise<ChannelLogin> {
      const { beginWeixinLogin, saveWeixinCredentials } = await import(
        "@/modules/channels/adapters/weixin"
      );
      const login = await beginWeixinLogin(id, signal);
      return {
        qrContent: login.qrContent,
        async poll(code) {
          const result = await login.poll(code);
          const credentials = result.credentials;
          return {
            state: result.state,
            authorization: credentials
              ? {
                  accountId: credentials.userId,
                  save: () => saveWeixinCredentials(id, credentials),
                }
              : undefined,
          };
        },
      };
    },
    async removeCredentials(id: string) {
      return (
        await import("@/modules/channels/adapters/weixin")
      ).deleteWeixinCredentials(id);
    },
  },
};

export function channelPlatform(kind: ChannelConnection["kind"]) {
  return adapters[kind];
}
