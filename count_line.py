"""统计仓库内各语言的代码、注释和空白行数。

用法:
    python count_line.py [仓库根目录]

分类口径:
- 只含注释的行计入 comment，含实际代码的行计入 code，行尾注释仍算 code；
- 全空白行计入 blank；
- Python 三引号块按惯例计入 comment，其他语言的跨行字符串内容计入 code。

文件范围优先使用 git ls-files，因此 node_modules、dist、build 等未纳入版本管理的生成物
自动排除；无法读取 Git 信息时回退到目录遍历。
"""

from __future__ import annotations

import os
import re
import subprocess
import sys
from collections import defaultdict

# 不参与统计的目录
SKIP_DIRS = {
    ".git",
    "node_modules",
    "target",
    "dist",
    "build",
    "artifacts",
    "gen",
    "__pycache__",
    "venv",
    ".venv",
    "licenses",
}

# 不参与统计的文件
SKIP_FILES = {"pnpm-lock.yaml", "package-lock.json", "Cargo.lock", "flake.lock", "uv.lock"}

# 扩展名到语言名
LANGS = {
    ".rs": "Rust",
    ".ts": "TypeScript",
    ".mts": "TypeScript",
    ".cts": "TypeScript",
    ".tsx": "TSX",
    ".js": "JavaScript",
    ".mjs": "JavaScript",
    ".cjs": "JavaScript",
    ".py": "Python",
    ".sh": "Shell",
    ".bash": "Shell",
    ".zsh": "Shell",
    ".fish": "Shell",
    ".nsh": "Shell",
    ".ps1": "PowerShell",
    ".nix": "Nix",
    ".css": "CSS",
    ".html": "HTML",
    ".xml": "XML",
    ".plist": "XML",
    ".toml": "TOML",
    ".ini": "INI",
    ".yaml": "YAML",
    ".yml": "YAML",
    ".json": "JSON",
    ".md": "Markdown",
}

# 注释与字符串语法
# line: 行注释前缀; block: 块注释定界符; multi: 可跨行的字符串定界符;
# nest: 块注释是否可以嵌套; rust: 需要区分字符字面量与生命周期
SYNTAX = {
    "Rust": {"line": ["//"], "block": [("/*", "*/")], "multi": ['"', "raw"], "nest": True, "rust": True},
    "TypeScript": {"line": ["//"], "block": [("/*", "*/")], "multi": ["`"]},
    "TSX": {"line": ["//"], "block": [("/*", "*/")], "multi": ["`"]},
    "JavaScript": {"line": ["//"], "block": [("/*", "*/")], "multi": ["`"]},
    "Python": {"line": ["#"], "multi": ['"""', "'''"], "str_lines": "comment"},
    "Shell": {"line": ["#"]},
    "PowerShell": {"line": ["#"], "block": [("<#", "#>")]},
    "Nix": {"line": ["#"], "block": [("/*", "*/")], "multi": ["''"], "nest": True},
    "CSS": {"block": [("/*", "*/")]},
    "HTML": {"block": [("<!--", "-->")]},
    "XML": {"block": [("<!--", "-->")]},
    "TOML": {"line": ["#"]},
    "INI": {"line": ["#", ";"]},
    "YAML": {"line": ["#"]},
}
NO_COMMENT = {}

QUOTES = "\"'`"
# Rust 字符字面量，用于排除生命周期标注 'a
RUST_CHAR = re.compile(r"'(?:\\.|[^\\'])'")
# Rust 原始字符串 r"..." 与 r#"..."#
RUST_RAW = re.compile(r'b?r(#*)"')


def scan(text: str, lang: str):
    """返回 (code, comment, blank) 三元组。"""
    syn = SYNTAX.get(lang, NO_COMMENT)
    line_marks = syn.get("line", [])
    blocks = syn.get("block", [])
    multi = syn.get("multi", [])
    nest = syn.get("nest", False)
    is_rust = syn.get("rust", False)
    # 跨行字符串内部的行按哪个类别计数
    str_lines = syn.get("str_lines", "code")

    code = comment = blank = 0
    block_open = block_close = None
    block_depth = 0
    str_close = None

    for line in text.splitlines():
        i, n = 0, len(line)
        has_code = False
        has_str = False
        has_comment = False
        # 该行起始时正处于跨行字符串内部
        in_string = str_close is not None

        while i < n:
            # 块注释内部
            if block_close is not None:
                has_comment = True
                if nest and line.startswith(block_open, i):
                    block_depth += 1
                    i += len(block_open)
                    continue
                if line.startswith(block_close, i):
                    block_depth -= 1
                    i += len(block_close)
                    if block_depth <= 0:
                        block_open = block_close = None
                        block_depth = 0
                    continue
                i += 1
                continue

            # 跨行字符串内部
            if str_close is not None:
                if line[i] == "\\":
                    i += 2
                    continue
                if line.startswith(str_close, i):
                    i += len(str_close)
                    str_close = None
                    continue
                i += 1
                continue

            ch = line[i]
            if ch.isspace():
                i += 1
                continue

            # 行注释
            hit = False
            for mark in line_marks:
                if line.startswith(mark, i):
                    has_comment = True
                    i = n
                    hit = True
                    break
            if hit:
                break

            # 块注释开始
            for opener, closer in blocks:
                if line.startswith(opener, i):
                    has_comment = True
                    block_open, block_close = opener, closer
                    block_depth = 1
                    i += len(opener)
                    hit = True
                    break
            if hit:
                continue

            # 跨行字符串开始：Python 三引号、JS 模板串、Rust 原始字符串、Nix 缩进字符串
            for delim in multi:
                if delim == "raw" and is_rust:
                    match = RUST_RAW.match(line, i)
                    if match:
                        has_str = True
                        end_mark = '"' + match.group(1)
                        end = line.find(end_mark, match.end())
                        if end < 0:
                            str_close = end_mark
                            i = n
                        else:
                            i = end + len(end_mark)
                        hit = True
                        break
                    continue
                if line.startswith(delim, i):
                    has_str = True
                    end = line.find(delim, i + len(delim))
                    if end < 0:
                        str_close = delim
                        i = n
                    else:
                        i = end + len(delim)
                    hit = True
                    break
            if hit:
                continue

            # Rust 字符字面量与生命周期
            if is_rust and ch == "'":
                match = RUST_CHAR.match(line, i)
                has_str = True
                i = match.end() if match else i + 1
                continue

            # 单行字符串
            if ch in QUOTES:
                has_str = True
                j = i + 1
                while j < n:
                    if line[j] == "\\":
                        j += 2
                        continue
                    if line[j] == ch:
                        j += 1
                        break
                    j += 1
                i = j
                continue

            has_code = True
            i += 1

        # 只含字符串字面量的行，按语言惯例归入代码或注释
        str_line = has_str or in_string
        if has_code:
            code += 1
        elif has_comment and not (str_line and str_lines == "code"):
            comment += 1
        elif str_line:
            if str_lines == "comment":
                comment += 1
            else:
                code += 1
        else:
            blank += 1

    return code, comment, blank


def repo_files(root: str):
    """返回待统计的相对路径列表，优先使用 Git 追踪的文件。"""
    try:
        out = subprocess.run(
            ["git", "ls-files", "-z"], cwd=root, capture_output=True, check=True
        ).stdout
        files = [p for p in out.decode("utf-8").split("\0") if p]
        if files:
            return files
    except (OSError, subprocess.CalledProcessError):
        pass
    found = []
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS]
        for name in filenames:
            found.append(os.path.relpath(os.path.join(dirpath, name), root))
    return found


def count_lines(root: str = ".") -> dict:
    """统计各语言行数，返回 {语言: {files, code, comment, blank}}。"""
    root = os.path.abspath(root)
    stats = defaultdict(lambda: {"files": 0, "code": 0, "comment": 0, "blank": 0})

    for rel in repo_files(root):
        parts = rel.replace("\\", "/").split("/")
        if any(part in SKIP_DIRS for part in parts[:-1]) or parts[-1] in SKIP_FILES:
            continue
        lang = LANGS.get(os.path.splitext(rel)[1].lower())
        if not lang:
            continue
        try:
            with open(os.path.join(root, rel), "rb") as f:
                raw = f.read()
        except OSError:
            continue
        if b"\x00" in raw[:2048]:
            continue
        try:
            text = raw.decode("utf-8")
        except UnicodeDecodeError:
            continue
        code, comment, blank = scan(text, lang)
        entry = stats[lang]
        entry["files"] += 1
        entry["code"] += code
        entry["comment"] += comment
        entry["blank"] += blank

    return dict(stats)


def _width(text: str) -> int:
    # 中日韩字符按两列宽计算，保证表格对齐
    return sum(2 if ord(c) > 0x2E80 else 1 for c in text)


def _pad(value, width: int, right: bool = False) -> str:
    text = str(value)
    fill = " " * max(width - _width(text), 0)
    return fill + text if right else text + fill


COLUMNS = [
    ("语言", 12, False),
    ("文件", 6, True),
    ("代码", 9, True),
    ("注释", 9, True),
    ("空白", 9, True),
    ("总行", 9, True),
    ("注释率", 9, True),
]


def format_row(cells) -> str:
    return "".join(_pad(v, w, r) for v, (_, w, r) in zip(cells, COLUMNS))


def main(argv=None) -> int:
    argv = sys.argv[1:] if argv is None else argv
    root = argv[0] if argv else "."
    stats = count_lines(root)
    if not stats:
        print("没有找到可统计的源文件")
        return 1

    print(format_row([c[0] for c in COLUMNS]))
    print("-" * 63)

    total = {"files": 0, "code": 0, "comment": 0, "blank": 0}
    for lang, entry in sorted(stats.items(), key=lambda kv: kv[1]["code"], reverse=True):
        lines = entry["code"] + entry["comment"] + entry["blank"]
        denom = entry["code"] + entry["comment"]
        ratio = entry["comment"] / denom * 100 if denom else 0.0
        print(format_row([lang, entry["files"], entry["code"], entry["comment"],
                          entry["blank"], lines, f"{ratio:.1f}%"]))
        for key in total:
            total[key] += entry[key]

    lines = total["code"] + total["comment"] + total["blank"]
    denom = total["code"] + total["comment"]
    ratio = total["comment"] / denom * 100 if denom else 0.0
    print("-" * 63)
    print(format_row(["合计", total["files"], total["code"], total["comment"],
                      total["blank"], lines, f"{ratio:.1f}%"]))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
