//! Terax 构建脚本。
//!
//! 负责生成可执行文件内嵌的 Alpha 运行源码归档与发布 revision，并执行 Tauri 标准构建步骤。

mod build_support;

fn main() {
    println!("cargo:rerun-if-env-changed=PROFILE");
    if std::env::var("PROFILE").as_deref() == Ok("release") {
        build_support::alpha::build_archive().expect("failed to build embedded Alpha archive");
    } else {
        println!("cargo:rustc-env=TERAX_ALPHA_RELEASE_ARCHIVE_SHA256=development");
    }
    tauri_build::build()
}
