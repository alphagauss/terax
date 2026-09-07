# 主题规则

主题字段与 CSS 映射以 `src/modules/theme/types.ts` 和 `themeRegistry.ts` 为准，完整基准为 `themes/modern.ts`。新增字段只在类型和注册表定义，不另建字段清单。

## 解析语义

- Light Modern 与 Dark Modern 是对应模式的完整基准。
- 主题的 UI、终端字段可局部覆盖，缺失值由请求模式的 Modern 补全；editor 必须完整内嵌，不能引用外部主题 ID。
- 单变体主题在另一模式继续使用已有变体，缺失字段仍按请求模式补全。
- 未登记字段拒绝；主题文件应能独立分享并恢复编辑器外观。
- 编辑器选择“自动”使用应用主题内的 editor；用户显式选择独立编辑器预设时优先使用该覆盖。

## 视觉语义

hover、active、selected、focus 和拖放是不同状态，不能用同一个强调色取代。语义小字号文字直接使用 foreground 或 mutedForeground，不通过多层 opacity 弱化，也不用页面透明度补偿错误 token。

遮罩、选区、边框、禁用、动画和交互覆盖层可以使用透明度。新增内置主题从 Modern 结构开始，分别配置 light/dark 并注册；自定义主题由设置页创建完整模板，单模式可以删除另一变体。

验证遵循 [测试指南](testing.md)。只有涉及真实合成、背景图、透明窗口或动态测量时才需要 [运行时调试](ui-runtime-debugging.md)。
