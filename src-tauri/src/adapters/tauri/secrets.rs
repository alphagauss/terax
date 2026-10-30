//! 桌面宿主命令映射。
//!
//! 只转换 Tauri 上下文与输出通道，业务规则由共享服务负责。

use crate::modules::secrets::{self as service, *};

/// 从共享凭据存储读取指定账户。
#[tauri::command]
pub async fn secrets_get(
    state: tauri::State<'_, SecretsState>,
    service: String,
    account: String,
) -> Result<Option<String>, String> {
    service::get_value(&state, &service, &account)
}

/// 将桌面参数交给共享服务。
#[tauri::command]
pub async fn secrets_set(
    app: tauri::AppHandle,
    state: tauri::State<'_, SecretsState>,
    service: String,
    account: String,
    password: String,
) -> Result<(), String> {
    service::secrets_set(state.inner(), service, account, password).await?;
    crate::modules::shared_store::bump_keys_epoch(&super::store::DesktopStoreEvents(app))
}

/// 将桌面参数交给共享服务。
#[tauri::command]
pub async fn secrets_delete(
    app: tauri::AppHandle,
    state: tauri::State<'_, SecretsState>,
    service: String,
    account: String,
) -> Result<(), String> {
    service::secrets_delete(state.inner(), service, account).await?;
    crate::modules::shared_store::bump_keys_epoch(&super::store::DesktopStoreEvents(app))
}

/// 将桌面参数交给共享服务。
#[tauri::command]
pub async fn secrets_get_all(
    state: tauri::State<'_, SecretsState>,
    service: String,
    accounts: Vec<String>,
) -> Result<Vec<Option<String>>, String> {
    service::secrets_get_all(state.inner(), service, accounts).await
}
