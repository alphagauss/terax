/** 为所有桌面入口安装开发性能记录的有界生命周期，生产构建不启动观察器。 */
import { observeReactPerformance } from "@/lib/reactPerformance";

if (import.meta.env.DEV) {
  const dispose = observeReactPerformance(
    import.meta.env.VITE_REACT_PROFILE === "true",
  );
  import.meta.hot?.dispose(dispose);
}
