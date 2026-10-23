//! 读取当前网络服务的静态代理与例外列表，不创建监听或修改系统设置。

use super::{endpoint, SystemProxy};
use core_foundation::{
    array::CFArray,
    base::{CFType, TCFType},
    dictionary::CFDictionary,
    number::CFNumber,
    string::CFString,
};
use system_configuration::dynamic_store::SCDynamicStoreBuilder;

pub(super) fn read() -> Result<SystemProxy, String> {
    let store = SCDynamicStoreBuilder::new("Terax network proxy")
        .build()
        .ok_or("unable to open system proxy settings")?;
    let Some(values) = store.get_proxies() else {
        return Ok(SystemProxy::default());
    };
    parse(&values)
}

fn parse(values: &CFDictionary<CFString, CFType>) -> Result<SystemProxy, String> {
    let number = |key: &str| {
        values
            .find(CFString::new(key))
            .and_then(|value| value.downcast::<CFNumber>())
            .and_then(|value| value.to_i64())
            .unwrap_or(0)
    };
    let string = |key: &str| {
        values
            .find(CFString::new(key))
            .and_then(|value| value.downcast::<CFString>())
            .map(|value| value.to_string())
    };
    let proxy = |prefix: &str, socks: bool| {
        if number(&format!("{prefix}Enable")) == 0 {
            return Ok(None);
        }
        let host = string(&format!("{prefix}Proxy")).ok_or("system proxy host is missing")?;
        let port = number(&format!("{prefix}Port"));
        let host = if host.contains(':') {
            format!("[{host}]")
        } else {
            host
        };
        endpoint(&format!("{host}:{port}"), socks).map(Some)
    };
    let bypass = values
        .find(CFString::new("ExceptionsList"))
        .and_then(|value| value.downcast::<CFArray>())
        .map(|values| {
            // 系统字典中的数组元素都是 CF 对象，先按 CFType 读取再逐项校验字符串类型。
            let values =
                unsafe { CFArray::<CFType>::wrap_under_get_rule(values.as_concrete_TypeRef()) };
            values
                .iter()
                .filter_map(|value| value.downcast::<CFString>().map(|value| value.to_string()))
                .collect()
        })
        .unwrap_or_default();
    Ok(SystemProxy {
        http: proxy("HTTP", false)?,
        https: proxy("HTTPS", false)?,
        socks: proxy("SOCKS", true)?,
        bypass,
        exclude_simple: number("ExcludeSimpleHostnames") != 0,
        ..Default::default()
    })
}
