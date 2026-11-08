use crate::error::AppError;
use git2::{Diff, DiffDelta, DiffFlags, DiffOptions, ErrorCode, Oid, Patch, Repository, Tree};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::Read,
    path::{Component, Path, PathBuf},
};

const LARGE_FILE_BYTES: u64 = 1_048_576;
const MAX_INTRA_BYTES: usize = 4_096;
type SpanRange = Option<(u32, u32)>;

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq, specta::Type)]
#[serde(rename_all = "lowercase")]
pub enum DiffArea {
    Staged,
    Unstaged,
    /// Working tree vs HEAD, combining staged and unstaged changes for the file into one diff.
    Head,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq, specta::Type)]
#[serde(rename_all = "lowercase")]
pub enum DiffLineKind {
    Context,
    Add,
    Del,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq, specta::Type)]
#[serde(rename_all = "lowercase")]
pub enum IntraKind {
    Add,
    Del,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct IntraSpan {
    pub start: u32,
    pub end: u32,
    pub kind: IntraKind,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct DiffLine {
    pub kind: DiffLineKind,
    pub old: Option<u32>,
    pub new: Option<u32>,
    pub text: String,
    pub intra: Option<Vec<IntraSpan>>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct Hunk {
    pub old_start: u32,
    pub new_start: u32,
    pub old_lines: u32,
    pub new_lines: u32,
    pub lines: Vec<DiffLine>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct DiffModel {
    pub hunks: Vec<Hunk>,
    pub binary: bool,
    pub truncated: bool,
    pub bytes: u64,
}

impl DiffModel {
    fn empty() -> Self {
        Self {
            hunks: Vec::new(),
            binary: false,
            truncated: false,
            bytes: 0,
        }
    }
}

pub fn read(worktree_path: &Path, file_path: &str, area: DiffArea) -> Result<DiffModel, AppError> {
    let path = validate_file_path(file_path)?;
    if !worktree_path.is_absolute() {
        return Err(AppError::validation("Worktree path must be absolute"));
    }
    let worktree_path = worktree_path
        .canonicalize()
        .map_err(|error| AppError::io(format!("Cannot resolve worktree path: {error}")))?;
    let repository = Repository::open(&worktree_path)
        .map_err(|error| AppError::not_a_repo(format!("Invalid worktree: {error}")))?;
    // Diffing a symlink shows its link text, same as staging — the leaf itself is never
    // resolved, so a dangling or `.git`-aliasing leaf symlink does not block diffing it.
    ensure_leaf_parent_stays_in_worktree(&worktree_path, &path, &repository)?;

    let mut options = DiffOptions::new();
    options
        .patience(true)
        .context_lines(3)
        .interhunk_lines(0)
        .pathspec(&path)
        .disable_pathspec_match(true);
    let diff = match area {
        DiffArea::Staged => {
            let tree = head_tree(&repository)?;
            repository
                .diff_tree_to_index(tree.as_ref(), None, Some(&mut options))
                .map_err(AppError::from)?
        }
        DiffArea::Unstaged => {
            options
                .include_untracked(true)
                .recurse_untracked_dirs(true)
                .show_untracked_content(true);
            repository
                .diff_index_to_workdir(None, Some(&mut options))
                .map_err(AppError::from)?
        }
        DiffArea::Head => {
            let tree = head_tree(&repository)?;
            options
                .include_untracked(true)
                .recurse_untracked_dirs(true)
                .show_untracked_content(true);
            repository
                .diff_tree_to_workdir_with_index(tree.as_ref(), Some(&mut options))
                .map_err(AppError::from)?
        }
    };
    model_from_diff(&repository, &worktree_path, &diff, file_path, area)
}

/// `HEAD`'s tree, or `None` on an unborn/missing branch (brand-new repo with no commits yet) —
/// shared by `Staged` and `Head`, both of which diff against it.
fn head_tree(repository: &Repository) -> Result<Option<Tree<'_>>, AppError> {
    match repository.head() {
        Ok(head) => Ok(Some(head.peel_to_tree().map_err(AppError::from)?)),
        Err(error) if matches!(error.code(), ErrorCode::UnbornBranch | ErrorCode::NotFound) => {
            Ok(None)
        }
        Err(error) => Err(error.into()),
    }
}

/// Resolves `root.join(path)` to its nearest existing ancestor and refuses it if that ancestor
/// (symlinks followed) resolves outside `root`, into a `.git` path component (covers a tracked
/// symlink alias such as `meta -> .git`), or inside the repository's gitdir(s) (covers linked
/// worktrees and submodule gitdirs that don't literally contain a `.git` path segment).
///
/// Walks with `symlink_metadata` rather than `exists()`/`is_file()` so a symlink — including a
/// dangling one whose target was deleted or never existed — counts as "the ancestor" instead of
/// being skipped as "missing". A dangling symlink then fails `canonicalize` and is refused,
/// rather than silently letting the walk continue past it to an unrelated parent directory.
pub(crate) fn ensure_path_stays_in_worktree(
    root: &Path,
    path: &Path,
    repository: &Repository,
) -> Result<(), AppError> {
    let candidate = root.join(path);
    let mut existing = candidate.as_path();
    while fs::symlink_metadata(existing).is_err() {
        existing = existing
            .parent()
            .ok_or_else(|| AppError::validation("Diff path is outside the worktree"))?;
    }
    let resolved = existing
        .canonicalize()
        .map_err(|error| AppError::io(format!("Cannot resolve diff path: {error}")))?;
    if !resolved.starts_with(root) {
        return Err(AppError::validation(
            "Diff path resolves outside the worktree",
        ));
    }
    reject_git_internals(root, &resolved, repository)
}

/// Same boundary and `.git` checks as `ensure_path_stays_in_worktree`, but the leaf itself is
/// never resolved — only its parent directory chain is canonicalized and checked. Use this for
/// operations that treat the leaf as an opaque entry rather than reading through it: index-only
/// writes (stage/unstage/discard, which record a symlink's link text, never its target), diffing
/// (same: a symlink's "content" is its link text), and delete / rename-`from` (the leaf itself
/// is renamed or trashed, not followed). A dangling or `.git`-aliasing leaf symlink is legitimate
/// here — staging a dangling symlink, or trashing a malicious `meta -> .git` link, must work.
///
/// Do **not** use this for anything that reads or writes through the leaf's resolved target
/// (`fs_read`, `fs_write`, `fs_create`, `fs_rename`'s `to`, `fs_tree`, `reveal_in_finder`) — those
/// keep the full `ensure_path_stays_in_worktree` check.
pub(crate) fn ensure_leaf_parent_stays_in_worktree(
    root: &Path,
    path: &Path,
    repository: &Repository,
) -> Result<(), AppError> {
    match path.parent() {
        Some(parent) if !parent.as_os_str().is_empty() => {
            ensure_path_stays_in_worktree(root, parent, repository)
        }
        // The leaf lives directly in `root`, which is already canonical and known-safe.
        _ => Ok(()),
    }
}

fn reject_git_internals(
    root: &Path,
    resolved: &Path,
    repository: &Repository,
) -> Result<(), AppError> {
    let relative = resolved.strip_prefix(root).unwrap_or(resolved);
    let hits_git_component = relative
        .components()
        .any(|component| component.as_os_str().eq_ignore_ascii_case(".git"));
    let gitdir = repository.path().canonicalize().ok();
    let commondir = repository.commondir().canonicalize().ok();
    let inside_gitdir = gitdir
        .as_deref()
        .is_some_and(|dir| resolved.starts_with(dir))
        || commondir
            .as_deref()
            .is_some_and(|dir| resolved.starts_with(dir));
    if hits_git_component || inside_gitdir {
        return Err(AppError::validation(
            "Diff path resolves inside .git and is refused",
        ));
    }
    Ok(())
}

pub(crate) fn validate_file_path(path: &str) -> Result<PathBuf, AppError> {
    // NUL would panic inside git2's pathspec conversion.
    if path.contains('\0') {
        return Err(AppError::validation("Diff path must not contain NUL"));
    }
    let path = Path::new(path);
    if path.as_os_str().is_empty()
        || path.is_absolute()
        || path.components().any(|component| {
            matches!(
                component,
                Component::CurDir
                    | Component::ParentDir
                    | Component::RootDir
                    | Component::Prefix(_)
            )
        })
        || path
            .components()
            .any(|component| component.as_os_str().eq_ignore_ascii_case(".git"))
    {
        return Err(AppError::validation(
            "Diff path must be a repository-relative file outside .git",
        ));
    }
    Ok(path.to_path_buf())
}

fn model_from_diff(
    repository: &Repository,
    worktree_path: &Path,
    diff: &Diff<'_>,
    file_path: &str,
    area: DiffArea,
) -> Result<DiffModel, AppError> {
    let delta_index = diff
        .deltas()
        .position(|delta| delta_matches(&delta, file_path));
    let Some(delta_index) = delta_index else {
        return Ok(DiffModel::empty());
    };
    let delta = diff
        .get_delta(delta_index)
        .ok_or_else(|| AppError::internal("Git diff delta disappeared"))?;
    let bytes = delta_bytes(repository, &delta)?;
    if bytes > LARGE_FILE_BYTES {
        return Ok(DiffModel {
            hunks: Vec::new(),
            binary: false,
            truncated: true,
            bytes,
        });
    }

    let patch = Patch::from_diff(diff, delta_index)
        .map_err(AppError::from)?
        .ok_or_else(|| AppError::internal("Git diff patch is unavailable"))?;
    // Unstaged and Head both end at the workdir file as the "new" side, so it's worth a binary
    // sniff. Staged compares HEAD -> index; the workdir file isn't part of that diff.
    let working_file_binary = matches!(area, DiffArea::Unstaged | DiffArea::Head)
        && working_file_is_binary(worktree_path, file_path)?;
    if delta.flags().contains(DiffFlags::BINARY)
        || blob_is_binary(repository, &delta)?
        || working_file_binary
    {
        return Ok(DiffModel {
            hunks: Vec::new(),
            binary: true,
            truncated: false,
            bytes,
        });
    }
    let hunks = collect_hunks(&patch)?;
    Ok(DiffModel {
        hunks,
        binary: false,
        truncated: false,
        bytes,
    })
}

fn blob_is_binary(repository: &Repository, delta: &DiffDelta<'_>) -> Result<bool, AppError> {
    for oid in [delta.old_file().id(), delta.new_file().id()] {
        if !oid.is_zero() {
            match repository.find_blob(oid) {
                Ok(blob) if blob.is_binary() => return Ok(true),
                Ok(_) => {}
                Err(error) if error.code() == ErrorCode::NotFound => {}
                Err(error) => return Err(error.into()),
            }
        }
    }
    Ok(false)
}

const BINARY_SNIFF_BYTES: usize = 8_000;

fn working_file_is_binary(worktree_path: &Path, file_path: &str) -> Result<bool, AppError> {
    let full_path = worktree_path.join(file_path);
    // symlink_metadata (not stat) so a symlink or FIFO is rejected instead of followed/blocked on.
    let metadata = match fs::symlink_metadata(&full_path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(error) => {
            return Err(AppError::io(format!(
                "Cannot stat file for binary detection: {error}"
            )));
        }
    };
    if !metadata.is_file() || metadata.len() > LARGE_FILE_BYTES {
        return Ok(false);
    }
    let mut file = fs::File::open(&full_path)
        .map_err(|error| AppError::io(format!("Cannot read file for binary detection: {error}")))?;
    let mut buffer = vec![0u8; BINARY_SNIFF_BYTES.min(metadata.len() as usize)];
    file.read_exact(&mut buffer)
        .map_err(|error| AppError::io(format!("Cannot read file for binary detection: {error}")))?;
    Ok(buffer.contains(&0))
}

fn delta_matches(delta: &DiffDelta<'_>, file_path: &str) -> bool {
    [delta.old_file().path(), delta.new_file().path()]
        .into_iter()
        .flatten()
        .any(|path| path == Path::new(file_path))
}

fn delta_bytes(repository: &Repository, delta: &DiffDelta<'_>) -> Result<u64, AppError> {
    let old_size = resolved_file_size(repository, delta.old_file().id(), delta.old_file().size())?;
    let new_size = resolved_file_size(repository, delta.new_file().id(), delta.new_file().size())?;
    Ok(old_size.max(new_size))
}

/// `DiffFile::size()` reports 0 for the tree side of `diff_tree_to_index` (e.g. a staged delete
/// or shrink), which would let an oversized file slip past the 1 MiB gate below. When the
/// reported size is 0 but the side has a real blob, look up its true size from the odb header
/// (no blob content loaded) instead of trusting the reported size.
fn resolved_file_size(repository: &Repository, oid: Oid, reported: u64) -> Result<u64, AppError> {
    if reported > 0 || oid.is_zero() {
        return Ok(reported);
    }
    match repository.odb().and_then(|odb| odb.read_header(oid)) {
        Ok((size, _)) => Ok(size as u64),
        Err(error) if error.code() == ErrorCode::NotFound => Ok(0),
        Err(error) => Err(error.into()),
    }
}

fn collect_hunks(patch: &Patch<'_>) -> Result<Vec<Hunk>, AppError> {
    let mut hunks = Vec::new();
    for hunk_index in 0..patch.num_hunks() {
        let (header, _) = patch.hunk(hunk_index).map_err(AppError::from)?;
        let mut lines = Vec::new();
        for line_index in 0..patch
            .num_lines_in_hunk(hunk_index)
            .map_err(AppError::from)?
        {
            let line = patch
                .line_in_hunk(hunk_index, line_index)
                .map_err(AppError::from)?;
            let Some(kind) = (match line.origin() {
                ' ' => Some(DiffLineKind::Context),
                '+' => Some(DiffLineKind::Add),
                '-' => Some(DiffLineKind::Del),
                _ => None,
            }) else {
                continue;
            };
            let text = String::from_utf8_lossy(line.content());
            lines.push(DiffLine {
                kind,
                old: line.old_lineno(),
                new: line.new_lineno(),
                text: text
                    .trim_end_matches('\n')
                    .trim_end_matches('\r')
                    .to_owned(),
                intra: None,
            });
        }
        add_intraline_spans(&mut lines);
        hunks.push(Hunk {
            old_start: header.old_start(),
            new_start: header.new_start(),
            old_lines: header.old_lines(),
            new_lines: header.new_lines(),
            lines,
        });
    }
    Ok(hunks)
}

fn add_intraline_spans(lines: &mut [DiffLine]) {
    let mut index = 0;
    while index < lines.len() {
        if lines[index].kind != DiffLineKind::Del {
            index += 1;
            continue;
        }
        let delete_start = index;
        while index < lines.len() && lines[index].kind == DiffLineKind::Del {
            index += 1;
        }
        let add_start = index;
        while index < lines.len() && lines[index].kind == DiffLineKind::Add {
            index += 1;
        }
        for offset in 0..(index - add_start).min(add_start - delete_start) {
            let deleted = &lines[delete_start + offset].text;
            let added = &lines[add_start + offset].text;
            if deleted.len() + added.len() >= MAX_INTRA_BYTES {
                continue;
            }
            let (deleted_span, added_span) = changed_spans(deleted, added);
            if let Some((start, end)) = deleted_span {
                lines[delete_start + offset].intra = Some(vec![IntraSpan {
                    start,
                    end,
                    kind: IntraKind::Del,
                }]);
            }
            if let Some((start, end)) = added_span {
                lines[add_start + offset].intra = Some(vec![IntraSpan {
                    start,
                    end,
                    kind: IntraKind::Add,
                }]);
            }
        }
    }
}

fn changed_spans(deleted: &str, added: &str) -> (SpanRange, SpanRange) {
    let deleted_chars: Vec<_> = deleted.chars().collect();
    let added_chars: Vec<_> = added.chars().collect();
    let prefix = deleted_chars
        .iter()
        .zip(&added_chars)
        .take_while(|(left, right)| left == right)
        .count();
    let max_suffix = deleted_chars.len().min(added_chars.len()) - prefix;
    let suffix = deleted_chars
        .iter()
        .rev()
        .zip(added_chars.iter().rev())
        .take(max_suffix)
        .take_while(|(left, right)| left == right)
        .count();
    let deleted_end = deleted_chars.len() - suffix;
    let added_end = added_chars.len() - suffix;
    (
        (prefix < deleted_end).then(|| {
            (
                utf16_offset(&deleted_chars, prefix),
                utf16_offset(&deleted_chars, deleted_end),
            )
        }),
        (prefix < added_end).then(|| {
            (
                utf16_offset(&added_chars, prefix),
                utf16_offset(&added_chars, added_end),
            )
        }),
    )
}

fn utf16_offset(chars: &[char], index: usize) -> u32 {
    chars[..index]
        .iter()
        .map(|character| character.len_utf16() as u32)
        .sum()
}

#[cfg(test)]
mod tests {
    use super::*;
    use git2::{Repository, Signature};
    use std::sync::atomic::{AtomicUsize, Ordering};

    static NEXT_DIR: AtomicUsize = AtomicUsize::new(0);

    struct TestDir(PathBuf);

    impl TestDir {
        fn new() -> Self {
            let id = NEXT_DIR.fetch_add(1, Ordering::Relaxed);
            let path = std::env::temp_dir()
                .join(format!("branchwork-m2-diff-{}-{id}", std::process::id()));
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }
    }

    impl Drop for TestDir {
        fn drop(&mut self) {
            fs::remove_dir_all(&self.0).unwrap();
        }
    }

    fn init_repository(path: &Path, files: &[(&str, &[u8])]) -> Repository {
        let repository = Repository::init(path).unwrap();
        let signature = Signature::now("Branchwork test", "test@example.com").unwrap();
        let mut index = repository.index().unwrap();
        for (name, contents) in files {
            fs::write(path.join(name), contents).unwrap();
            index.add_path(Path::new(name)).unwrap();
        }
        let tree_id = index.write_tree().unwrap();
        index.write().unwrap();
        let tree = repository.find_tree(tree_id).unwrap();
        repository
            .commit(Some("HEAD"), &signature, &signature, "initial", &tree, &[])
            .unwrap();
        drop(tree);
        repository
    }

    fn find_line(model: &DiffModel, kind: DiffLineKind) -> &DiffLine {
        model
            .hunks
            .iter()
            .flat_map(|hunk| &hunk.lines)
            .find(|line| line.kind == kind)
            .unwrap()
    }

    fn diff(path: &Path, file: &str, area: DiffArea) -> DiffModel {
        read(path, file, area).unwrap()
    }

    #[test]
    fn diffs_modified_added_deleted_and_untracked_files() {
        let dir = TestDir::new();
        let _repository = init_repository(
            &dir.0,
            &[("modified.txt", b"before\n"), ("deleted.txt", b"remove\n")],
        );
        fs::write(dir.0.join("modified.txt"), "after\n").unwrap();
        fs::remove_file(dir.0.join("deleted.txt")).unwrap();
        fs::write(dir.0.join("untracked.txt"), "new\n").unwrap();
        fs::write(dir.0.join("added.txt"), "added\n").unwrap();
        let repository = Repository::open(&dir.0).unwrap();
        let mut index = repository.index().unwrap();
        index.add_path(Path::new("added.txt")).unwrap();
        index.write().unwrap();

        assert_eq!(
            find_line(
                &diff(&dir.0, "modified.txt", DiffArea::Unstaged),
                DiffLineKind::Add
            )
            .text,
            "after"
        );
        assert_eq!(
            find_line(
                &diff(&dir.0, "deleted.txt", DiffArea::Unstaged),
                DiffLineKind::Del
            )
            .text,
            "remove"
        );
        assert_eq!(
            find_line(
                &diff(&dir.0, "added.txt", DiffArea::Staged),
                DiffLineKind::Add
            )
            .text,
            "added"
        );
        assert_eq!(
            find_line(
                &diff(&dir.0, "untracked.txt", DiffArea::Unstaged),
                DiffLineKind::Add
            )
            .text,
            "new"
        );
    }

    #[test]
    fn returns_intraline_spans_for_modified_unicode_lines() {
        let dir = TestDir::new();
        let _repository = init_repository(&dir.0, &[("unicode.txt", "café\n".as_bytes())]);
        fs::write(dir.0.join("unicode.txt"), "café!\n").unwrap();

        let model = diff(&dir.0, "unicode.txt", DiffArea::Unstaged);
        let deleted = find_line(&model, DiffLineKind::Del);
        let added = find_line(&model, DiffLineKind::Add);
        assert_eq!(deleted.intra, None);
        assert_eq!(
            added.intra,
            Some(vec![IntraSpan {
                start: 4,
                end: 5,
                kind: IntraKind::Add,
            }])
        );
    }

    #[test]
    fn short_circuits_binary_and_large_files() {
        let dir = TestDir::new();
        let _repository = init_repository(
            &dir.0,
            &[("binary.bin", b"old\0binary"), ("large.txt", b"old")],
        );
        fs::write(dir.0.join("binary.bin"), b"new\0binary").unwrap();
        fs::write(dir.0.join("large.txt"), vec![b'x'; 1_048_577]).unwrap();

        let binary = diff(&dir.0, "binary.bin", DiffArea::Unstaged);
        assert!(binary.binary);
        assert!(binary.hunks.is_empty());
        let large = diff(&dir.0, "large.txt", DiffArea::Unstaged);
        assert!(large.truncated);
        assert!(large.hunks.is_empty());
        assert_eq!(large.bytes, 1_048_577);
    }

    #[test]
    fn rejects_paths_that_escape_or_target_git_metadata() {
        for path in ["../secret", ".git/config", "/etc/passwd", "", "a\0b"] {
            assert!(validate_file_path(path).is_err(), "{path:?}");
        }
        assert!(validate_file_path("src/main.rs").is_ok());
    }

    #[test]
    fn staged_deletion_of_large_file_is_truncated_not_fully_loaded() {
        let dir = TestDir::new();
        let _repository = init_repository(&dir.0, &[("large.txt", &vec![b'x'; 1_048_577])]);
        let repository = Repository::open(&dir.0).unwrap();
        let mut index = repository.index().unwrap();
        index.remove_path(Path::new("large.txt")).unwrap();
        index.write().unwrap();
        fs::remove_file(dir.0.join("large.txt")).unwrap();

        let model = diff(&dir.0, "large.txt", DiffArea::Staged);
        assert!(model.truncated);
        assert!(model.hunks.is_empty());
        assert_eq!(model.bytes, 1_048_577);
    }

    #[test]
    fn head_diff_combines_staged_and_unstaged_changes_against_head_tree() {
        let dir = TestDir::new();
        let _repository = init_repository(&dir.0, &[("file.txt", b"line1\n")]);
        let repository = Repository::open(&dir.0).unwrap();
        // Stage one change...
        fs::write(dir.0.join("file.txt"), b"line2\n").unwrap();
        let mut index = repository.index().unwrap();
        index.add_path(Path::new("file.txt")).unwrap();
        index.write().unwrap();
        // ...then leave a further unstaged change on top of it.
        fs::write(dir.0.join("file.txt"), b"line3\n").unwrap();

        let model = diff(&dir.0, "file.txt", DiffArea::Head);
        assert_eq!(find_line(&model, DiffLineKind::Del).text, "line1");
        assert_eq!(find_line(&model, DiffLineKind::Add).text, "line3");
    }

    #[test]
    fn staged_diff_ignores_binary_content_left_in_the_working_tree() {
        let dir = TestDir::new();
        let _repository = init_repository(&dir.0, &[("file.txt", b"before\n")]);
        let repository = Repository::open(&dir.0).unwrap();
        fs::write(dir.0.join("file.txt"), b"after\n").unwrap();
        let mut index = repository.index().unwrap();
        index.add_path(Path::new("file.txt")).unwrap();
        index.write().unwrap();
        // Staged change is text; only the working copy (irrelevant to a Staged diff) is binary.
        fs::write(dir.0.join("file.txt"), b"bin\0ary").unwrap();

        let model = diff(&dir.0, "file.txt", DiffArea::Staged);
        assert!(!model.binary);
        assert_eq!(find_line(&model, DiffLineKind::Add).text, "after");
    }

    #[cfg(unix)]
    #[test]
    fn refuses_paths_through_symlinks_outside_the_worktree() {
        use std::os::unix::fs::symlink;
        let dir = TestDir::new();
        let _repository = init_repository(&dir.0, &[("tracked.txt", b"clean\n")]);
        let outside = TestDir::new();
        fs::write(outside.0.join("secret.txt"), "not part of the repository").unwrap();
        symlink(&outside.0, dir.0.join("external")).unwrap();

        let error = read(&dir.0, "external/secret.txt", DiffArea::Unstaged).unwrap_err();
        assert_eq!(error.kind, crate::error::ErrorKind::Validation);
    }
}
