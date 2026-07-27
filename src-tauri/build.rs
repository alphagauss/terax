//! Terax 构建脚本。
//!
//! 负责生成可执行文件内嵌的 Alpha 运行源码归档，并执行 Tauri 的标准构建步骤。

mod build_support;

fn main() {
    build_support::alpha::build_archive().expect("failed to build embedded Alpha archive");
    tauri_build::build()
}
