//! 验证原生回调线程仍可使用宿主注入的同一异步运行时。

#[test]
fn native_thread_can_schedule_and_wait_without_a_tauri_runtime() {
    let runtime = tokio::runtime::Runtime::new().unwrap();
    terax_core::runtime::set_runtime(runtime.handle().clone());
    std::thread::spawn(|| {
        let task = terax_core::runtime::spawn(async {
            tokio::time::sleep(std::time::Duration::from_millis(1)).await;
            terax_core::runtime::spawn_blocking(|| 42).await.unwrap()
        });
        assert_eq!(terax_core::runtime::block_on(task).unwrap(), 42);
    })
    .join()
    .unwrap();
}
