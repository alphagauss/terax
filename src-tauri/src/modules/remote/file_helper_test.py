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
