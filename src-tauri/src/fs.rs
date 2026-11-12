//! Filesystem IPC (Task 09): lazy tree listing joined with Git status, read/write with an
//! optimistic-concurrency mtime guard, create, rename, delete-to-Trash, and Reveal in Finder.
//! Every path is resolved and refused if it escapes the active worktree or points under `.git/`
//! (reusing the M1 `diff::validate_file_path` / `diff::ensure_path_stays_in_worktree` validator).
use crate::{
    diff,
    error::{AppError, ErrorKind},
    oplog, status,
    store::Store,
};
use git2::Repository;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::{
    collections::HashMap,
    fs,
    io::Write as _,
    path::{Path, PathBuf},
    time::UNIX_EPOCH,
};

const SNIFF_BYTES: usize = 8192;
/// I8: `fs_read` loads the whole file into memory and ships it to the WebView as a JSON number
/// array (several times its on-disk size). Cap it so a huge log or lockfile can't freeze the
/// webview or blow the §9 memory budget.
const MAX_READ_BYTES: u64 = 10 * 1024 * 1024;

#[derive(Debug, Clone, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct FsTreeOptions {
    pub path: String,
    pub show_ignored: bool,
    pub include_status: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct FsEntry {
    pub name: String,
    pub is_dir: bool,
    pub status: Option<String>,
    pub size: u64,
    pub mtime: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct FsTree {
    pub entries: Vec<FsEntry>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, specta::Type)]
pub enum FsEncoding {
    #[serde(rename = "utf-8")]
    Utf8,
    #[serde(rename = "utf-16")]
    Utf16,
    #[serde(rename = "binary")]
    Binary,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, specta::Type)]
pub enum FsEol {
    #[serde(rename = "LF")]
    Lf,
    #[serde(rename = "CRLF")]
    Crlf,
    #[serde(rename = "MIXED")]
    Mixed,
}

#[derive(Debug, Clone, PartialEq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct FsReadResult {
    pub bytes: Vec<u8>,
    pub encoding: FsEncoding,
    pub eol: FsEol,
    pub mtime: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "lowercase")]
pub enum FsEntryKind {
    File,
    Folder,
}

fn open_worktree(worktree_path: &Path) -> Result<(PathBuf, Repository), AppError> {
    let root = worktree_path
        .canonicalize()
        .map_err(|error| AppError::io(format!("Cannot resolve worktree path: {error}")))?;
    let repository = Repository::open(&root)
        .map_err(|error| AppError::not_a_repo(format!("Invalid worktree: {error}")))?;
    Ok((root, repository))
}

/// Resolves a repository-relative path (file or directory, existing or not) and refuses one
/// that escapes `root`, targets `.git/`, or aliases into the gitdir through a symlink. `path`
/// may be empty only when `allow_root` is set, meaning "the worktree root itself".
///
/// `follow_leaf` picks which shared validator runs: `true` for anything that reads or writes
/// through the leaf's resolved target (`fs_read`, `fs_write`, `fs_create`, `fs_rename`'s `to`,
/// `fs_tree`, `reveal_in_finder`); `false` for operations that treat the leaf as an opaque entry
/// instead — `fs_delete` and `fs_rename`'s `from` act on the link itself (`trash`/`rename(2)`
/// don't follow it), so a dangling or `.git`-aliasing leaf symlink must not be refused there.
fn resolve_relative(
    root: &Path,
    path: &str,
    allow_root: bool,
    follow_leaf: bool,
    repository: &Repository,
) -> Result<PathBuf, AppError> {
    if path.is_empty() && allow_root {
        return Ok(root.to_path_buf());
    }
    let relative = diff::validate_file_path(path)?;
    if follow_leaf {
        diff::ensure_path_stays_in_worktree(root, &relative, repository)?;
    } else {
        diff::ensure_leaf_parent_stays_in_worktree(root, &relative, repository)?;
    }
    Ok(root.join(relative))
}

fn path_text(root: &Path, full: &Path) -> Result<String, AppError> {
    full.strip_prefix(root)
        .unwrap_or(full)
        .to_str()
        .ok_or_else(|| AppError::validation("Repository path is not valid UTF-8"))
        .map(str::to_owned)
}

/// Millisecond-precision mtime (not whole seconds): same-second external edits must still be
/// detected by the optimistic-concurrency guard in `write()`. Milliseconds since the Unix epoch
/// fit well within `u64`/JS `Number` precision (2^53) for any real-world file date.
fn mtime_millis(metadata: &fs::Metadata) -> Result<u64, AppError> {
    let modified = metadata
        .modified()
        .map_err(|error| AppError::io(format!("Cannot read modification time: {error}")))?;
    let elapsed = modified
        .duration_since(UNIX_EPOCH)
        .map_err(|_| AppError::internal("File modification time predates the Unix epoch"))?;
    Ok(elapsed.as_millis() as u64)
}

/// Builds the file-status map for callers that request status with their tree.
fn status_map(root: &Path) -> Result<HashMap<String, String>, AppError> {
    let summary = status::read(root)?;
    let mut map = HashMap::new();
    for entry in &summary.unstaged {
        if !entry.worktree_status.is_empty() {
            map.insert(entry.path.clone(), entry.worktree_status.clone());
        }
    }
    for entry in &summary.staged {
        if !entry.index_status.is_empty() {
            map.entry(entry.path.clone())
                .or_insert_with(|| entry.index_status.clone());
        }
    }
    Ok(map)
}

pub(crate) fn tree(worktree_path: &Path, options: &FsTreeOptions) -> Result<FsTree, AppError> {
    let (root, repository) = open_worktree(worktree_path)?;
    let dir = resolve_relative(&root, &options.path, true, true, &repository)?;
    let metadata = fs::metadata(&dir)
        .map_err(|error| AppError::io(format!("Cannot read directory: {error}")))?;
    if !metadata.is_dir() {
        return Err(AppError::validation("fs_tree path must be a directory"));
    }
    let at_root = dir == root;
    let statuses = if options.include_status {
        Some(status_map(&root)?)
    } else {
        None
    };
    let mut entries = Vec::new();
    for item in fs::read_dir(&dir)
        .map_err(|error| AppError::io(format!("Cannot list directory: {error}")))?
    {
        let item =
            item.map_err(|error| AppError::io(format!("Cannot read directory entry: {error}")))?;
        let name = item.file_name().to_string_lossy().into_owned();
        if at_root && name.eq_ignore_ascii_case(".git") {
            continue;
        }
        let file_type = item
            .file_type()
            .map_err(|error| AppError::io(format!("Cannot inspect directory entry: {error}")))?;
        let is_dir = file_type.is_dir();
        let relative = path_text(&root, &item.path())?;
        if !options.show_ignored {
            let ignore_candidate = if is_dir {
                format!("{relative}/")
            } else {
                relative.clone()
            };
            if repository
                .is_path_ignored(ignore_candidate)
                .map_err(AppError::from)?
            {
                continue;
            }
        }
        let item_metadata = item
            .metadata()
            .map_err(|error| AppError::io(format!("Cannot stat directory entry: {error}")))?;
        let size = if is_dir { 0 } else { item_metadata.len() };
        let mtime = mtime_millis(&item_metadata)?;
        entries.push(FsEntry {
            name,
            is_dir,
            status: if is_dir {
                None
            } else {
                statuses.as_ref().and_then(|map| map.get(&relative).cloned())
            },
            size,
            mtime,
        });
    }
    entries.sort_by(|a, b| match b.is_dir.cmp(&a.is_dir) {
        std::cmp::Ordering::Equal => a.name.cmp(&b.name),
        ordering => ordering,
    });
    Ok(FsTree { entries })
}

/// NUL in the first 8 KiB, or a UTF-8 sniff failure, marks the file binary and truncates the
/// returned bytes to that same 8 KiB window (clients render a summary, not the content).
// ponytail: UTF-16 EOL detection would need to decode 2-byte units; no AC requires it, so
// UTF-16 files report `Lf` as a placeholder. Revisit if the editor (Task 11) needs real EOL
// info for UTF-16 files.
fn sniff(bytes: &[u8]) -> (FsEncoding, FsEol, Vec<u8>) {
    let sniff_len = bytes.len().min(SNIFF_BYTES);
    let head = &bytes[..sniff_len];
    if head.contains(&0) {
        return (FsEncoding::Binary, FsEol::Lf, head.to_vec());
    }
    if bytes.starts_with(&[0xFF, 0xFE]) || bytes.starts_with(&[0xFE, 0xFF]) {
        return (FsEncoding::Utf16, FsEol::Lf, bytes.to_vec());
    }
    match std::str::from_utf8(bytes) {
        Ok(text) => (FsEncoding::Utf8, detect_eol(text), bytes.to_vec()),
        Err(_) => (FsEncoding::Binary, FsEol::Lf, head.to_vec()),
    }
}

fn detect_eol(text: &str) -> FsEol {
    let has_crlf = text.contains("\r\n");
    let has_bare_lf = text.replace("\r\n", "").contains('\n');
    match (has_crlf, has_bare_lf) {
        (true, true) => FsEol::Mixed,
        (true, false) => FsEol::Crlf,
        _ => FsEol::Lf,
    }
}

pub(crate) fn read(worktree_path: &Path, path: &str) -> Result<FsReadResult, AppError> {
    let (root, repository) = open_worktree(worktree_path)?;
    let full = resolve_relative(&root, path, false, true, &repository)?;
    let metadata =
        fs::metadata(&full).map_err(|error| AppError::io(format!("Cannot read file: {error}")))?;
    if !metadata.is_file() {
        return Err(AppError::validation(
            "fs_read path must be a regular file, not a directory, FIFO, socket, or device",
        ));
    }
    if metadata.len() > MAX_READ_BYTES {
        return Err(AppError::validation(format!(
            "File is too large to open ({} MB, limit {} MB)",
            metadata.len() / (1024 * 1024),
            MAX_READ_BYTES / (1024 * 1024)
        )));
    }
    let bytes =
        fs::read(&full).map_err(|error| AppError::io(format!("Cannot read file: {error}")))?;
    let mtime = mtime_millis(&metadata)?;
    let (encoding, eol, bytes) = sniff(&bytes);
    Ok(FsReadResult {
        bytes,
        encoding,
        eol,
        mtime,
    })
}

/// Overwrites an existing file without truncating it in place: write the new bytes to a sibling
/// temp file, then `rename` over the target. A crash or a reader mid-write sees either the old
/// file intact or the new one in full, never a half-written one.
fn atomic_overwrite(full: &Path, bytes: &[u8]) -> Result<(), AppError> {
    let parent = full
        .parent()
        .ok_or_else(|| AppError::internal("File has no parent directory"))?;
    let name = full
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| AppError::validation("Repository path is not valid UTF-8"))?;
    // `create_new` (O_CREAT|O_EXCL) refuses an existing entry, including a planted symlink, so the
    // temp file is always one we just created inside the worktree. Retry on a name collision.
    let mut created = None;
    for attempt in 0..8u32 {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|elapsed| elapsed.subsec_nanos())
            .unwrap_or(0);
        let candidate = parent.join(format!(
            ".{name}.bwtmp{}-{nanos:x}-{attempt}",
            std::process::id()
        ));
        match fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&candidate)
        {
            Ok(file) => {
                created = Some((candidate, file));
                break;
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(AppError::io(format!("Cannot write file: {error}"))),
        }
    }
    let (temp_path, mut file) =
        created.ok_or_else(|| AppError::io("Cannot write file: no free temporary name"))?;
    // Keep the original mode (e.g. 0600 on `.env`) instead of the umask default.
    let permissions = fs::metadata(full).map(|metadata| metadata.permissions());
    // Set the mode before writing so the bytes are never readable under a looser mode.
    let write_result = match permissions {
        Ok(permissions) => file.set_permissions(permissions),
        Err(_) => Ok(()),
    }
    .and_then(|()| file.write_all(bytes));
    drop(file);
    if let Err(error) = write_result {
        let _ = fs::remove_file(&temp_path);
        return Err(AppError::io(format!("Cannot write file: {error}")));
    }
    fs::rename(&temp_path, full).map_err(|error| {
        let _ = fs::remove_file(&temp_path);
        AppError::io(format!("Cannot write file: {error}"))
    })
}

pub(crate) fn write(
    store: &Store,
    worktree_path: &Path,
    path: &str,
    bytes: Vec<u8>,
    expected_mtime: u64,
) -> Result<u64, AppError> {
    let (root, repository) = open_worktree(worktree_path)?;
    let full = resolve_relative(&root, path, false, true, &repository)?;
    let previous = match fs::metadata(&full) {
        Ok(metadata) => {
            if !metadata.is_file() {
                return Err(AppError::validation("fs_write path must be a regular file"));
            }
            if mtime_millis(&metadata)? != expected_mtime {
                return Err(AppError::new(
                    ErrorKind::Conflict,
                    "The file changed on disk since it was last read",
                ));
            }
            Some(
                fs::read(&full)
                    .map_err(|error| AppError::io(format!("Cannot read file: {error}")))?,
            )
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            if expected_mtime != 0 {
                return Err(AppError::new(
                    ErrorKind::Conflict,
                    "The file was deleted on disk since it was last read",
                ));
            }
            None
        }
        Err(error) => return Err(AppError::io(format!("Cannot inspect file: {error}"))),
    };
    let text = path_text(&root, &full)?;
    let record_id = oplog::record(
        store,
        "fsWrite",
        &root,
        &text,
        json!({ "previousBytes": previous }),
    )?;
    if let Some(parent) = full.parent() {
        fs::create_dir_all(parent).map_err(|error| {
            oplog::remove_failed_record(
                store,
                record_id,
                AppError::io(format!("Cannot create parent directory: {error}")),
            )
        })?;
    }
    if previous.is_none() {
        // New-file branch: O_EXCL via `create_new` so this never silently follows a symlink
        // (dangling or otherwise) a TOCTOU race or a tracked symlink left at this exact path —
        // it fails instead of writing through it.
        let mut file = fs::File::options()
            .write(true)
            .create_new(true)
            .open(&full)
            .map_err(|error| {
                oplog::remove_failed_record(
                    store,
                    record_id,
                    AppError::io(format!("Cannot create file: {error}")),
                )
            })?;
        file.write_all(&bytes)
            .map_err(|error| AppError::io(format!("Cannot write file: {error}")))?;
    } else {
        // S3-L2: overwrite via a temp file in the same directory + `rename`, not `fs::write`'s
        // truncate-in-place, so a crash or a reader mid-write never sees a half-written file.
        // Write through an in-worktree symlink to its target (like `fs::write` did) instead of
        // replacing the link with a regular file. The target was already checked to stay inside
        // the worktree by `resolve_relative(.., follow_leaf: true, ..)`; re-check after resolving.
        let target = fs::canonicalize(&full).map_err(|error| {
            oplog::remove_failed_record(
                store,
                record_id,
                AppError::io(format!("Cannot resolve file: {error}")),
            )
        })?;
        let canonical_root = fs::canonicalize(&root).map_err(|error| {
            oplog::remove_failed_record(
                store,
                record_id,
                AppError::io(format!("Cannot resolve worktree: {error}")),
            )
        })?;
        if !target.starts_with(&canonical_root) {
            return Err(oplog::remove_failed_record(
                store,
                record_id,
                AppError::validation("Path escapes the worktree"),
            ));
        }
        if let Err(error) = atomic_overwrite(&target, &bytes) {
            return Err(oplog::remove_failed_record(store, record_id, error));
        }
    }
    let metadata = fs::metadata(&full)
        .map_err(|error| AppError::io(format!("Cannot stat written file: {error}")))?;
    mtime_millis(&metadata)
}

pub(crate) fn create(
    store: &Store,
    worktree_path: &Path,
    path: &str,
    kind: FsEntryKind,
) -> Result<(), AppError> {
    let (root, repository) = open_worktree(worktree_path)?;
    let full = resolve_relative(&root, path, false, true, &repository)?;
    if fs::symlink_metadata(&full).is_ok() {
        return Err(AppError::validation(
            "A file or folder already exists at that path",
        ));
    }
    let text = path_text(&root, &full)?;
    let record_id = oplog::record(store, "fsCreate", &root, &text, json!({ "kind": kind }))?;
    let result = match kind {
        FsEntryKind::File => fs::File::create_new(&full)
            .map(|_| ())
            .map_err(|error| AppError::io(format!("Cannot create file: {error}"))),
        FsEntryKind::Folder => fs::create_dir(&full)
            .map_err(|error| AppError::io(format!("Cannot create folder: {error}"))),
    };
    if let Err(error) = result {
        return Err(oplog::remove_failed_record(store, record_id, error));
    }
    Ok(())
}

pub(crate) fn rename(
    store: &Store,
    worktree_path: &Path,
    from: &str,
    to: &str,
) -> Result<(), AppError> {
    let (root, repository) = open_worktree(worktree_path)?;
    // `rename(2)` acts on the `from` entry itself without following a leaf symlink, so a
    // dangling or `.git`-aliasing `from` must not be refused; `to` must not already exist and
    // keeps the full validator.
    let from_full = resolve_relative(&root, from, false, false, &repository)?;
    let to_full = resolve_relative(&root, to, false, true, &repository)?;
    if fs::symlink_metadata(&from_full).is_err() {
        return Err(AppError::not_found("Rename source does not exist"));
    }
    if fs::symlink_metadata(&to_full).is_ok() {
        return Err(AppError::validation(
            "A file or folder already exists at the rename destination",
        ));
    }
    let from_text = path_text(&root, &from_full)?;
    let to_text = path_text(&root, &to_full)?;
    // The payload is the inverse rename: an undo step replays it directly as `rename(from, to)`
    // without having to know to swap fields first.
    let record_id = oplog::record(
        store,
        "fsRename",
        &root,
        &from_text,
        json!({ "from": to_text, "to": from_text }),
    )?;
    if let Err(error) = fs::rename(&from_full, &to_full) {
        return Err(oplog::remove_failed_record(
            store,
            record_id,
            AppError::io(format!("Cannot rename: {error}")),
        ));
    }
    Ok(())
}

pub(crate) fn delete(store: &Store, worktree_path: &Path, path: &str) -> Result<(), AppError> {
    delete_with(store, worktree_path, path, |target| {
        trash::delete(target)
            .map_err(|error| AppError::io(format!("Could not move to Trash: {error}")))
    })
}

/// The actual Trash call goes through this seam so tests can assert the invocation shape
/// (which path it moves) without touching the real macOS Trash.
fn delete_with(
    store: &Store,
    worktree_path: &Path,
    path: &str,
    trash_fn: impl FnOnce(&Path) -> Result<(), AppError>,
) -> Result<(), AppError> {
    let (root, repository) = open_worktree(worktree_path)?;
    // `trash` moves the leaf entry itself without following it (a symlink is trashed, not its
    // target), so a dangling or `.git`-aliasing leaf symlink must not be refused here.
    let full = resolve_relative(&root, path, false, false, &repository)?;
    if fs::symlink_metadata(&full).is_err() {
        return Err(AppError::not_found("Path does not exist"));
    }
    let text = path_text(&root, &full)?;
    let payload = oplog::delete_payload(Path::new(&text), &full)?;
    let record_id = oplog::record(store, "delete_to_trash", &root, &text, payload)?;
    if let Err(error) = trash_fn(&full) {
        return Err(oplog::remove_failed_record(store, record_id, error));
    }
    Ok(())
}

/// Bound to a worktree like every other fs command (an empty `path` reveals the worktree root
/// itself) so it runs through the same `resolve_relative` validator — no free-standing
/// absolute-path parameter that would let the WebView probe for the existence of arbitrary
/// files on disk.
pub(crate) fn reveal_in_finder(worktree_path: &Path, path: &str) -> Result<(), AppError> {
    let (root, repository) = open_worktree(worktree_path)?;
    let full = resolve_relative(&root, path, true, true, &repository)?;
    let text = full
        .to_str()
        .ok_or_else(|| AppError::validation("Path is not valid UTF-8"))?;
    let status = std::process::Command::new("open")
        .args(["-R", text])
        .status()
        .map_err(|error| AppError::io(format!("Could not launch Finder: {error}")))?;
    if !status.success() {
        return Err(AppError::io("Finder reveal command exited with an error"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use git2::Signature;
    use std::sync::{
        OnceLock,
        atomic::{AtomicUsize, Ordering},
    };

    static NEXT_DIR: AtomicUsize = AtomicUsize::new(0);
    static STORE: OnceLock<Store> = OnceLock::new();

    fn test_store() -> &'static Store {
        STORE.get_or_init(|| Store::in_memory().unwrap())
    }

    struct TestDir(PathBuf);

    impl TestDir {
        fn new() -> Self {
            let id = NEXT_DIR.fetch_add(1, Ordering::Relaxed);
            let path =
                std::env::temp_dir().join(format!("branchwork-m2-fs-{}-{id}", std::process::id()));
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
        let mut index = repository.index().unwrap();
        for (name, contents) in files {
            fs::write(path.join(name), contents).unwrap();
            index.add_path(Path::new(name)).unwrap();
        }
        let tree_id = index.write_tree().unwrap();
        index.write().unwrap();
        let tree = repository.find_tree(tree_id).unwrap();
        if !files.is_empty() {
            let signature = Signature::now("Branchwork test", "test@example.com").unwrap();
            repository
                .commit(Some("HEAD"), &signature, &signature, "initial", &tree, &[])
                .unwrap();
        }
        drop(tree);
        repository
    }

    fn root_options(show_ignored: bool) -> FsTreeOptions {
        FsTreeOptions {
            path: String::new(),
            show_ignored,
            include_status: true,
        }
    }

    #[test]
    fn lists_the_worktree_root_joining_status_and_hides_git_metadata() {
        let temp = TestDir::new();
        let _repository = init_repository(&temp.0, &[("tracked.txt", b"clean\n")]);
        fs::write(temp.0.join("tracked.txt"), b"dirty\n").unwrap();
        fs::write(temp.0.join("untracked.txt"), b"new\n").unwrap();
        fs::create_dir(temp.0.join("subdir")).unwrap();

        let listing = tree(&temp.0, &root_options(false)).unwrap();
        let names: Vec<&str> = listing.entries.iter().map(|e| e.name.as_str()).collect();
        assert!(!names.contains(&".git"));
        assert!(names.contains(&"subdir"));

        let tracked = listing
            .entries
            .iter()
            .find(|e| e.name == "tracked.txt")
            .unwrap();
        assert_eq!(tracked.status.as_deref(), Some("M"));
        assert!(!tracked.is_dir);

        let untracked = listing
            .entries
            .iter()
            .find(|e| e.name == "untracked.txt")
            .unwrap();
        assert_eq!(untracked.status.as_deref(), Some("?"));
    }

    #[test]
    fn show_ignored_toggle_hides_or_reveals_ignored_entries() {
        let temp = TestDir::new();
        let _repository = init_repository(&temp.0, &[]);
        fs::write(temp.0.join(".gitignore"), b"ignored.txt\n").unwrap();
        fs::write(temp.0.join("ignored.txt"), b"skip me\n").unwrap();

        let hidden = tree(&temp.0, &root_options(false)).unwrap();
        assert!(!hidden.entries.iter().any(|e| e.name == "ignored.txt"));

        let shown = tree(&temp.0, &root_options(true)).unwrap();
        assert!(shown.entries.iter().any(|e| e.name == "ignored.txt"));
    }

    #[test]
    fn reads_and_writes_a_file_round_trip_and_rejects_a_stale_mtime() {
        let temp = TestDir::new();
        let _repository = init_repository(&temp.0, &[("file.txt", b"before\n")]);

        let first = read(&temp.0, "file.txt").unwrap();
        assert_eq!(first.bytes, b"before\n");
        assert_eq!(first.encoding, FsEncoding::Utf8);
        assert_eq!(first.eol, FsEol::Lf);

        let new_mtime = write(
            test_store(),
            &temp.0,
            "file.txt",
            b"after\n".to_vec(),
            first.mtime,
        )
        .unwrap();
        assert_eq!(fs::read(temp.0.join("file.txt")).unwrap(), b"after\n");
        assert!(
            oplog::entries_for(test_store(), &temp.0.canonicalize().unwrap())
                .iter()
                .any(|entry| entry.operation == "fsWrite")
        );

        // Stale guard: writing with a wrong mtime is a conflict, and the file on disk is
        // untouched. Pick a value guaranteed to differ from the real current mtime rather than
        // relying on timing.
        let wrong_mtime = new_mtime.wrapping_add(1);
        let error = write(
            test_store(),
            &temp.0,
            "file.txt",
            b"conflict\n".to_vec(),
            wrong_mtime,
        )
        .unwrap_err();
        assert_eq!(error.kind, ErrorKind::Conflict);
        assert_eq!(fs::read(temp.0.join("file.txt")).unwrap(), b"after\n");

        // The fresh mtime from the successful write is accepted.
        write(
            test_store(),
            &temp.0,
            "file.txt",
            b"final\n".to_vec(),
            new_mtime,
        )
        .unwrap();
        assert_eq!(fs::read(temp.0.join("file.txt")).unwrap(), b"final\n");
    }

    #[test]
    fn creates_a_file_and_a_folder_but_refuses_an_existing_path() {
        let temp = TestDir::new();
        let _repository = init_repository(&temp.0, &[]);

        create(test_store(), &temp.0, "new.txt", FsEntryKind::File).unwrap();
        assert!(temp.0.join("new.txt").is_file());
        create(test_store(), &temp.0, "new-dir", FsEntryKind::Folder).unwrap();
        assert!(temp.0.join("new-dir").is_dir());

        let error = create(test_store(), &temp.0, "new.txt", FsEntryKind::File).unwrap_err();
        assert_eq!(error.kind, ErrorKind::Validation);
        assert!(
            oplog::entries_for(test_store(), &temp.0.canonicalize().unwrap())
                .iter()
                .filter(|entry| entry.operation == "fsCreate")
                .count()
                >= 2
        );
    }

    #[test]
    fn failed_filesystem_mutations_remove_their_oplog_records() {
        let temp = TestDir::new();
        let store = Store::in_memory().unwrap();
        let _repository = init_repository(
            &temp.0,
            &[("blocked.txt", b"file\n"), ("old.txt", b"old\n")],
        );
        let root = temp.0.canonicalize().unwrap();
        let root_text = root.to_str().unwrap();

        assert_eq!(
            create(&store, &temp.0, "missing/new.txt", FsEntryKind::File)
                .unwrap_err()
                .kind,
            ErrorKind::Io
        );
        assert!(store.latest_oplog(root_text).unwrap().is_none());

        assert_eq!(
            rename(&store, &temp.0, "old.txt", "missing/new.txt")
                .unwrap_err()
                .kind,
            ErrorKind::Io
        );
        assert!(store.latest_oplog(root_text).unwrap().is_none());

        assert_eq!(
            write(
                &store,
                &temp.0,
                "blocked.txt/child.txt",
                b"content".to_vec(),
                0,
            )
            .unwrap_err()
            .kind,
            ErrorKind::Io
        );
        assert!(store.latest_oplog(root_text).unwrap().is_none());
    }

    #[test]
    fn renames_a_file() {
        let temp = TestDir::new();
        let _repository = init_repository(&temp.0, &[("old.txt", b"contents\n")]);

        rename(test_store(), &temp.0, "old.txt", "new.txt").unwrap();

        assert!(!temp.0.join("old.txt").exists());
        assert_eq!(fs::read(temp.0.join("new.txt")).unwrap(), b"contents\n");
        let entry = oplog::entries_for(test_store(), &temp.0.canonicalize().unwrap())
            .into_iter()
            .find(|entry| entry.operation == "fsRename")
            .unwrap();
        // The payload is the inverse rename (swapped from/to) so a future undo step can replay
        // it directly as `rename(payload.from, payload.to)`.
        assert_eq!(entry.payload["from"], json!("new.txt"));
        assert_eq!(entry.payload["to"], json!("old.txt"));
    }

    #[test]
    fn deletes_by_routing_through_the_trash_seam_without_touching_the_real_trash() {
        let temp = TestDir::new();
        let _repository = init_repository(&temp.0, &[("doomed.txt", b"bye\n")]);
        let full = temp.0.canonicalize().unwrap().join("doomed.txt");

        let mut trashed = None;
        delete_with(test_store(), &temp.0, "doomed.txt", |path| {
            trashed = Some(path.to_path_buf());
            Ok(())
        })
        .unwrap();

        assert_eq!(trashed, Some(full));
        let entry = oplog::entries_for(test_store(), &temp.0.canonicalize().unwrap())
            .into_iter()
            .find(|entry| entry.operation == "delete_to_trash")
            .unwrap();
        assert_eq!(
            entry.payload["absolutePath"],
            json!(
                temp.0
                    .canonicalize()
                    .unwrap()
                    .join("doomed.txt")
                    .to_string_lossy()
            )
        );
    }

    #[test]
    fn failed_trash_operation_removes_its_undo_record() {
        let temp = TestDir::new();
        let store = Store::in_memory().unwrap();
        let _repository = init_repository(&temp.0, &[("doomed.txt", b"bye\n")]);
        let root = temp.0.canonicalize().unwrap();

        assert!(
            delete_with(&store, &temp.0, "doomed.txt", |_| {
                Err(AppError::io("trash failed"))
            })
            .is_err()
        );
        assert_eq!(
            store.latest_oplog_undoable(root.to_str().unwrap()).unwrap(),
            None
        );
        assert!(root.join("doomed.txt").exists());
    }

    #[test]
    fn deletes_a_symlink_alias_to_git_metadata_through_the_trash_seam_leaving_git_untouched() {
        use std::os::unix::fs::symlink;
        let temp = TestDir::new();
        let _repository = init_repository(&temp.0, &[("file.txt", b"content\n")]);
        symlink(".git", temp.0.join("meta")).unwrap();
        let link_path = temp.0.canonicalize().unwrap().join("meta");

        // `trash` moves the leaf entry itself without following it, so the user must be able to
        // trash a malicious `meta -> .git` link from inside the app.
        let mut trashed = None;
        delete_with(test_store(), &temp.0, "meta", |path| {
            trashed = Some(path.to_path_buf());
            Ok(())
        })
        .unwrap();

        assert_eq!(trashed, Some(link_path));
        assert!(temp.0.join(".git").is_dir());
        assert!(temp.0.join(".git/config").is_file());
    }

    #[test]
    fn rejects_paths_that_escape_the_worktree_or_target_git_metadata() {
        let temp = TestDir::new();
        let _repository = init_repository(&temp.0, &[("file.txt", b"content\n")]);

        for path in ["../outside", "/etc/passwd", ".git/config"] {
            assert_eq!(
                read(&temp.0, path).unwrap_err().kind,
                ErrorKind::Validation,
                "path {path} should have been refused"
            );
        }
        assert_eq!(
            tree(
                &temp.0,
                &FsTreeOptions {
                    path: "../outside".into(),
                    show_ignored: false,
                    include_status: true,
                }
            )
            .unwrap_err()
            .kind,
            ErrorKind::Validation
        );
    }

    #[test]
    fn refuses_a_symlink_alias_to_git_metadata() {
        use std::os::unix::fs::symlink;
        let temp = TestDir::new();
        let _repository = init_repository(&temp.0, &[("file.txt", b"content\n")]);
        // A malicious repo can commit a symlink such as `meta -> .git`. Resolving through it
        // must be refused exactly like a literal `.git/...` path would be.
        symlink(".git", temp.0.join("meta")).unwrap();

        assert_eq!(
            read(&temp.0, "meta/config").unwrap_err().kind,
            ErrorKind::Validation
        );
        assert_eq!(
            write(test_store(), &temp.0, "meta/config", b"evil".to_vec(), 0)
                .unwrap_err()
                .kind,
            ErrorKind::Validation
        );
    }

    #[test]
    fn refuses_to_read_a_file_over_the_size_cap() {
        let temp = TestDir::new();
        let _repository = init_repository(&temp.0, &[]);
        // Write a sparse file past the cap without actually allocating 10 MiB of disk I/O.
        let file = fs::File::create(temp.0.join("huge.bin")).unwrap();
        file.set_len(MAX_READ_BYTES + 1).unwrap();
        drop(file);

        let error = read(&temp.0, "huge.bin").unwrap_err();
        assert_eq!(error.kind, ErrorKind::Validation);
    }

    #[test]
    fn refuses_fs_write_through_a_dangling_symlink_and_never_creates_its_target() {
        use std::os::unix::fs::symlink;
        let temp = TestDir::new();
        let _repository = init_repository(&temp.0, &[]);
        let id = NEXT_DIR.fetch_add(1, Ordering::Relaxed);
        let dangling_target = std::env::temp_dir().join(format!(
            "branchwork-m2-fs-dangling-{}-{id}",
            std::process::id()
        ));
        let _ = fs::remove_file(&dangling_target);
        symlink(&dangling_target, temp.0.join("out")).unwrap();

        let error = write(test_store(), &temp.0, "out", b"evil".to_vec(), 0).unwrap_err();

        assert!(!dangling_target.exists());
        // Refused by the validator failing to canonicalize the dangling target, before
        // `fs_write` ever reaches a filesystem write call.
        assert_eq!(error.kind, ErrorKind::Io);
    }

    #[test]
    fn atomic_overwrite_ignores_planted_temp_symlinks_and_keeps_mode() {
        use std::os::unix::fs::{PermissionsExt, symlink};
        let temp = TestDir::new();
        let outside = TestDir::new();
        let victim = outside.0.join("victim");
        fs::write(&victim, b"safe").unwrap();
        let target = temp.0.join("secret.env");
        fs::write(&target, b"old").unwrap();
        fs::set_permissions(&target, fs::Permissions::from_mode(0o600)).unwrap();
        // The pre-fix predictable temp name, planted as a symlink to a file outside the worktree.
        symlink(
            &victim,
            temp.0
                .join(format!(".secret.env.bwtmp{}", std::process::id())),
        )
        .unwrap();

        atomic_overwrite(&target, b"new").unwrap();

        assert_eq!(fs::read(&victim).unwrap(), b"safe");
        let metadata = fs::symlink_metadata(&target).unwrap();
        assert!(metadata.is_file());
        assert_eq!(metadata.permissions().mode() & 0o777, 0o600);
        assert_eq!(fs::read(&target).unwrap(), b"new");
    }

    #[test]
    fn write_through_an_in_worktree_symlink_updates_the_target_and_keeps_the_link() {
        use std::os::unix::fs::symlink;
        let temp = TestDir::new();
        let _repository = init_repository(&temp.0, &[("real.txt", b"old\n")]);
        symlink("real.txt", temp.0.join("alias.txt")).unwrap();
        let mtime = mtime_millis(&fs::metadata(temp.0.join("alias.txt")).unwrap()).unwrap();

        write(test_store(), &temp.0, "alias.txt", b"new\n".to_vec(), mtime).unwrap();

        assert!(
            fs::symlink_metadata(temp.0.join("alias.txt"))
                .unwrap()
                .file_type()
                .is_symlink()
        );
        assert_eq!(fs::read(temp.0.join("real.txt")).unwrap(), b"new\n");
    }
}
