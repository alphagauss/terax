//! WSL 文件传输数据面。
//!
//! Direct 继续复用宿主可见的 WSL 路径；Archive 在 WSL 内执行 tar/gzip，
//! 避免把文件树逐项跨越 WSL 文件系统边界。

pub(crate) mod archive;
