"""Terax SSH 文件加速器的一次性远端实现。

该脚本只处理一个封闭、长度前缀的写入任务，通过标准输入输出传递数据，不监听端口、
不持久化状态，也不提供任意命令执行能力。所有写入都在目标同目录完成耐久临时写入和条件提交。
"""

from __future__ import annotations

import hashlib
import json
import os
import stat
import struct
import sys
import tempfile
from typing import Any, BinaryIO


PROTOCOL_VERSION = 1
MAX_HEADER_BYTES = 64 * 1024
MAX_BODY_BYTES = 50 * 1024 * 1024


def _read_exact(stream: BinaryIO, length: int) -> bytes:
    chunks: list[bytes] = []
    remaining = length
    while remaining:
        chunk = stream.read(remaining)
        if not chunk:
            raise ValueError("request body is truncated")
        chunks.append(chunk)
        remaining -= len(chunk)
    return b"".join(chunks)


def _read_request() -> tuple[dict[str, Any], bytes]:
    prefix = _read_exact(sys.stdin.buffer, 4)
    header_length = struct.unpack(">I", prefix)[0]
    if header_length == 0 or header_length > MAX_HEADER_BYTES:
        raise ValueError("request header length is invalid")
    header = json.loads(_read_exact(sys.stdin.buffer, header_length))
    if not isinstance(header, dict) or header.get("version") != PROTOCOL_VERSION:
        raise ValueError("request protocol version is invalid")
    body_length = header.get("bodyLength", 0)
    if not isinstance(body_length, int) or not 0 <= body_length <= MAX_BODY_BYTES:
        raise ValueError("request body length is invalid")
    return header, _read_exact(sys.stdin.buffer, body_length)


def _write_response(header: dict[str, Any], body: bytes = b"") -> None:
    header = {
        "version": PROTOCOL_VERSION,
        **header,
        "bodyLength": len(body),
    }
    encoded = json.dumps(header, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    if len(encoded) > MAX_HEADER_BYTES:
        raise ValueError("response header is too large")
    sys.stdout.buffer.write(struct.pack(">I", len(encoded)))
    sys.stdout.buffer.write(encoded)
    sys.stdout.buffer.write(body)
    sys.stdout.buffer.flush()


def _validate_path(value: Any) -> str:
    if not isinstance(value, str) or not os.path.isabs(value):
        raise ValueError("path must be absolute")
    if any(ord(character) < 32 for character in value):
        raise ValueError("path contains control bytes")
    return value


def _mtime_millis(metadata: os.stat_result) -> int:
    # SFTP v3 只提供秒级修改时间，保持两个后端版本字段一致。
    return int(metadata.st_mtime) * 1000


def _observed(metadata: os.stat_result) -> dict[str, int]:
    return {"size": metadata.st_size, "mtime": _mtime_millis(metadata)}


def _version(metadata: os.stat_result, revision: str) -> dict[str, Any]:
    return {**_observed(metadata), "revision": revision}


def _canonical_target(path: str, allow_missing: bool) -> str:
    if os.path.lexists(path):
        return os.path.realpath(path)
    if not allow_missing:
        raise FileNotFoundError(path)
    parent, name = os.path.split(path)
    if not name or name in (".", ".."):
        raise ValueError("target filename is invalid")
    return os.path.join(os.path.realpath(parent), name)


def _default_file_mode() -> int:
    current = os.umask(0)
    os.umask(current)
    return 0o666 & ~current


def _stage_file(target: str, content: bytes, mode: int) -> str:
    parent = os.path.dirname(target)
    prefix = f".{os.path.basename(target)}.terax-"
    fd, temporary = tempfile.mkstemp(prefix=prefix, suffix=".tmp", dir=parent)
    try:
        os.fchmod(fd, mode)
        view = memoryview(content)
        written = 0
        while written < len(view):
            count = os.write(fd, view[written:])
            if count <= 0:
                raise OSError("temporary file write made no progress")
            written += count
        os.fsync(fd)
    except BaseException:
        os.close(fd)
        try:
            os.unlink(temporary)
        except OSError:
            pass
        raise
    os.close(fd)
    return temporary


def _hash_file(path: str) -> tuple[os.stat_result, str]:
    hasher = hashlib.sha256()
    with open(path, "rb", buffering=0) as stream:
        before = os.fstat(stream.fileno())
        while True:
            chunk = stream.read(256 * 1024)
            if not chunk:
                break
            hasher.update(chunk)
        after = os.fstat(stream.fileno())
    if before.st_size != after.st_size or before.st_mtime_ns != after.st_mtime_ns:
        raise OSError("file changed while hashing")
    return after, hasher.hexdigest()


def _write_result(target: str, replacement: str) -> None:
    metadata = os.stat(target)
    _write_response({"status": "written", "fileVersion": _version(metadata, replacement)})


def _validate_replacement(header: dict[str, Any], body: bytes) -> str:
    replacement = header.get("replacementRevision")
    actual = hashlib.sha256(body).hexdigest()
    if replacement != actual:
        raise ValueError("replacement revision does not match the request body")
    return actual


def _write_checked(header: dict[str, Any], body: bytes) -> None:
    path = _validate_path(header.get("path"))
    expected = header.get("expected")
    if not isinstance(expected, dict) or not isinstance(expected.get("revision"), str):
        raise ValueError("expected version is invalid")
    replacement = _validate_replacement(header, body)
    target = _canonical_target(path, False)
    metadata = os.stat(target)
    temporary = _stage_file(target, body, stat.S_IMODE(metadata.st_mode))
    try:
        current, revision = _hash_file(target)
        if revision == replacement:
            os.unlink(temporary)
            _write_result(target, replacement)
            return
        if current.st_size != expected.get("size") or revision != expected["revision"]:
            os.unlink(temporary)
            _write_response({"status": "conflict", "current": _observed(current)})
            return
        os.replace(temporary, target)
        _write_result(target, replacement)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def _write_missing(header: dict[str, Any], body: bytes) -> None:
    path = _validate_path(header.get("path"))
    replacement = _validate_replacement(header, body)
    target = _canonical_target(path, True)
    temporary = _stage_file(target, body, _default_file_mode())
    try:
        try:
            os.link(temporary, target)
        except FileExistsError:
            current, revision = _hash_file(target)
            if revision == replacement:
                _write_result(target, replacement)
            else:
                _write_response({"status": "conflict", "current": _observed(current)})
            return
        os.unlink(temporary)
        _write_result(target, replacement)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def _write_overwrite(header: dict[str, Any], body: bytes) -> None:
    path = _validate_path(header.get("path"))
    replacement = _validate_replacement(header, body)
    target = _canonical_target(path, True)
    mode = stat.S_IMODE(os.stat(target).st_mode) if os.path.lexists(target) else _default_file_mode()
    temporary = _stage_file(target, body, mode)
    try:
        os.replace(temporary, target)
        _write_result(target, replacement)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def _dispatch(header: dict[str, Any], body: bytes) -> None:
    operation = header.get("operation")
    if operation == "writeChecked":
        _write_checked(header, body)
    elif operation == "writeMissing":
        _write_missing(header, body)
    elif operation == "writeOverwrite":
        _write_overwrite(header, body)
    else:
        raise ValueError("operation is invalid")


def main() -> None:
    try:
        header, body = _read_request()
        _dispatch(header, body)
    except FileNotFoundError:
        _write_response({"status": "error", "code": "notFound"})
    except PermissionError:
        _write_response({"status": "error", "code": "permissionDenied"})
    except ValueError as error:
        _write_response({"status": "error", "code": "invalidRequest", "message": str(error)})
    except OSError as error:
        _write_response({"status": "error", "code": "io", "message": str(error)})


if __name__ == "__main__":
    main()
