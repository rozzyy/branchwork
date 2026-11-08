use crate::{
    diff::{self, DiffArea, DiffLine, DiffLineKind, DiffModel},
    error::AppError,
    oplog, worktree,
};
use git2::{ErrorCode as GitErrorCode, Index, IndexEntry, Repository};
use serde_json::json;
use std::{
    collections::HashSet,
    ffi::OsStr,
    fs,
    io::Write,
    path::{Path, PathBuf},
    sync::atomic::{AtomicUsize, Ordering},
};

static NEXT_PATCH: AtomicUsize = AtomicUsize::new(0);

struct PatchFile(PathBuf);

impl PatchFile {
    fn create(contents: &str) -> Result<Self, AppError> {
        let id = NEXT_PATCH.fetch_add(1, Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!(
            "branchwork-stage-{}-{id}.patch",
            std::process::id()
        ));
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
            .map_err(|error| AppError::io(format!("Could not create staging patch: {error}")))?;
        if let Err(error) = file.write_all(contents.as_bytes()) {
            drop(file);
            let _ = fs::remove_file(&path);
            return Err(AppError::io(format!(
                "Could not write staging patch: {error}"
            )));
        }
        Ok(Self(path))
    }

    fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for PatchFile {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}

fn open_repository(worktree_path: &Path) -> Result<(PathBuf, Repository), AppError> {
    if !worktree_path.is_absolute() {
        return Err(AppError::validation("Worktree path must be absolute"));
    }
    let root = worktree_path
        .canonicalize()
        .map_err(|error| AppError::io(format!("Cannot resolve worktree path: {error}")))?;
    let repository = Repository::open(&root)
        .map_err(|error| AppError::not_a_repo(format!("Invalid worktree: {error}")))?;
    Ok((root, repository))
}

fn validate_paths(
    root: &Path,
    repository: &Repository,
    paths: &[String],
) -> Result<Vec<PathBuf>, AppError> {
    if paths.is_empty() {
        return Err(AppError::validation(
            "At least one repository-relative path is required",
        ));
    }
    let mut seen = HashSet::new();
    let mut validated = Vec::with_capacity(paths.len());
    for path in paths {
        let relative = diff::validate_file_path(path)?;
        if !seen.insert(relative.clone()) {
            return Err(AppError::validation("Paths must not contain duplicates"));
        }
        // Index-only writes (stage/unstage/discard) record a symlink leaf's link text and never
        // follow it, so a dangling or `.git`-aliasing leaf symlink must not be refused here.
        diff::ensure_leaf_parent_stays_in_worktree(root, &relative, repository)?;
        validated.push(relative);
    }
    Ok(validated)
}

fn previous_index_blob(
    repository: &Repository,
    index: &Index,
    path: &Path,
) -> Result<Option<Vec<u8>>, AppError> {
    let Some(entry) = index.get_path(path, 0) else {
        return Ok(None);
    };
    let blob = repository.find_blob(entry.id)?;
    Ok(Some(blob.content().to_vec()))
}

fn record_index_before(
    repository: &Repository,
    index: &Index,
    worktree: &Path,
    path: &Path,
    operation: &str,
) -> Result<(), AppError> {
    let path_text = path
        .to_str()
        .ok_or_else(|| AppError::validation("Repository path is not valid UTF-8"))?;
    let blob = previous_index_blob(repository, index, path)?;
    oplog::record(
        operation,
        worktree,
        path_text,
        json!({ "previousIndexBlob": blob }),
    )
}

fn remove_index_path(index: &mut Index, path: &Path) -> Result<(), AppError> {
    match index.remove_path(path) {
        Ok(()) => Ok(()),
        Err(error) if error.code() == GitErrorCode::NotFound => Ok(()),
        Err(error) => Err(error.into()),
    }
}

pub(crate) fn stage_paths(worktree_path: &Path, paths: &[String]) -> Result<(), AppError> {
    let (root, repository) = open_repository(worktree_path)?;
    let paths = validate_paths(&root, &repository, paths)?;
    let mut index = repository.index()?;
    for path in &paths {
        record_index_before(&repository, &index, &root, path, "stagePath")?;
    }
    for path in &paths {
        match fs::symlink_metadata(root.join(path)) {
            Ok(metadata) if metadata.is_dir() => {
                return Err(AppError::validation(
                    "Stage paths must name files, not directories",
                ));
            }
            Ok(_) => index.add_path(path)?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                remove_index_path(&mut index, path)?;
            }
            Err(error) => {
                return Err(AppError::io(format!(
                    "Could not inspect staged path: {error}"
                )));
            }
        }
    }
    index.write()?;
    Ok(())
}

fn head_index(repository: &Repository) -> Result<Index, AppError> {
    let mut head_index = Index::new()?;
    match repository.head() {
        Ok(head) => {
            let tree = head.peel_to_tree()?;
            head_index.read_tree(&tree)?;
        }
        Err(error)
            if matches!(
                error.code(),
                GitErrorCode::UnbornBranch | GitErrorCode::NotFound
            ) => {}
        Err(error) => return Err(error.into()),
    }
    Ok(head_index)
}

pub(crate) fn unstage_paths(worktree_path: &Path, paths: &[String]) -> Result<(), AppError> {
    let (root, repository) = open_repository(worktree_path)?;
    let paths = validate_paths(&root, &repository, paths)?;
    let mut index = repository.index()?;
    let head_index = head_index(&repository)?;
    for path in &paths {
        record_index_before(&repository, &index, &root, path, "unstagePath")?;
    }
    for path in &paths {
        if let Some(entry) = head_index.get_path(path, 0) {
            index.add(&entry)?;
        } else {
            remove_index_path(&mut index, path)?;
        }
    }
    index.write()?;
    Ok(())
}

/// S3-L1: reads a leaf's bytes without following it if it's a symlink, so a discard or an EOL
/// sniff can't be made to read through a tracked symlink that now points outside the worktree
/// (or at `/dev/zero`). For a symlink this is the link target text, which is also the correct
/// "before" snapshot: `restore_blob` restores a symlink from that same text.
fn leaf_bytes_without_following(full: &Path) -> Result<Option<Vec<u8>>, AppError> {
    match fs::symlink_metadata(full) {
        Ok(metadata) if metadata.file_type().is_symlink() => {
            let target = fs::read_link(full)
                .map_err(|error| AppError::io(format!("Could not read symlink target: {error}")))?;
            #[cfg(unix)]
            {
                use std::os::unix::ffi::OsStrExt;
                Ok(Some(target.as_os_str().as_bytes().to_vec()))
            }
            #[cfg(not(unix))]
            Err(AppError::internal(
                "Symlinks are not supported on this platform",
            ))
        }
        Ok(_) => fs::read(full)
            .map(Some)
            .map_err(|error| AppError::io(format!("Could not read the working file: {error}"))),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(AppError::io(format!(
            "Could not inspect the working file: {error}"
        ))),
    }
}

fn working_file_snapshot(root: &Path, path: &Path) -> Result<Option<Vec<u8>>, AppError> {
    let full = root.join(path);
    if matches!(fs::symlink_metadata(&full), Ok(metadata) if metadata.is_dir()) {
        return Err(AppError::validation(
            "Discard paths must name files, not directories",
        ));
    }
    leaf_bytes_without_following(&full)
}

#[allow(dead_code)]
fn discard_untracked_to_trash(_root: &Path, _path: &Path) -> Result<(), AppError> {
    // TODO Task 09: route untracked discards through the filesystem Trash helper.
    Err(AppError::internal(
        "trash backend not yet wired, use delete-to-Trash flow",
    ))
}

pub(crate) fn discard_paths(
    worktree_path: &Path,
    paths: &[String],
    discard_untracked: bool,
) -> Result<(), AppError> {
    let (root, repository) = open_repository(worktree_path)?;
    let paths = validate_paths(&root, &repository, paths)?;
    let index = repository.index()?;
    let head_index = head_index(&repository)?;
    let mut targets = Vec::with_capacity(paths.len());
    for path in &paths {
        let entry = index
            .get_path(path, 0)
            .or_else(|| head_index.get_path(path, 0));
        if entry.is_none() {
            if !discard_untracked {
                return Err(AppError::validation(
                    "Discarding untracked files requires discard_untracked=true",
                ));
            }
            discard_untracked_to_trash(&root, path)?;
            unreachable!("the untracked Trash flow is not wired until Task 09");
        }
        let entry = entry.expect("tracked path was checked above");
        let snapshot = working_file_snapshot(&root, path)?;
        targets.push((path.clone(), entry, snapshot));
    }
    for (path, _, snapshot) in &targets {
        let path_text = path
            .to_str()
            .ok_or_else(|| AppError::validation("Repository path is not valid UTF-8"))?;
        oplog::record(
            "discardPath",
            &root,
            path_text,
            json!({ "beforeWorkingTree": snapshot }),
        )?;
    }
    for (path, entry, _) in targets {
        restore_blob(&root, &repository, &path, &entry)?;
    }
    Ok(())
}

fn restore_blob(
    root: &Path,
    repository: &Repository,
    path: &Path,
    entry: &IndexEntry,
) -> Result<(), AppError> {
    let blob = repository.find_blob(entry.id)?;
    let full_path = root.join(path);
    if let Some(parent) = full_path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| AppError::io(format!("Could not create parent directory: {error}")))?;
    }
    // Discard replaces whatever sits at this exact leaf (remove, then rewrite from the git
    // blob) without reading through it first, so a dangling or `.git`-aliasing leaf symlink
    // must not be refused here.
    diff::ensure_leaf_parent_stays_in_worktree(root, path, repository)?;
    match fs::symlink_metadata(&full_path) {
        Ok(metadata) if metadata.is_dir() => {
            return Err(AppError::validation(
                "Discard paths must name files, not directories",
            ));
        }
        Ok(_) => fs::remove_file(&full_path).map_err(|error| {
            AppError::io(format!("Could not replace the working file: {error}"))
        })?,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => {
            return Err(AppError::io(format!(
                "Could not inspect the working file: {error}"
            )));
        }
    }
    if entry.mode == 0o120000 {
        #[cfg(unix)]
        {
            use std::os::unix::ffi::OsStrExt;
            std::os::unix::fs::symlink(OsStr::from_bytes(blob.content()), &full_path)
                .map_err(|error| AppError::io(format!("Could not restore symlink: {error}")))?;
        }
        #[cfg(not(unix))]
        return Err(AppError::internal(
            "Restoring symlinks is not supported on this platform",
        ));
    } else {
        fs::write(&full_path, blob.content())
            .map_err(|error| AppError::io(format!("Could not restore working file: {error}")))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = if entry.mode & 0o111 != 0 {
                0o755
            } else {
                0o644
            };
            fs::set_permissions(&full_path, fs::Permissions::from_mode(mode)).map_err(|error| {
                AppError::io(format!(
                    "Could not restore working file permissions: {error}"
                ))
            })?;
        }
    }
    Ok(())
}

fn validate_hunks(model: &DiffModel, indices: &[usize]) -> Result<Vec<usize>, AppError> {
    if model.binary || model.truncated {
        return Err(AppError::validation(
            "Cannot stage hunks for a binary or large file",
        ));
    }
    if indices.is_empty() {
        return Err(AppError::validation("At least one hunk index is required"));
    }
    let mut seen = HashSet::new();
    for index in indices {
        if *index >= model.hunks.len() {
            return Err(AppError::validation("Hunk index is outside the diff"));
        }
        if !seen.insert(*index) {
            return Err(AppError::validation(
                "Hunk indices must not contain duplicates",
            ));
        }
    }
    let mut indices = indices.to_vec();
    indices.sort_unstable();
    Ok(indices)
}

fn validate_diff_file(
    root: &Path,
    repository: &Repository,
    path: &str,
    area: DiffArea,
) -> Result<(PathBuf, DiffModel), AppError> {
    let relative = diff::validate_file_path(path)?;
    // Hunk/line staging and revert are index-only writes, same as `validate_paths` above.
    diff::ensure_leaf_parent_stays_in_worktree(root, &relative, repository)?;
    let model = diff::read(root, path, area)?;
    Ok((relative, model))
}

fn eol_for_patch(
    root: &Path,
    repository: &Repository,
    path: &Path,
    area: DiffArea,
) -> Result<&'static str, AppError> {
    let bytes = if area == DiffArea::Unstaged {
        leaf_bytes_without_following(&root.join(path))?
    } else {
        None
    };
    let bytes = match bytes {
        Some(bytes) => Some(bytes),
        None => {
            let index = repository.index()?;
            previous_index_blob(repository, &index, path)?
        }
    };
    Ok(
        if bytes
            .as_deref()
            .is_some_and(|bytes| bytes.windows(2).any(|pair| pair == b"\r\n"))
        {
            "\r\n"
        } else {
            "\n"
        },
    )
}

fn quote_git_path(path: &str) -> String {
    let mut quoted = String::from("\"");
    for byte in path.bytes() {
        match byte {
            b'\\' => quoted.push_str("\\\\"),
            b'"' => quoted.push_str("\\\""),
            b'\t' => quoted.push_str("\\t"),
            b'\n' => quoted.push_str("\\n"),
            b'\r' => quoted.push_str("\\r"),
            0x20..=0x7e => quoted.push(byte as char),
            _ => quoted.push_str(&format!("\\{byte:03o}")),
        }
    }
    quoted.push('"');
    quoted
}

fn patch_header(path: &str) -> String {
    format!(
        "diff --git {} {}\n--- {}\n+++ {}\n",
        quote_git_path(&format!("a/{path}")),
        quote_git_path(&format!("b/{path}")),
        quote_git_path(&format!("a/{path}")),
        quote_git_path(&format!("b/{path}")),
    )
}

fn patch_line(output: &mut String, prefix: char, line: &DiffLine, eol: &str) {
    output.push(prefix);
    output.push_str(&line.text);
    output.push_str(eol);
}

fn hunk_patch(path: &str, model: &DiffModel, indices: &[usize], eol: &str) -> String {
    let mut patch = patch_header(path);
    for index in indices {
        let hunk = &model.hunks[*index];
        patch.push_str(&format!(
            "@@ -{},{} +{},{} @@\n",
            hunk.old_start, hunk.old_lines, hunk.new_start, hunk.new_lines
        ));
        for line in &hunk.lines {
            let prefix = match line.kind {
                DiffLineKind::Context => ' ',
                DiffLineKind::Add => '+',
                DiffLineKind::Del => '-',
            };
            patch_line(&mut patch, prefix, line, eol);
        }
    }
    patch
}

fn parse_line_ids(
    model: &DiffModel,
    line_ids: &[String],
) -> Result<HashSet<(usize, usize)>, AppError> {
    if model.binary || model.truncated {
        return Err(AppError::validation(
            "Cannot stage lines for a binary or large file",
        ));
    }
    if line_ids.is_empty() {
        return Err(AppError::validation("At least one line id is required"));
    }
    let mut selected = HashSet::new();
    for line_id in line_ids {
        let (hunk, line) = line_id
            .split_once(':')
            .ok_or_else(|| AppError::validation("Line id must use hunk:line format"))?;
        let hunk = hunk
            .parse::<usize>()
            .map_err(|_| AppError::validation("Line id contains an invalid hunk index"))?;
        let line = line
            .parse::<usize>()
            .map_err(|_| AppError::validation("Line id contains an invalid line index"))?;
        let selected_line = model
            .hunks
            .get(hunk)
            .and_then(|hunk| hunk.lines.get(line))
            .ok_or_else(|| AppError::validation("Line id is outside the diff"))?;
        if selected_line.kind == DiffLineKind::Context {
            return Err(AppError::validation("Only changed lines can be staged"));
        }
        if !selected.insert((hunk, line)) {
            return Err(AppError::validation("Line ids must not contain duplicates"));
        }
    }
    Ok(selected)
}

fn selected_line_patch(
    path: &str,
    model: &DiffModel,
    selected: &HashSet<(usize, usize)>,
    eol: &str,
) -> String {
    let mut patch = patch_header(path);
    let mut staged_delta = 0i64;
    for (hunk_index, hunk) in model.hunks.iter().enumerate() {
        let selected_in_hunk = hunk.lines.iter().enumerate().any(|(line_index, line)| {
            line.kind != DiffLineKind::Context && selected.contains(&(hunk_index, line_index))
        });
        if !selected_in_hunk {
            continue;
        }
        let new_start = (i64::from(hunk.old_start) + staged_delta).max(0) as u32;
        let mut body = Vec::with_capacity(hunk.lines.len());
        for (line_index, line) in hunk.lines.iter().enumerate() {
            let is_selected = selected.contains(&(hunk_index, line_index));
            let prefix = match line.kind {
                DiffLineKind::Context => Some(' '),
                DiffLineKind::Del if is_selected => Some('-'),
                DiffLineKind::Del => Some(' '),
                DiffLineKind::Add if is_selected => Some('+'),
                DiffLineKind::Add => None,
            };
            if let Some(prefix) = prefix {
                body.push((prefix, line));
            }
        }
        let old_count = body.iter().filter(|(prefix, _)| *prefix != '+').count();
        let new_count = body.iter().filter(|(prefix, _)| *prefix != '-').count();
        patch.push_str(&format!(
            "@@ -{},{} +{},{} @@\n",
            hunk.old_start, old_count, new_start, new_count
        ));
        for (prefix, line) in body {
            patch_line(&mut patch, prefix, line, eol);
        }
        staged_delta += hunk
            .lines
            .iter()
            .enumerate()
            .filter(|(line_index, line)| {
                selected.contains(&(hunk_index, *line_index)) && line.kind == DiffLineKind::Add
            })
            .count() as i64;
        staged_delta -= hunk
            .lines
            .iter()
            .enumerate()
            .filter(|(line_index, line)| {
                selected.contains(&(hunk_index, *line_index)) && line.kind == DiffLineKind::Del
            })
            .count() as i64;
    }
    patch
}

fn apply_patch(root: &Path, patch: &str, cached: bool, reverse: bool) -> Result<(), AppError> {
    let patch_file = PatchFile::create(patch)?;
    let filters = worktree::configured_checkout_filters(root)?;
    let mut args = vec![OsStr::new("apply")];
    if cached {
        args.push(OsStr::new("--cached"));
    }
    if reverse {
        args.push(OsStr::new("--reverse"));
    }
    args.extend([
        OsStr::new("--unidiff-zero"),
        OsStr::new("--whitespace=nowarn"),
        OsStr::new("--"),
        patch_file.path().as_os_str(),
    ]);
    worktree::run_git_write_with_filters(root, &args, &filters)?;
    Ok(())
}

pub(crate) fn stage_hunks(
    worktree_path: &Path,
    path: &str,
    hunk_indices: &[usize],
    area: DiffArea,
) -> Result<(), AppError> {
    if area != DiffArea::Unstaged {
        return Err(AppError::validation("Only unstaged hunks can be staged"));
    }
    let (root, repository) = open_repository(worktree_path)?;
    let (relative, model) = validate_diff_file(&root, &repository, path, area)?;
    let indices = validate_hunks(&model, hunk_indices)?;
    if indices.len() == model.hunks.len() {
        return stage_paths(&root, &[path.to_owned()]);
    }
    let eol = eol_for_patch(&root, &repository, &relative, area)?;
    let patch = hunk_patch(path, &model, &indices, eol);
    let index = repository.index()?;
    record_index_before(&repository, &index, &root, &relative, "stageHunks")?;
    apply_patch(&root, &patch, true, false)
}

pub(crate) fn unstage_hunks(
    worktree_path: &Path,
    path: &str,
    hunk_indices: &[usize],
) -> Result<(), AppError> {
    let (root, repository) = open_repository(worktree_path)?;
    let (relative, model) = validate_diff_file(&root, &repository, path, DiffArea::Staged)?;
    let indices = validate_hunks(&model, hunk_indices)?;
    if indices.len() == model.hunks.len() {
        return unstage_paths(&root, &[path.to_owned()]);
    }
    let eol = eol_for_patch(&root, &repository, &relative, DiffArea::Staged)?;
    let patch = hunk_patch(path, &model, &indices, eol);
    let index = repository.index()?;
    record_index_before(&repository, &index, &root, &relative, "unstageHunks")?;
    apply_patch(&root, &patch, true, true)
}

pub(crate) fn stage_lines(
    worktree_path: &Path,
    path: &str,
    line_ids: &[String],
    area: DiffArea,
) -> Result<(), AppError> {
    let (root, repository) = open_repository(worktree_path)?;
    let (relative, model) = validate_diff_file(&root, &repository, path, area)?;
    let selected = parse_line_ids(&model, line_ids)?;
    let eol = eol_for_patch(&root, &repository, &relative, area)?;
    let patch = selected_line_patch(path, &model, &selected, eol);
    let index = repository.index()?;
    record_index_before(&repository, &index, &root, &relative, "stageLines")?;
    apply_patch(&root, &patch, true, area == DiffArea::Staged)
}

pub(crate) fn revert_hunk(
    worktree_path: &Path,
    path: &str,
    hunk_index: usize,
) -> Result<(), AppError> {
    let (root, repository) = open_repository(worktree_path)?;
    let (relative, model) = validate_diff_file(&root, &repository, path, DiffArea::Unstaged)?;
    let indices = validate_hunks(&model, &[hunk_index])?;
    let eol = eol_for_patch(&root, &repository, &relative, DiffArea::Unstaged)?;
    let patch = hunk_patch(path, &model, &indices, eol);
    let snapshot = working_file_snapshot(&root, &relative)?;
    oplog::record(
        "revertHunk",
        &root,
        path,
        json!({ "beforeWorkingTree": snapshot }),
    )?;
    apply_patch(&root, &patch, false, true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use git2::Signature;
    use std::{
        path::PathBuf,
        sync::atomic::{AtomicUsize, Ordering},
    };

    static NEXT_DIR: AtomicUsize = AtomicUsize::new(0);

    struct TestDir(PathBuf);

    impl TestDir {
        fn new() -> Self {
            let id = NEXT_DIR.fetch_add(1, Ordering::Relaxed);
            let path = std::env::temp_dir()
                .join(format!("branchwork-m2-stage-{}-{id}", std::process::id()));
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

    fn content(repository: &Repository, path: &str) -> Option<Vec<u8>> {
        let fresh = Repository::open(repository.workdir().unwrap()).unwrap();
        fresh
            .index()
            .unwrap()
            .get_path(Path::new(path), 0)
            .map(|entry| fresh.find_blob(entry.id).unwrap().content().to_vec())
    }

    fn lines(text: &str) -> Vec<String> {
        text.lines().map(str::to_owned).collect()
    }

    #[test]
    fn stages_modified_added_and_deleted_paths() {
        let temp = TestDir::new();
        let repository = init_repository(
            &temp.0,
            &[("modified.txt", b"before\n"), ("deleted.txt", b"remove\n")],
        );
        fs::write(temp.0.join("modified.txt"), b"after\n").unwrap();
        fs::write(temp.0.join("added.txt"), b"new\n").unwrap();
        fs::remove_file(temp.0.join("deleted.txt")).unwrap();

        stage_paths(&temp.0, &lines("modified.txt\nadded.txt\ndeleted.txt")).unwrap();

        assert_eq!(
            content(&repository, "modified.txt"),
            Some(b"after\n".to_vec())
        );
        assert_eq!(content(&repository, "added.txt"), Some(b"new\n".to_vec()));
        assert_eq!(content(&repository, "deleted.txt"), None);
        assert_eq!(
            oplog::entries_for(&temp.0.canonicalize().unwrap())
                .iter()
                .filter(|entry| entry.operation == "stagePath")
                .count(),
            3
        );
    }

    #[test]
    fn stages_a_committed_symlink_that_has_since_gone_dangling() {
        use std::os::unix::fs::symlink;
        let temp = TestDir::new();
        let repository = init_repository(&temp.0, &[("target.txt", b"content\n")]);
        symlink("target.txt", temp.0.join("link")).unwrap();
        let mut index = repository.index().unwrap();
        index.add_path(Path::new("link")).unwrap();
        let tree_id = index.write_tree().unwrap();
        index.write().unwrap();
        let tree = repository.find_tree(tree_id).unwrap();
        let signature = Signature::now("Branchwork test", "test@example.com").unwrap();
        let parent = repository.head().unwrap().peel_to_commit().unwrap();
        repository
            .commit(
                Some("HEAD"),
                &signature,
                &signature,
                "commit symlink",
                &tree,
                &[&parent],
            )
            .unwrap();
        drop(tree);
        drop(parent);

        // The symlink's target is gone and its link text is repointed at another missing name,
        // so `link` is now dangling and there is a real change to stage. The stricter validator
        // must not refuse this: index writes record a symlink's link text and never follow it.
        fs::remove_file(temp.0.join("target.txt")).unwrap();
        fs::remove_file(temp.0.join("link")).unwrap();
        symlink("missing.txt", temp.0.join("link")).unwrap();

        stage_paths(&temp.0, &lines("link")).unwrap();

        assert_eq!(content(&repository, "link"), Some(b"missing.txt".to_vec()));
    }

    #[test]
    fn unstages_paths_back_to_head_without_changing_the_worktree() {
        let temp = TestDir::new();
        let repository = init_repository(&temp.0, &[("file.txt", b"before\n")]);
        fs::write(temp.0.join("file.txt"), b"after\n").unwrap();
        stage_paths(&temp.0, &lines("file.txt")).unwrap();

        unstage_paths(&temp.0, &lines("file.txt")).unwrap();

        assert_eq!(content(&repository, "file.txt"), Some(b"before\n".to_vec()));
        assert_eq!(fs::read(temp.0.join("file.txt")).unwrap(), b"after\n");
        assert_eq!(
            oplog::entries_for(&temp.0.canonicalize().unwrap())
                .iter()
                .filter(|entry| entry.operation == "unstagePath")
                .count(),
            1
        );
    }

    #[test]
    fn stages_only_the_first_or_last_hunk() {
        let original_lines = (1..=12)
            .map(|line| format!("line {line}"))
            .collect::<Vec<_>>();
        let original = format!("{}\n", original_lines.join("\n"));
        let changed_lines = original_lines
            .iter()
            .enumerate()
            .map(|(index, line)| match index {
                0 => "first staged".to_owned(),
                11 => "last staged".to_owned(),
                _ => line.clone(),
            })
            .collect::<Vec<_>>();
        let changed = format!("{}\n", changed_lines.join("\n"));
        let expected_first = format!(
            "{}\n",
            std::iter::once("first staged".to_owned())
                .chain(original_lines.iter().skip(1).cloned())
                .collect::<Vec<_>>()
                .join("\n")
        );
        let expected_last = format!(
            "{}\n",
            original_lines
                .iter()
                .take(11)
                .cloned()
                .chain(std::iter::once("last staged".to_owned()))
                .collect::<Vec<_>>()
                .join("\n")
        );
        for (selected_hunk, expected) in [(0, expected_first), (1, expected_last)] {
            let temp = TestDir::new();
            let repository = init_repository(&temp.0, &[("file.txt", original.as_bytes())]);
            fs::write(temp.0.join("file.txt"), changed.as_bytes()).unwrap();

            stage_hunks(&temp.0, "file.txt", &[selected_hunk], DiffArea::Unstaged).unwrap();

            assert_eq!(
                content(&repository, "file.txt"),
                Some(expected.into_bytes())
            );
            assert!(
                oplog::entries_for(&temp.0.canonicalize().unwrap())
                    .iter()
                    .any(|entry| entry.operation == "stageHunks")
            );
        }
    }

    #[test]
    fn partially_unstages_the_selected_hunk() {
        let temp = TestDir::new();
        let original_lines = (1..=12)
            .map(|line| format!("line {line}"))
            .collect::<Vec<_>>();
        let original = format!("{}\n", original_lines.join("\n"));
        let mut changed_lines = original_lines.clone();
        changed_lines[0] = "first staged".to_owned();
        changed_lines[11] = "last staged".to_owned();
        let changed = format!("{}\n", changed_lines.join("\n"));
        let repository = init_repository(&temp.0, &[("file.txt", original.as_bytes())]);
        fs::write(temp.0.join("file.txt"), changed.as_bytes()).unwrap();
        stage_paths(&temp.0, &lines("file.txt")).unwrap();

        unstage_hunks(&temp.0, "file.txt", &[0]).unwrap();

        let mut expected = original_lines;
        expected[11] = "last staged".to_owned();
        assert_eq!(
            content(&repository, "file.txt"),
            Some(format!("{}\n", expected.join("\n")).into_bytes())
        );
        assert!(
            oplog::entries_for(&temp.0.canonicalize().unwrap())
                .iter()
                .any(|entry| entry.operation == "unstageHunks")
        );
    }

    #[test]
    fn stages_three_selected_lines_across_two_hunks_with_lf_and_crlf() {
        for eol in ["\n", "\r\n"] {
            let temp = TestDir::new();
            let original_lines = (1..=25)
                .map(|line| format!("line {line}"))
                .collect::<Vec<_>>();
            let original = format!("{}{eol}", original_lines.join(eol));
            let repository = init_repository(&temp.0, &[("file.txt", original.as_bytes())]);
            let mut changed_lines = original_lines.clone();
            changed_lines[1] = "line 2 selected".to_owned();
            changed_lines[3] = "line 4 selected".to_owned();
            changed_lines[19] = "line 20 selected".to_owned();
            let changed = format!("{}{eol}", changed_lines.join(eol));
            fs::write(temp.0.join("file.txt"), changed.as_bytes()).unwrap();

            let model = diff::read(&temp.0, "file.txt", DiffArea::Unstaged).unwrap();
            let selected_ids = model
                .hunks
                .iter()
                .enumerate()
                .flat_map(|(hunk_index, hunk)| {
                    hunk.lines
                        .iter()
                        .enumerate()
                        .filter(|(_, line)| line.kind == DiffLineKind::Add)
                        .map(move |(line_index, _)| format!("{hunk_index}:{line_index}"))
                })
                .collect::<Vec<_>>();
            assert_eq!(selected_ids.len(), 3);
            stage_lines(&temp.0, "file.txt", &selected_ids, DiffArea::Unstaged).unwrap();

            let mut expected_lines = Vec::new();
            for (index, line) in original_lines.iter().enumerate() {
                expected_lines.push(line.clone());
                if matches!(index, 1 | 3 | 19) {
                    expected_lines.push(format!("{} selected", line));
                }
            }
            let expected = format!("{}{eol}", expected_lines.join(eol));
            assert_eq!(
                content(&repository, "file.txt"),
                Some(expected.into_bytes())
            );
            assert!(
                oplog::entries_for(&temp.0.canonicalize().unwrap())
                    .iter()
                    .any(|entry| entry.operation == "stageLines")
            );
        }
    }

    #[test]
    fn reverts_one_hunk_and_records_the_preimage() {
        let temp = TestDir::new();
        let original_lines = (1..=12)
            .map(|line| format!("line {line}"))
            .collect::<Vec<_>>();
        let original = format!("{}\n", original_lines.join("\n"));
        let mut changed_lines = original_lines.clone();
        changed_lines[0] = "first changed".to_owned();
        changed_lines[11] = "last changed".to_owned();
        let changed = format!("{}\n", changed_lines.join("\n"));
        let repository = init_repository(&temp.0, &[("file.txt", original.as_bytes())]);
        fs::write(temp.0.join("file.txt"), changed.as_bytes()).unwrap();

        revert_hunk(&temp.0, "file.txt", 0).unwrap();

        let mut expected = original_lines;
        expected[11] = "last changed".to_owned();
        assert_eq!(
            fs::read(temp.0.join("file.txt")).unwrap(),
            format!("{}\n", expected.join("\n")).into_bytes()
        );
        let entry = oplog::entries_for(&temp.0.canonicalize().unwrap())
            .into_iter()
            .find(|entry| entry.operation == "revertHunk")
            .unwrap();
        assert_eq!(
            entry.payload["beforeWorkingTree"],
            json!(changed.as_bytes())
        );
        assert_eq!(
            content(&repository, "file.txt"),
            Some(original.into_bytes())
        );
    }

    #[test]
    fn discards_modified_worktree_content_and_records_snapshot() {
        let temp = TestDir::new();
        let repository = init_repository(&temp.0, &[("file.txt", b"before\n")]);
        fs::write(temp.0.join("file.txt"), b"after\n").unwrap();

        discard_paths(&temp.0, &lines("file.txt"), false).unwrap();

        assert_eq!(fs::read(temp.0.join("file.txt")).unwrap(), b"before\n");
        let canonical = temp.0.canonicalize().unwrap();
        let entry = oplog::entries_for(&canonical)
            .into_iter()
            .find(|entry| entry.operation == "discardPath")
            .unwrap();
        assert_eq!(
            entry.payload["beforeWorkingTree"],
            json!([97, 102, 116, 101, 114, 10])
        );
        assert_eq!(content(&repository, "file.txt"), Some(b"before\n".to_vec()));
    }

    #[test]
    fn discarding_a_symlink_repointed_outside_the_worktree_snapshots_the_link_text_not_the_outside_file()
     {
        use std::os::unix::fs::symlink;
        let temp = TestDir::new();
        let repository = init_repository(&temp.0, &[("target.txt", b"content\n")]);
        symlink("target.txt", temp.0.join("link")).unwrap();
        let mut index = repository.index().unwrap();
        index.add_path(Path::new("link")).unwrap();
        let tree_id = index.write_tree().unwrap();
        index.write().unwrap();
        let tree = repository.find_tree(tree_id).unwrap();
        let signature = Signature::now("Branchwork test", "test@example.com").unwrap();
        let parent = repository.head().unwrap().peel_to_commit().unwrap();
        repository
            .commit(
                Some("HEAD"),
                &signature,
                &signature,
                "commit symlink",
                &tree,
                &[&parent],
            )
            .unwrap();
        drop(tree);
        drop(parent);

        // S3-L1: `link` now points at a file outside the worktree. Discard must snapshot the
        // link's own text ("/outside/secret"), never the bytes of the file it points to.
        let outside = std::env::temp_dir().join(format!(
            "branchwork-m2-stage-outside-{}",
            std::process::id()
        ));
        fs::write(&outside, b"TOP-SECRET-OUTSIDE").unwrap();
        fs::remove_file(temp.0.join("link")).unwrap();
        symlink(&outside, temp.0.join("link")).unwrap();

        discard_paths(&temp.0, &lines("link"), false).unwrap();

        let canonical = temp.0.canonicalize().unwrap();
        let entry = oplog::entries_for(&canonical)
            .into_iter()
            .find(|entry| entry.operation == "discardPath")
            .unwrap();
        use std::os::unix::ffi::OsStrExt;
        let expected_link_text: Vec<u8> = outside.as_os_str().as_bytes().to_vec();
        assert_eq!(
            entry.payload["beforeWorkingTree"],
            serde_json::to_value(&expected_link_text).unwrap()
        );
        let _ = fs::remove_file(&outside);
    }

    #[test]
    fn rejects_paths_that_escape_or_target_git_metadata() {
        let temp = TestDir::new();
        let _repository = init_repository(&temp.0, &[("file.txt", b"before\n")]);
        for path in ["../outside", ".git/config", ""] {
            assert_eq!(
                stage_paths(&temp.0, &[path.to_owned()]).unwrap_err().kind,
                crate::error::ErrorKind::Validation
            );
        }
    }

    #[test]
    fn refuses_line_staging_for_large_files() {
        let temp = TestDir::new();
        let _repository = init_repository(&temp.0, &[("large.txt", b"before\n")]);
        fs::write(temp.0.join("large.txt"), vec![b'x'; 1_048_577]).unwrap();
        let error =
            stage_lines(&temp.0, "large.txt", &lines("0:0"), DiffArea::Unstaged).unwrap_err();
        assert_eq!(error.kind, crate::error::ErrorKind::Validation);
    }

    #[test]
    fn sentinel_smudge_filter_is_not_run_during_partial_stage() {
        let temp = TestDir::new();
        let repository = init_repository(&temp.0, &[("file.txt", b"before\n")]);
        fs::write(
            temp.0.join(".gitattributes"),
            b"file.txt filter=branchwork-test\n",
        )
        .unwrap();
        let mut index = repository.index().unwrap();
        index.add_path(Path::new(".gitattributes")).unwrap();
        let tree_id = index.write_tree().unwrap();
        index.write().unwrap();
        let tree = repository.find_tree(tree_id).unwrap();
        let signature = Signature::now("Branchwork test", "test@example.com").unwrap();
        let parent = repository.head().unwrap().peel_to_commit().unwrap();
        repository
            .commit(
                Some("HEAD"),
                &signature,
                &signature,
                "add filter attribute",
                &tree,
                &[&parent],
            )
            .unwrap();
        drop(tree);
        drop(parent);
        let marker = temp.0.join("filter-was-run");
        repository
            .config()
            .unwrap()
            .set_str(
                "filter.branchwork-test.smudge",
                &format!("touch {}", marker.display()),
            )
            .unwrap();
        fs::write(temp.0.join("file.txt"), b"after\n").unwrap();

        stage_hunks(&temp.0, "file.txt", &[0], DiffArea::Unstaged).unwrap();

        assert!(!marker.exists());
        assert_eq!(content(&repository, "file.txt"), Some(b"after\n".to_vec()));
    }

    #[test]
    fn refuses_untracked_discard_without_the_explicit_trash_flag() {
        let temp = TestDir::new();
        let _repository = init_repository(&temp.0, &[]);
        fs::write(temp.0.join("untracked.txt"), b"data\n").unwrap();
        let error = discard_paths(&temp.0, &lines("untracked.txt"), false).unwrap_err();
        assert_eq!(error.kind, crate::error::ErrorKind::Validation);
        assert!(temp.0.join("untracked.txt").exists());
    }
}
