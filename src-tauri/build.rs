//! Terax 构建脚本。
//!
//! 桌面特性负责生成可执行文件内嵌的 Alpha 运行源码归档与发布 revision、执行 Tauri 标准构建步骤，
//! 并确保 Windows 测试程序使用与正式应用一致的 Common Controls v6 manifest。
//! 无界面构建不生成桌面资源，不执行 Tauri 构建步骤。

#[cfg(feature = "desktop")]
mod build_support;

#[cfg(feature = "desktop")]
const WINDOWS_COMMON_CONTROLS_V6_DEPENDENCY: &str = concat!(
    "/MANIFESTDEPENDENCY:type='win32' ",
    "name='Microsoft.Windows.Common-Controls' ",
    "version='6.0.0.0' ",
    "processorArchitecture='*' ",
    "publicKeyToken='6595b64144ccf1df' ",
    "language='*'",
);

/// 为 Windows MSVC 测试程序嵌入 Common Controls v6 activation manifest。
///
/// Tauri 只把应用资源链接到普通二进制目标。通用 linker 参数覆盖库单元测试和集成测试，
/// 普通二进制目标则继续使用 Tauri 已生成的资源，避免重复的 manifest resource。
#[cfg(feature = "desktop")]
fn configure_windows_test_manifest() {
    let is_windows_msvc = std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows")
        && std::env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("msvc");
    if !is_windows_msvc {
        return;
    }

    println!("cargo:rustc-link-arg={WINDOWS_COMMON_CONTROLS_V6_DEPENDENCY}");
    println!("cargo:rustc-link-arg=/MANIFEST:EMBED");
    println!("cargo:rustc-link-arg-bins=/MANIFEST:NO");
}

#[cfg(feature = "desktop")]
fn main() {
    println!("cargo:rerun-if-env-changed=PROFILE");
    if std::env::var("PROFILE").as_deref() == Ok("release") {
        build_support::alpha::build_archive().expect("failed to build embedded Alpha archive");
    } else {
        println!("cargo:rustc-env=TERAX_ALPHA_RELEASE_ARCHIVE_SHA256=development");
    }
    tauri_build::build();
    configure_windows_test_manifest();
}

#[cfg(not(feature = "desktop"))]
fn main() {}
