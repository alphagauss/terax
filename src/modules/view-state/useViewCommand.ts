/** 用户操作产生的结果只恢复，不因可见性恢复而重放命令。 */

import { useEffect, useRef } from "react";
import { useViewMemory, useViewScopeKey } from "./ViewState";

/** 请求身份只随用户输入或显式重试改变；隐藏时执行清理，切回不重放。 */
export function useViewCommand(
  slot: string,
  requestKey: string,
  active: boolean,
  run: () => undefined | (() => void),
) {
  const scope = `${useViewScopeKey()}\0${slot}`;
  const memory = useViewMemory<string>(`command:${slot}`);
  const attempted = useRef<{ scope: string; key?: string } | null>(null);
  if (attempted.current?.scope !== scope)
    attempted.current = { scope, key: memory.read() };
  const runner = useRef(run);
  runner.current = run;
  useEffect(() => {
    if (!active || attempted.current?.key === requestKey) return;
    attempted.current = { scope, key: requestKey };
    memory.write(requestKey);
    return runner.current();
  }, [scope, requestKey, active, memory.write]);
}
