//! 终端宿主入口，仅通过继承的私有管道提供原生服务，不创建窗口。

mod stdio;

#[tokio::main]
async fn main() {
    terax_core::runtime::set_runtime(tokio::runtime::Handle::current());
    let result = match std::env::args().nth(1) {
        Some(cwd) => stdio::run(cwd).await,
        None => Err("native host requires an absolute working directory".to_string()),
    };
    if let Err(error) = result {
        eprintln!("{error}");
        std::process::exit(1);
    }
}
