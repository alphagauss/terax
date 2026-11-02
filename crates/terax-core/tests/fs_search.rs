//! 文件名、内容与 glob 搜索的集成测试。
//!
//! 测试锁定 ignore、匹配选项、路径过滤、结果上限和自然排序等工作区搜索不变量。

mod common;

use common::FsFixture;
use std::process::Command;
use terax_core::modules::fs::grep::{
    fs_glob, search_content, ContentSearchCaseMode, ContentSearchRequest, ContentSearchSyntax,
};
use terax_core::modules::fs::search::search_paths;
use terax_core::modules::fs::tree::{fs_read_dir, list_subdirs, EntryKind};

fn content_request(root: String, pattern: &str) -> ContentSearchRequest {
    ContentSearchRequest {
        root,
        pattern: pattern.into(),
        syntax: ContentSearchSyntax::Regex,
        case_mode: ContentSearchCaseMode::Sensitive,
        whole_word: false,
        includes: Vec::new(),
        excludes: Vec::new(),
        max_results: None,
        cancel_previous: false,
        workspace: None,
    }
}

#[tokio::test]
async fn grep_finds_matches_and_returns_relative_paths() {
    let fx = FsFixture::new();
    fx.write(
        "src/main.rs",
        "fn main() {\n    println!(\"hello world\");\n}\n",
    );
    fx.write("src/lib.rs", "pub fn greet() {}\n");

    let res = search_content(content_request(fx.root_str(), "hello"))
        .await
        .expect("grep");

    assert_eq!(res.hits.len(), 1);
    let hit = &res.hits[0];
    assert_eq!(hit.rel, "src/main.rs");
    assert_eq!(hit.line, 2);
    assert!(hit.text.contains("hello world"));
    assert!(!res.truncated);
    assert_eq!(res.files_scanned, 2);
}

#[tokio::test]
async fn grep_case_insensitive_finds_mixed_case() {
    let fx = FsFixture::new();
    fx.write("a.txt", "Hello World\n");

    let strict = search_content(content_request(fx.root_str(), "hello"))
        .await
        .expect("grep");
    assert!(strict.hits.is_empty());

    let mut request = content_request(fx.root_str(), "hello");
    request.case_mode = ContentSearchCaseMode::Insensitive;
    let loose = search_content(request).await.expect("grep");
    assert_eq!(loose.hits.len(), 1);
}

#[tokio::test]
async fn grep_glob_filter_restricts_files() {
    let fx = FsFixture::new();
    fx.write("a.rs", "target\n");
    fx.write("b.ts", "target\n");

    let mut request = content_request(fx.root_str(), "target");
    request.includes = vec!["*.rs".into()];
    let res = search_content(request).await.expect("grep");

    assert_eq!(res.hits.len(), 1);
    assert_eq!(res.hits[0].rel, "a.rs");
}

#[tokio::test]
async fn grep_max_results_truncates() {
    let fx = FsFixture::new();
    for i in 0..10 {
        fx.write(&format!("f{i}.txt"), "needle\n");
    }

    let mut request = content_request(fx.root_str(), "needle");
    request.max_results = Some(3);
    let res = search_content(request).await.expect("grep");

    assert!(res.hits.len() <= 3);
    assert!(res.truncated);
}

#[tokio::test]
async fn grep_empty_pattern_errors() {
    let fx = FsFixture::new();
    let err = search_content(content_request(fx.root_str(), "")).await;
    assert!(err.is_err());
}

#[tokio::test]
async fn grep_non_dir_root_errors() {
    let err = search_content(content_request("/this/does/not/exist".into(), "x")).await;
    assert!(err.is_err());
}

#[tokio::test]
async fn grep_respects_ignore_file() {
    let fx = FsFixture::new();
    fx.write(".ignore", "ignored.txt\n");
    fx.write("ignored.txt", "secret\n");
    fx.write("visible.txt", "secret\n");

    let res = search_content(content_request(fx.root_str(), "secret"))
        .await
        .expect("grep");

    let rels: Vec<&str> = res.hits.iter().map(|h| h.rel.as_str()).collect();
    assert!(rels.contains(&"visible.txt"));
    assert!(!rels.contains(&"ignored.txt"));
}

#[tokio::test]
async fn content_search_supports_literal_whole_word_and_excludes() {
    let fx = FsFixture::new();
    fx.write("src/keep.txt", "a.b aXb a.bigger\n");
    fx.write("generated/skip.txt", "a.b\n");

    let mut request = content_request(fx.root_str(), "a.b");
    request.syntax = ContentSearchSyntax::Literal;
    request.whole_word = true;
    request.excludes = vec!["generated/**".into()];
    let res = search_content(request).await.expect("content search");

    assert_eq!(res.hits.len(), 1);
    assert_eq!(res.hits[0].rel, "src/keep.txt");
    assert_eq!(res.hits[0].ranges.len(), 1);
}

#[tokio::test]
async fn content_search_reports_utf16_match_ranges() {
    let fx = FsFixture::new();
    fx.write("unicode.txt", "前\u{1F600}needle后\n");

    let res = search_content(content_request(fx.root_str(), "needle"))
        .await
        .expect("content search");

    assert_eq!(res.hits.len(), 1);
    assert_eq!(res.hits[0].ranges[0].start, 3);
    assert_eq!(res.hits[0].ranges[0].end, 9);
}

#[tokio::test]
async fn glob_finds_files_by_pattern() {
    let fx = FsFixture::new();
    fx.write("src/a.rs", "");
    fx.write("src/b.rs", "");
    fx.write("README.md", "");

    let res = fs_glob("**/*.rs".into(), fx.root_str(), None, None)
        .await
        .expect("glob");

    let mut rels: Vec<&str> = res.hits.iter().map(|h| h.rel.as_str()).collect();
    rels.sort();
    assert_eq!(rels, vec!["src/a.rs", "src/b.rs"]);
}

#[tokio::test]
async fn glob_truncates_on_limit() {
    let fx = FsFixture::new();
    for i in 0..20 {
        fx.write(&format!("file{i}.txt"), "");
    }

    let res = fs_glob("*.txt".into(), fx.root_str(), Some(5), None)
        .await
        .expect("glob");
    assert!(res.hits.len() <= 5);
    assert!(res.truncated);
}

#[tokio::test]
async fn glob_empty_pattern_errors() {
    let fx = FsFixture::new();
    assert!(fs_glob("".into(), fx.root_str(), None, None).await.is_err());
}

#[tokio::test]
async fn search_substring_matches_filename() {
    let fx = FsFixture::new();
    fx.write("src/main.rs", "");
    fx.write("src/lib.rs", "");
    fx.write("docs/main.md", "");

    let res = search_paths(fx.root_str(), "main".into(), None, None, None)
        .await
        .expect("search");
    let rels: Vec<&str> = res.hits.iter().map(|h| h.rel.as_str()).collect();
    assert!(rels.contains(&"src/main.rs"));
    assert!(rels.contains(&"docs/main.md"));
    assert!(!rels.contains(&"src/lib.rs"));
}

#[tokio::test]
async fn search_is_case_insensitive() {
    let fx = FsFixture::new();
    fx.write("README.md", "");
    let res = search_paths(fx.root_str(), "readme".into(), None, None, None)
        .await
        .expect("search");
    assert_eq!(res.hits.len(), 1);
}

#[tokio::test]
async fn search_empty_query_returns_empty() {
    let fx = FsFixture::new();
    fx.write("a.txt", "");
    let res = search_paths(fx.root_str(), "   ".into(), None, None, None)
        .await
        .expect("search");
    assert!(res.hits.is_empty());
    assert!(!res.truncated);
}

#[tokio::test]
async fn search_prunes_node_modules() {
    let fx = FsFixture::new();
    fx.write("node_modules/lodash/index.js", "");
    fx.write("src/index.js", "");

    let res = search_paths(fx.root_str(), "index".into(), None, None, None)
        .await
        .expect("search");
    let rels: Vec<&str> = res.hits.iter().map(|h| h.rel.as_str()).collect();
    assert!(rels.iter().any(|r| r.starts_with("src/")));
    assert!(!rels.iter().any(|r| r.starts_with("node_modules")));
}

#[tokio::test]
async fn search_ranks_filename_hits_before_path_hits() {
    let fx = FsFixture::new();
    fx.write("zeta/inner.txt", "");
    fx.write("beta/zeta.txt", "");

    let res = search_paths(fx.root_str(), "zeta".into(), None, None, None)
        .await
        .expect("search");
    let zeta_file = res
        .hits
        .iter()
        .position(|h| h.rel == "beta/zeta.txt")
        .expect("file hit");
    let inner_file = res
        .hits
        .iter()
        .position(|h| h.rel == "zeta/inner.txt")
        .expect("path-only hit");
    assert!(
        zeta_file < inner_file,
        "filename hit should rank before path-only hit",
    );
}

#[tokio::test]
async fn read_dir_orders_dirs_before_files_then_alpha() {
    let fx = FsFixture::new();
    fx.mkdir("zdir");
    fx.mkdir("adir");
    fx.write("zfile.txt", "");
    fx.write("afile.txt", "");

    let entries = fs_read_dir(fx.root_str(), false, None, None)
        .await
        .expect("read_dir");
    let names: Vec<&str> = entries.iter().map(|e| e.name.as_str()).collect();
    assert_eq!(names, vec!["adir", "zdir", "afile.txt", "zfile.txt"]);
    assert!(matches!(entries[0].kind, EntryKind::Dir));
    assert!(matches!(entries[2].kind, EntryKind::File));
}

#[tokio::test]
async fn read_dir_hides_dotfiles_by_default() {
    let fx = FsFixture::new();
    fx.write(".secret", "");
    fx.write("visible.txt", "");

    let hidden_off = fs_read_dir(fx.root_str(), false, None, None)
        .await
        .expect("read_dir");
    let names: Vec<&str> = hidden_off.iter().map(|e| e.name.as_str()).collect();
    assert_eq!(names, vec!["visible.txt"]);

    let hidden_on = fs_read_dir(fx.root_str(), true, None, None)
        .await
        .expect("read_dir");
    let names: Vec<&str> = hidden_on.iter().map(|e| e.name.as_str()).collect();
    assert!(names.contains(&".secret"));
}

#[tokio::test]
async fn read_dir_flags_gitignored_entries_only_when_requested() {
    let fx = FsFixture::new();
    match Command::new("git")
        .args(["init", "-q"])
        .current_dir(&fx.root)
        .status()
    {
        Ok(status) => assert!(status.success(), "git init failed"),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return,
        Err(err) => panic!("git init failed: {err}"),
    }
    fx.write(".gitignore", "ignored.txt\nbuild/\n");
    fx.write("kept.txt", "");
    fx.write("ignored.txt", "");
    fx.write("build/out.o", "");

    let entries = fs_read_dir(fx.root_str(), false, Some(true), None)
        .await
        .expect("read_dir");
    let flag = |name: &str| {
        entries
            .iter()
            .find(|e| e.name == name)
            .unwrap_or_else(|| panic!("{name} missing"))
            .gitignored
    };
    assert!(!flag("kept.txt"));
    assert!(flag("ignored.txt"));
    assert!(flag("build"));

    let plain = fs_read_dir(fx.root_str(), false, None, None)
        .await
        .expect("read_dir");
    assert!(plain.iter().all(|e| !e.gitignored));
}

#[tokio::test]
async fn read_dir_skips_gitignore_outside_a_repo() {
    let fx = FsFixture::new();
    fx.write(".gitignore", "ignored.txt\n");
    fx.write("ignored.txt", "");
    fx.write("kept.txt", "");
    let entries = fs_read_dir(fx.root_str(), false, Some(true), None)
        .await
        .expect("read_dir");
    assert!(entries.iter().all(|e| !e.gitignored));
}

#[tokio::test]
async fn read_dir_returns_size_for_files() {
    let fx = FsFixture::new();
    fx.write("known.txt", "abcdef");

    let entries = fs_read_dir(fx.root_str(), false, None, None)
        .await
        .expect("read_dir");
    let entry = entries.iter().find(|e| e.name == "known.txt").unwrap();
    assert_eq!(entry.size, 6);
    assert!(matches!(entry.kind, EntryKind::File));
}

#[tokio::test]
async fn list_subdirs_returns_only_directories() {
    let fx = FsFixture::new();
    fx.mkdir("dir_a");
    fx.mkdir("dir_b");
    fx.write("not_a_dir.txt", "");

    let dirs = list_subdirs(fx.root_str(), false, None)
        .await
        .expect("list_subdirs");
    assert_eq!(dirs, vec!["dir_a", "dir_b"]);
}

#[tokio::test]
async fn list_subdirs_hides_dot_dirs_by_default() {
    let fx = FsFixture::new();
    fx.mkdir(".hidden");
    fx.mkdir("visible");

    let off = list_subdirs(fx.root_str(), false, None)
        .await
        .expect("list_subdirs");
    assert_eq!(off, vec!["visible"]);

    let on = list_subdirs(fx.root_str(), true, None)
        .await
        .expect("list_subdirs");
    assert!(on.contains(&".hidden".to_string()));
}
