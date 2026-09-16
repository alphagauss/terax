/** 将补全输入拆为父目录和名称前缀，保留 ~ 交由原生层展开。 */
export function directoryQuery(value: string) {
  if (value === "~") return { parent: "~/", prefix: "" };
  if (!value.startsWith("/") && !value.startsWith("~/")) return null;
  const separator = value.lastIndexOf("/");
  return {
    parent: value.slice(0, separator + 1),
    prefix: value.slice(separator + 1),
  };
}
