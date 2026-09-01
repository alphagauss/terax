/**
 * 本文件实现 Markdown 渲染与源码模式的锁定开关。
 *
 * 控件复刻上游 Markdown Editor 的双图标滑块与扫光提示，动画只由命令式句柄触发，
 * 避免为一次视觉反馈更新 Markdown 页面状态。
 */

import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import { useTranslation } from "react-i18next";

import "./markdown-view-toggle.css";

type Mode = "rendered" | "raw";

type Props = {
  mode: Mode;
  onChange: (mode: Mode) => void;
  renderedDisabled?: boolean;
  renderedHint?: string;
};

/** Markdown 锁定开关暴露的注意力反馈。 */
export type MarkdownViewToggleHandle = {
  /** 在锁定内容被尝试编辑时，让高光完整扫过开关。 */
  showLockedEditingAttempt: () => void;
};

/**
 * Markdown 渲染与源码模式开关。
 *
 * 渲染模式对应锁定状态，源码模式对应编辑状态；扫光播放期间重复请求不会重启动画。
 */
export const MarkdownViewToggle = forwardRef<MarkdownViewToggleHandle, Props>(
  function MarkdownViewToggle(
    { mode, onChange, renderedDisabled, renderedHint },
    ref,
  ) {
    const { t } = useTranslation("markdown");
    const buttonRef = useRef<HTMLButtonElement>(null);
    const locked = mode === "rendered";
    const disabled = !locked && renderedDisabled;

    useImperativeHandle(
      ref,
      () => ({
        showLockedEditingAttempt: () => {
          const button = buttonRef.current;
          if (!locked || !button || button.classList.contains("shine")) return;
          button.classList.add("shine");
        },
      }),
      [locked],
    );

    useEffect(() => {
      if (!locked) buttonRef.current?.classList.remove("shine");
    }, [locked]);

    const label = disabled
      ? renderedHint
      : locked
        ? t("toggle.lockedLabel")
        : t("toggle.editingLabel");
    const title = disabled
      ? renderedHint
      : locked
        ? t("toggle.lockedTitle")
        : t("toggle.editingTitle");

    return (
      <button
        ref={buttonRef}
        type="button"
        className="markdown-view-toggle"
        data-locked={locked || undefined}
        aria-pressed={locked}
        aria-label={label}
        title={title}
        disabled={disabled}
        onClick={() => onChange(locked ? "raw" : "rendered")}
        onAnimationEnd={(event) => {
          if (event.animationName === "markdown-view-toggle-shine") {
            event.currentTarget.classList.remove("shine");
          }
        }}
      >
        <span className="markdown-view-toggle-indicator" aria-hidden="true" />
        <svg
          className="markdown-view-toggle-icon markdown-view-toggle-icon-locked"
          viewBox="0 0 16 16"
          fill="currentColor"
          aria-hidden="true"
        >
          <path d="M8 9C8.55228 9 9 9.44771 9 10C9 10.5523 8.55228 11 8 11C7.44772 11 7 10.5523 7 10C7 9.44771 7.44772 9 8 9Z" />
          <path
            fillRule="evenodd"
            clipRule="evenodd"
            d="M8 1C9.654 1 11 2.346 11 4V6H12C13.103 6 14 6.897 14 8V13C14 14.103 13.103 15 12 15H4C2.897 15 2 14.103 2 13V8C2 6.897 2.897 6 4 6H5V4C5 2.346 6.346 1 8 1ZM4 7C3.449 7 3 7.449 3 8V13C3 13.551 3.449 14 4 14H12C12.551 14 13 13.551 13 13V8C13 7.449 12.551 7 12 7H4ZM8 2C6.897 2 6 2.897 6 4V6H10V4C10 2.897 9.103 2 8 2Z"
          />
        </svg>
        <svg
          className="markdown-view-toggle-icon markdown-view-toggle-icon-editing"
          viewBox="0 0 16 16"
          fill="currentColor"
          aria-hidden="true"
        >
          <path d="M14.236 1.76386C13.2123 0.740172 11.5525 0.740171 10.5289 1.76386L2.65722 9.63549C2.28304 10.0097 2.01623 10.4775 1.88467 10.99L1.01571 14.3755C0.971767 14.5467 1.02148 14.7284 1.14646 14.8534C1.27144 14.9783 1.45312 15.028 1.62432 14.9841L5.00978 14.1151C5.52234 13.9836 5.99015 13.7168 6.36433 13.3426L14.236 5.47097C15.2596 4.44728 15.2596 2.78755 14.236 1.76386ZM11.236 2.47097C11.8691 1.8378 12.8957 1.8378 13.5288 2.47097C14.162 3.10413 14.162 4.1307 13.5288 4.76386L12.75 5.54269L10.4571 3.24979L11.236 2.47097ZM9.75002 3.9569L12.0429 6.24979L5.65722 12.6355C5.40969 12.883 5.10023 13.0595 4.76117 13.1465L2.19447 13.8053L2.85327 11.2386C2.9403 10.8996 3.1168 10.5901 3.36433 10.3426L9.75002 3.9569Z" />
        </svg>
      </button>
    );
  },
);
