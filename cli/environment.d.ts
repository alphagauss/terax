/** 本文件声明终端入口使用的 Bun 主模块标志，不将 Bun 全局 fetch 扩展带入共享业务。 */
interface ImportMeta {
  readonly main?: boolean;
}
