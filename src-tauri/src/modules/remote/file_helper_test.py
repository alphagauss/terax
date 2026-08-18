"""测试一次性 SSH 文件 helper 的协议和原子文件语义。"""

from __future__ import annotations

import hashlib
import io
import json
import os
from pathlib import Path
import subprocess
import struct
import sys
import tempfile
import unittest
from unittest import mock

import file_helper as helper


class FileHelperTests(unittest.TestCase):
    def capture_response(self):
        captured = []

        def capture(header, body=b""):
            captured.append((header, body))

        return captured, mock.patch.object(helper, "_write_response", capture)

    def test_reads_length_prefixed_request_with_raw_body(self):
        body = b"\x00raw\xff"
        header = {
            "version": helper.PROTOCOL_VERSION,
            "operation": "writeMissing",
            "path": os.path.abspath("target.txt"),
            "bodyLength": len(body),
        }
        encoded_header = json.dumps(header).encode()
        frame = struct.pack(">I", len(encoded_header)) + encoded_header + body
        fake_stdin = mock.Mock(buffer=io.BytesIO(frame))

        with mock.patch.object(helper.sys, "stdin", fake_stdin):
            parsed, parsed_body = helper._read_request()

        self.assertEqual(parsed["operation"], "writeMissing")
        self.assertEqual(parsed_body, body)

    def test_one_shot_process_uses_the_framed_protocol(self):
        header = {
            "version": helper.PROTOCOL_VERSION,
            "operation": "invalid",
            "path": os.path.abspath("target.txt"),
            "bodyLength": 0,
        }
        encoded_header = json.dumps(header).encode()
        request = struct.pack(">I", len(encoded_header)) + encoded_header
        source = Path(helper.__file__).read_text(encoding="utf-8")

        completed = subprocess.run(
            [sys.executable, "-I", "-u", "-c", source],
            input=request,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=True,
        )

        header_length = struct.unpack(">I", completed.stdout[:4])[0]
        response = json.loads(completed.stdout[4 : 4 + header_length])
        self.assertEqual(response["status"], "error")
        self.assertEqual(response["code"], "invalidRequest")

    def test_checked_write_rejects_invalid_expected_version(self):
        with self.assertRaisesRegex(ValueError, "expected version is invalid"):
            helper._validate_expected(
                {"revision": "not-a-digest", "size": helper.MAX_BODY_BYTES + 1}
            )

    def test_checked_write_conflicts_on_size_before_hashing_or_staging(self):
        path = os.path.abspath("note.txt")
        captured, response_patch = self.capture_response()
        metadata = mock.Mock(st_size=8, st_mtime=1)

        with (
            response_patch,
            mock.patch.object(helper, "_canonical_target", return_value=path),
            mock.patch.object(helper.os, "stat", return_value=metadata),
            mock.patch.object(helper, "_hash_file") as hash_file,
            mock.patch.object(helper, "_stage_file") as stage_file,
        ):
            helper._write_checked(
                {
                    "path": path,
                    "expected": {"revision": "a" * 64, "size": 7},
                    "replacementRevision": hashlib.sha256(b"after").hexdigest(),
                },
                b"after",
            )

        self.assertEqual(captured[0][0]["status"], "conflict")
        hash_file.assert_not_called()
        stage_file.assert_not_called()

    def test_stage_file_removes_temporary_when_close_fails(self):
        with (
            mock.patch.object(helper.tempfile, "mkstemp", return_value=(7, "/tmp/staged")),
            mock.patch.object(helper.os, "fchmod", create=True),
            mock.patch.object(helper.os, "write", return_value=4),
            mock.patch.object(helper.os, "fsync"),
            mock.patch.object(helper.os, "close", side_effect=OSError("close failed")),
            mock.patch.object(helper.os, "unlink") as unlink,
        ):
            with self.assertRaisesRegex(OSError, "close failed"):
                helper._stage_file("/tmp/target", b"data", 0o600)

        unlink.assert_called_once_with("/tmp/staged")

    @unittest.skipUnless(os.name == "posix", "原子权限语义只在远端 Linux 上执行")
    def test_checked_write_preserves_mode_and_commits_expected_content(self):
        with tempfile.TemporaryDirectory() as directory:
            path = os.path.join(directory, "note.txt")
            before = b"before"
            after = b"after"
            with open(path, "wb") as stream:
                stream.write(before)
            os.chmod(path, 0o640)
            captured, patch = self.capture_response()

            with patch:
                helper._write_checked(
                    {
                        "path": path,
                        "expected": {
                            "revision": hashlib.sha256(before).hexdigest(),
                            "size": len(before),
                            "mtime": int(os.stat(path).st_mtime) * 1000,
                        },
                        "replacementRevision": hashlib.sha256(after).hexdigest(),
                    },
                    after,
                )

            self.assertEqual(captured[0][0]["status"], "written")
            with open(path, "rb") as stream:
                self.assertEqual(stream.read(), after)
            self.assertEqual(os.stat(path).st_mode & 0o777, 0o640)


if __name__ == "__main__":
    unittest.main()
