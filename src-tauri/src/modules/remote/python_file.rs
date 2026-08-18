//! 不落盘 Python 文件加速器的 SSH 协议适配。
//!
//! 每次调用在独立 session channel 中启动仓库内嵌 helper，使用长度前缀 JSON 头和原始
//! 正文完成一个封闭写入任务。模块不决定是否启用或回退，只报告请求是否已经 dispatch。

use std::sync::Arc;
use std::time::Duration;

use serde::{Deserialize, Serialize};

use super::file_service::{RemoteCheckedWrite, RemoteObservedVersion, RemoteVersion};
use super::session::{shell_quote, RemoteWorkspace};

const HELPER_SOURCE: &str = include_str!("file_helper.py");
const PROTOCOL_VERSION: u8 = 1;
const MAX_HEADER_BYTES: usize = 64 * 1024;
const MAX_BODY_BYTES: usize = 50 * 1024 * 1024;
const MAX_RESPONSE_BYTES: usize = 4 + MAX_HEADER_BYTES;
const HELPER_TIMEOUT: Duration = Duration::from_secs(60);

/// Python helper 失败及失败时请求是否可能已经执行。
#[derive(Debug)]
pub(crate) struct PythonFileError {
    pub(crate) dispatched: bool,
    pub(crate) disable_backend: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct HelperRequest<'a> {
    version: u8,
    operation: &'a str,
    path: &'a str,
    body_length: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    expected: Option<&'a RemoteVersion>,
    #[serde(skip_serializing_if = "Option::is_none")]
    replacement_revision: Option<&'a str>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct HelperResponse {
    version: u8,
    status: String,
    body_length: usize,
    #[serde(default)]
    file_version: Option<RemoteVersion>,
    #[serde(default)]
    current: Option<RemoteObservedVersion>,
    #[serde(default)]
    code: Option<String>,
}

/// 通过 Python helper 按已确认版本提交远端文件。
pub(crate) async fn write_checked(
    workspace: &Arc<RemoteWorkspace>,
    path: &str,
    content: &[u8],
    expected: &RemoteVersion,
    replacement_revision: &str,
) -> Result<RemoteCheckedWrite, PythonFileError> {
    write(
        workspace,
        "writeChecked",
        path,
        content,
        Some(expected),
        replacement_revision,
    )
    .await
}

/// 通过 Python helper 仅在目标缺失时创建远端文件。
pub(crate) async fn write_missing(
    workspace: &Arc<RemoteWorkspace>,
    path: &str,
    content: &[u8],
    replacement_revision: &str,
) -> Result<RemoteCheckedWrite, PythonFileError> {
    write(
        workspace,
        "writeMissing",
        path,
        content,
        None,
        replacement_revision,
    )
    .await
}

/// 通过 Python helper 无条件覆盖远端文件。
pub(crate) async fn write_overwrite(
    workspace: &Arc<RemoteWorkspace>,
    path: &str,
    content: &[u8],
    replacement_revision: &str,
) -> Result<RemoteCheckedWrite, PythonFileError> {
    write(
        workspace,
        "writeOverwrite",
        path,
        content,
        None,
        replacement_revision,
    )
    .await
}

async fn write(
    workspace: &Arc<RemoteWorkspace>,
    operation: &str,
    path: &str,
    content: &[u8],
    expected: Option<&RemoteVersion>,
    replacement_revision: &str,
) -> Result<RemoteCheckedWrite, PythonFileError> {
    let result = execute(
        workspace,
        HelperRequest {
            version: PROTOCOL_VERSION,
            operation,
            path,
            body_length: content.len(),
            expected,
            replacement_revision: Some(replacement_revision),
        },
        content.to_vec(),
    )
    .await?;
    match result.status.as_str() {
        "written" => {
            let version = result
                .file_version
                .ok_or_else(|| protocol_error("written response omitted its version"))?;
            if version.revision != replacement_revision || version.size != content.len() as u64 {
                return Err(protocol_error(
                    "written response returned an unexpected version",
                ));
            }
            Ok(RemoteCheckedWrite::Written {
                mtime: version.mtime,
            })
        }
        "conflict" => Ok(RemoteCheckedWrite::Conflict {
            current: result.current,
        }),
        _ => Err(response_error(&result)),
    }
}

/// 在一个独立 SSH channel 上执行一次 helper 请求。
async fn execute(
    workspace: &Arc<RemoteWorkspace>,
    request: HelperRequest<'_>,
    body: Vec<u8>,
) -> Result<HelperResponse, PythonFileError> {
    let input = encode_request(&request, body)?;
    let channel = match workspace.take_file_helper_channel().await {
        Ok(channel) => channel,
        Err(_) => {
            return Err(PythonFileError {
                dispatched: false,
                disable_backend: workspace.python_file_write_acceleration_available().await,
            })
        }
    };
    let command = format!("python3 -I -u -c {}", shell_quote(HELPER_SOURCE));
    let output = workspace
        .exec_on_channel_with_input(channel, &command, input, HELPER_TIMEOUT, MAX_RESPONSE_BYTES)
        .await
        .map_err(|_| PythonFileError {
            dispatched: true,
            disable_backend: true,
        })?;
    if output.timed_out || output.truncated || output.exit_code != Some(0) {
        return Err(PythonFileError {
            dispatched: true,
            disable_backend: true,
        });
    }
    decode_response(&output.stdout).map_err(|_| PythonFileError {
        dispatched: true,
        disable_backend: true,
    })
}

fn encode_request(request: &HelperRequest<'_>, body: Vec<u8>) -> Result<Vec<u8>, PythonFileError> {
    if body.len() != request.body_length || body.len() > MAX_BODY_BYTES {
        return Err(request_error());
    }
    let header = serde_json::to_vec(request).map_err(|_| request_error())?;
    let header_length = u32::try_from(header.len())
        .ok()
        .filter(|length| *length > 0 && *length as usize <= MAX_HEADER_BYTES)
        .ok_or_else(request_error)?;
    let mut output = Vec::with_capacity(4 + header.len() + body.len());
    output.extend_from_slice(&header_length.to_be_bytes());
    output.extend_from_slice(&header);
    output.extend_from_slice(&body);
    Ok(output)
}

fn decode_response(bytes: &[u8]) -> Result<HelperResponse, String> {
    let prefix: [u8; 4] = bytes
        .get(..4)
        .ok_or_else(|| "helper response omitted its header length".to_string())?
        .try_into()
        .map_err(|_| "helper response header length is invalid".to_string())?;
    let header_length = u32::from_be_bytes(prefix) as usize;
    if header_length == 0 || header_length > MAX_HEADER_BYTES {
        return Err("helper response header length is invalid".into());
    }
    let header_end = 4usize
        .checked_add(header_length)
        .ok_or_else(|| "helper response length overflowed".to_string())?;
    let header = bytes
        .get(4..header_end)
        .ok_or_else(|| "helper response header is truncated".to_string())?;
    let response: HelperResponse = serde_json::from_slice(header)
        .map_err(|error| format!("invalid helper response: {error}"))?;
    if response.version != PROTOCOL_VERSION || response.body_length != 0 {
        return Err("helper response protocol fields are invalid".into());
    }
    let expected_end = header_end
        .checked_add(response.body_length)
        .ok_or_else(|| "helper response body length overflowed".to_string())?;
    if expected_end != bytes.len() {
        return Err("helper response body length does not match its frame".into());
    }
    Ok(response)
}

fn response_error(response: &HelperResponse) -> PythonFileError {
    PythonFileError {
        dispatched: true,
        disable_backend: response.code.as_deref() == Some("invalidRequest"),
    }
}

fn protocol_error(_message: &str) -> PythonFileError {
    PythonFileError {
        dispatched: true,
        disable_backend: true,
    }
}

fn request_error() -> PythonFileError {
    PythonFileError {
        dispatched: false,
        disable_backend: false,
    }
}

#[cfg(test)]
mod tests {
    use super::{decode_response, encode_request, HelperRequest, PROTOCOL_VERSION};

    #[test]
    fn request_frame_keeps_header_and_raw_body_separate() {
        let body = vec![0, 1, 2, 255];
        let encoded = encode_request(
            &HelperRequest {
                version: PROTOCOL_VERSION,
                operation: "writeMissing",
                path: "/tmp/a",
                body_length: body.len(),
                expected: None,
                replacement_revision: Some(
                    "054edec1d0211f624fed0cbca9d4f9400b0e491c43742af2c5b0abebf0c990d8",
                ),
            },
            body.clone(),
        )
        .unwrap();
        let header_length = u32::from_be_bytes(encoded[..4].try_into().unwrap()) as usize;

        assert_eq!(&encoded[4 + header_length..], body);
    }

    #[test]
    fn response_frame_rejects_trailing_or_truncated_body() {
        let header = br#"{"version":1,"status":"written","bodyLength":0}"#;
        let mut valid = Vec::new();
        valid.extend_from_slice(&(header.len() as u32).to_be_bytes());
        valid.extend_from_slice(header);
        assert_eq!(decode_response(&valid).unwrap().status, "written");

        valid.push(b'x');
        assert!(decode_response(&valid).is_err());
        valid.truncate(valid.len() - 2);
        assert!(decode_response(&valid).is_err());
    }
}
