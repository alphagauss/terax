//! POSIX Shell 参数的单引号转义，供本地和远端受控命令构造复用。

/// 将完整参数编码为一个 Shell 单词，不允许参数内容变成语法。
pub fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}
