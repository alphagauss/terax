/** 在单次模型请求边界降级明确不支持的视觉输入，不重放工具或修改会话原件。 */
import { APICallError, wrapLanguageModel } from "ai";

type Model = Parameters<typeof wrapLanguageModel>[0]["model"];
type CallOptions = Parameters<
  ReturnType<typeof wrapLanguageModel>["doStream"]
>[0];

/** 只识别明确的视觉能力拒绝，图片损坏、格式错误和普通请求失败不降级。 */
function rejectsVisualInput(error: unknown): boolean {
  if (
    !APICallError.isInstance(error) ||
    error.isRetryable ||
    ![400, 415, 422].includes(error.statusCode ?? 0)
  )
    return false;
  const detail = `${error.message} ${error.responseBody ?? ""}`;
  return (
    /(?:does not|doesn't) support (?:image inputs?|images|vision|multimodal)\b(?![\w/]| (?:format|type))/i.test(
      detail,
    ) ||
    /(?:image inputs?|images|vision|multimodal)(?: is| are)? (?:not supported|unsupported)\b/i.test(
      detail,
    ) ||
    /(?:unsupported|not supported) (?:image inputs?|vision|multimodal)\b|only supports text\b/i.test(
      detail,
    )
  );
}

function withoutImages(
  prompt: CallOptions["prompt"],
): CallOptions["prompt"] | null {
  let found = false;
  const messages = prompt.map((message) =>
    message.role !== "user"
      ? message
      : {
          ...message,
          content: message.content.map((part) => {
            if (part.type !== "file" || !part.mediaType.startsWith("image/"))
              return part;
            found = true;
            return {
              type: "text" as const,
              text: "[Image not delivered to model: visual input is unsupported. Do not infer its contents.]",
            };
          }),
        },
  );
  return found ? messages : null;
}

/** 降级状态只属于本次创建的模型实例；请求流建立后不做恢复或重放。 */
export function withVisualInputFallback(model: Model) {
  let textOnly = false;
  return wrapLanguageModel({
    model,
    middleware: {
      wrapStream: async ({ model, params }) => {
        if (textOnly)
          return model.doStream({
            ...params,
            prompt: withoutImages(params.prompt) ?? params.prompt,
          });
        try {
          return await model.doStream(params);
        } catch (error) {
          if (!rejectsVisualInput(error)) throw error;
          const prompt = withoutImages(params.prompt);
          if (!prompt) throw error;
          const result = await model.doStream({ ...params, prompt });
          textOnly = true;
          return result;
        }
      },
    },
  });
}
