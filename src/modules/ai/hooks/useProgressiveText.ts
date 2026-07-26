/**
 * 本文件把流式正文连接到短生命周期的渐进可见文本存储。
 * 非流式正文直接返回最终文本，不创建订阅或保留额外字符串副本。
 */

import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useSyncExternalStore,
} from "react";
import { progressiveTextStore } from "../lib/progressiveText";

/**
 * 返回适合当前帧展示的流式文本。
 *
 * 首个片段立即显示，后续突发内容按积压量追赶；流式结束时调用方直接使用
 * `text`，并在布局提交后清理对应存储。
 */
export function useProgressiveText(text: string, streaming: boolean): string {
  const streamId = useId();
  const subscribe = useCallback(
    (listener: () => void) =>
      streaming ? progressiveTextStore.subscribe(streamId, listener) : () => {},
    [streamId, streaming],
  );
  const getSnapshot = useCallback(() => {
    if (!streaming || !progressiveTextStore.hasTarget(streamId)) {
      return text;
    }
    return progressiveTextStore.getVisibleText(streamId);
  }, [streamId, streaming, text]);
  const visibleText = useSyncExternalStore(subscribe, getSnapshot, () => text);

  useLayoutEffect(() => {
    if (streaming) {
      progressiveTextStore.setTarget(streamId, text);
      return;
    }
    progressiveTextStore.clear(streamId);
  }, [streamId, streaming, text]);

  useEffect(
    () => () => {
      progressiveTextStore.clear(streamId);
    },
    [streamId],
  );

  return streaming ? visibleText : text;
}
