//! Conflict read model (M6-04, spec §6.8): conflicted paths and per-file base/ours/theirs
//! regions from index stages 1/2/3. Regions come from libgit2's own three-way file merge in diff3
//! style, parsed back from its (long, labelled) conflict markers, so no diff3 logic lives here.
use crate::commit::{open_worktree, require_success, run_git};
use crate::diff::{ensure_path_stays_in_worktree, validate_file_path};
use crate::error::{AppError, ErrorKind};
use serde::{Deserialize, Serialize};
use std::{ffi::OsStr, fs, path::Path};

/// Conflicted paths returned by `conflict_list`.
const MAX_CONFLICT_FILES: usize = 1000;
/// Larger sides are summarized (choose ours/theirs only).
const MAX_SIDE_BYTES: usize = 1024 * 1024;
/// Files with more conflict regions than this are summarized.
const MAX_CONFLICT_REGIONS: usize = 500;
/// Long markers make a collision with real file content practically impossible.
const MARKER_SIZE: usize = 31;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum ConflictOperation {
    Merge,
    CherryPick,
    Revert,
    Rebase,
    None,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum ConflictKind {
    BothModified,
    BothAdded,
    DeletedByUs,
    DeletedByThem,
}

#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ConflictEntry {
    pub path: String,
    pub kind: ConflictKind,
}

#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ConflictList {
    pub operation: ConflictOperation,
    pub files: Vec<ConflictEntry>,
    pub truncated: bool,
}

/// Why a file is summarized (choose ours/theirs only); `notUtf8` means a text merge would not be
/// byte-exact.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum ConflictSummaryReason {
    Binary,
    TooLarge,
    DeletedByUs,
    DeletedByThem,
    TooManyConflicts,
    Symlink,
    Submodule,
    NotUtf8,
    MarkerLike,
}

#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ConflictSummary {
    pub reason: ConflictSummaryReason,
    pub ours_bytes: Option<u32>,
    pub theirs_bytes: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, specta::Type)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ConflictRegion {
    Context {
        text: String,
    },
    Conflict {
        index: u32,
        ours: String,
        base: String,
        theirs: String,
    },
}

#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ConflictFile {
    pub path: String,
    pub kind: ConflictKind,
    pub summary: Option<ConflictSummary>,
    pub regions: Vec<ConflictRegion>,
    /// Index object ids of base/ours/theirs; `conflict_resolve` refuses a stale stamp.
    pub stamp: String,
}

fn operation(repository: &git2::Repository) -> ConflictOperation {
    use git2::RepositoryState::*;
    match repository.state() {
        Merge => ConflictOperation::Merge,
        CherryPick | CherryPickSequence => ConflictOperation::CherryPick,
        Revert | RevertSequence => ConflictOperation::Revert,
        Rebase | RebaseInteractive | RebaseMerge | ApplyMailboxOrRebase => {
            ConflictOperation::Rebase
        }
        _ => ConflictOperation::None,
    }
}

fn kind(conflict: &git2::IndexConflict) -> ConflictKind {
    match (&conflict.ancestor, &conflict.our, &conflict.their) {
        (_, None, _) => ConflictKind::DeletedByUs,
        (_, _, None) => ConflictKind::DeletedByThem,
        (None, _, _) => ConflictKind::BothAdded,
        _ => ConflictKind::BothModified,
    }
}

fn entry_path(conflict: &git2::IndexConflict) -> Option<String> {
    [&conflict.our, &conflict.their, &conflict.ancestor]
        .into_iter()
        .flatten()
        .next()
        .map(|entry| String::from_utf8_lossy(&entry.path).into_owned())
}

pub(crate) fn list(worktree_path: &Path) -> Result<ConflictList, AppError> {
    let (_, repository) = open_worktree(worktree_path)?;
    let index = repository.index()?;
    let mut files = Vec::new();
    let mut truncated = false;
    if index.has_conflicts() {
        for conflict in index.conflicts()? {
            let conflict = conflict?;
            let Some(path) = entry_path(&conflict) else {
                continue;
            };
            if files.len() == MAX_CONFLICT_FILES {
                truncated = true;
                break;
            }
            files.push(ConflictEntry {
                path,
                kind: kind(&conflict),
            });
        }
    }
    files.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(ConflictList {
        operation: operation(&repository),
        files,
        truncated,
    })
}

const MODE_SYMLINK: u32 = 0o120000;
const MODE_GITLINK: u32 = 0o160000;

/// Size from the object header, without loading the blob (gitlinks have no object here).
fn object_size(odb: &git2::Odb<'_>, entry: &Option<git2::IndexEntry>) -> Option<u32> {
    let entry = entry.as_ref()?;
    if entry.mode == MODE_GITLINK {
        return None;
    }
    odb.read_header(entry.id)
        .ok()
        .map(|(size, _)| u32::try_from(size).unwrap_or(u32::MAX))
}

fn blob(
    repository: &git2::Repository,
    entry: &Option<git2::IndexEntry>,
) -> Result<Vec<u8>, AppError> {
    match entry {
        Some(entry) => Ok(repository.find_blob(entry.id)?.content().to_vec()),
        None => Ok(Vec::new()),
    }
}

fn is_binary(bytes: &[u8]) -> bool {
    bytes[..bytes.len().min(8000)].contains(&0)
}

/// libgit2 terminates every section of a conflict with a newline; at end of file that adds one
/// a side never had. Trim it so context + chosen side reproduces that side byte for byte.
fn trim_added_final_newline(
    regions: &mut [ConflictRegion],
    base: &[u8],
    ours: &[u8],
    theirs: &[u8],
) {
    let Some(ConflictRegion::Conflict {
        ours: o,
        base: b,
        theirs: t,
        ..
    }) = regions.last_mut()
    else {
        return;
    };
    for (text, source) in [(o, ours), (b, base), (t, theirs)] {
        if !source.is_empty() && !source.ends_with(b"\n") && text.ends_with('\n') {
            text.pop();
        }
    }
}

/// Splits libgit2's diff3-style merge output into context and conflict regions.
fn is_marker_line(line: &[u8], ch: u8) -> bool {
    line.len() >= MARKER_SIZE
        && line[..MARKER_SIZE].iter().all(|byte| *byte == ch)
        && matches!(line.get(MARKER_SIZE), None | Some(b' ' | b'\n' | b'\r'))
}

/// A side containing a line that looks like one of our markers can't be parsed unambiguously.
fn has_marker_like_line(bytes: &[u8]) -> bool {
    bytes
        .split_inclusive(|byte| *byte == b'\n')
        .any(|line| b"<|=>".iter().any(|ch| is_marker_line(line, *ch)))
}

/// `None` when the markers don't balance (a marker-like line in the file itself): the regions
/// would silently drop content, so the caller summarizes the file instead.
fn parse_regions(merged: &[u8]) -> Option<Vec<ConflictRegion>> {
    #[derive(PartialEq)]
    enum Part {
        Context,
        Ours,
        Base,
        Theirs,
    }
    let is_marker = is_marker_line;
    let text = |bytes: &[u8]| String::from_utf8_lossy(bytes).into_owned();
    let mut regions = Vec::new();
    let (mut context, mut ours, mut base, mut theirs) =
        (Vec::new(), Vec::new(), Vec::new(), Vec::new());
    let mut part = Part::Context;
    let mut index = 0u32;
    for line in merged.split_inclusive(|byte| *byte == b'\n') {
        match part {
            Part::Context if is_marker(line, b'<') => {
                if !context.is_empty() {
                    regions.push(ConflictRegion::Context {
                        text: text(&std::mem::take(&mut context)),
                    });
                }
                part = Part::Ours;
            }
            Part::Ours if is_marker(line, b'|') => part = Part::Base,
            Part::Ours | Part::Base if is_marker(line, b'=') => part = Part::Theirs,
            Part::Theirs if is_marker(line, b'>') => {
                regions.push(ConflictRegion::Conflict {
                    index,
                    ours: text(&std::mem::take(&mut ours)),
                    base: text(&std::mem::take(&mut base)),
                    theirs: text(&std::mem::take(&mut theirs)),
                });
                index += 1;
                part = Part::Context;
            }
            Part::Context => context.extend_from_slice(line),
            Part::Ours => ours.extend_from_slice(line),
            Part::Base => base.extend_from_slice(line),
            Part::Theirs => theirs.extend_from_slice(line),
        }
    }
    if part != Part::Context {
        return None;
    }
    if !context.is_empty() {
        regions.push(ConflictRegion::Context {
            text: text(&context),
        });
    }
    Some(regions)
}

fn find_conflict(
    repository: &git2::Repository,
    wanted: &str,
) -> Result<git2::IndexConflict, AppError> {
    repository
        .index()?
        .conflicts()?
        .filter_map(Result::ok)
        .find(|conflict| entry_path(conflict).as_deref() == Some(wanted))
        .ok_or_else(|| AppError::not_found(format!("{wanted} is not conflicted")))
}

fn stamp(conflict: &git2::IndexConflict) -> String {
    [&conflict.ancestor, &conflict.our, &conflict.their]
        .iter()
        .map(|entry| {
            entry
                .as_ref()
                .map_or_else(|| "-".to_owned(), |entry| entry.id.to_string())
        })
        .collect::<Vec<_>>()
        .join(":")
}

pub(crate) fn read(worktree_path: &Path, path: &str) -> Result<ConflictFile, AppError> {
    let relative = validate_file_path(path)?;
    let (_, repository) = open_worktree(worktree_path)?;
    let wanted = relative.to_string_lossy();
    let conflict = find_conflict(&repository, &wanted)?;
    read_conflict(&repository, &conflict, &wanted)
}

fn read_conflict(
    repository: &git2::Repository,
    conflict: &git2::IndexConflict,
    wanted: &str,
) -> Result<ConflictFile, AppError> {
    let kind = kind(conflict);
    let odb = repository.odb()?;
    let (ours_bytes, theirs_bytes) = (
        object_size(&odb, &conflict.our),
        object_size(&odb, &conflict.their),
    );
    let file =
        |summary: Option<ConflictSummaryReason>, regions: Vec<ConflictRegion>| ConflictFile {
            path: wanted.to_string(),
            kind,
            summary: summary.map(|reason| ConflictSummary {
                reason,
                ours_bytes,
                theirs_bytes,
            }),
            regions,
            stamp: stamp(conflict),
        };
    let entries = [&conflict.ancestor, &conflict.our, &conflict.their];
    let has_mode = |mode: u32| {
        entries
            .iter()
            .any(|entry| entry.as_ref().is_some_and(|e| e.mode == mode))
    };
    // Decide on summaries from modes and object headers before loading any blob.
    let reason = match kind {
        ConflictKind::DeletedByUs => Some(ConflictSummaryReason::DeletedByUs),
        ConflictKind::DeletedByThem => Some(ConflictSummaryReason::DeletedByThem),
        _ if has_mode(MODE_GITLINK) => Some(ConflictSummaryReason::Submodule),
        _ if has_mode(MODE_SYMLINK) => Some(ConflictSummaryReason::Symlink),
        _ if entries.iter().any(|entry| {
            object_size(&odb, entry).is_some_and(|size| size as usize > MAX_SIDE_BYTES)
        }) =>
        {
            Some(ConflictSummaryReason::TooLarge)
        }
        _ => None,
    };
    if reason.is_some() {
        return Ok(file(reason, Vec::new()));
    }
    let base = blob(repository, &conflict.ancestor)?;
    let ours = blob(repository, &conflict.our)?;
    let theirs = blob(repository, &conflict.their)?;
    let sides = [base.as_slice(), ours.as_slice(), theirs.as_slice()];
    if sides.iter().any(|side| is_binary(side)) {
        return Ok(file(Some(ConflictSummaryReason::Binary), Vec::new()));
    }
    // Regions are strings; a lossy conversion would corrupt Latin-1 / Shift-JIS files on write.
    if sides.iter().any(|side| std::str::from_utf8(side).is_err()) {
        return Ok(file(Some(ConflictSummaryReason::NotUtf8), Vec::new()));
    }
    if sides.iter().any(|side| has_marker_like_line(side)) {
        return Ok(file(Some(ConflictSummaryReason::MarkerLike), Vec::new()));
    }
    let mut inputs = [
        git2::MergeFileInput::new(),
        git2::MergeFileInput::new(),
        git2::MergeFileInput::new(),
    ];
    for (input, content) in inputs.iter_mut().zip(sides) {
        input.content(content);
    }
    let mut options = git2::MergeFileOptions::new();
    options
        .style_diff3(true)
        .marker_size(MARKER_SIZE as u16)
        .ancestor_label("base")
        .our_label("ours")
        .their_label("theirs");
    let merged = git2::merge_file(&inputs[0], &inputs[1], &inputs[2], Some(&mut options))?;
    let Some(mut regions) = parse_regions(merged.content()) else {
        return Ok(file(Some(ConflictSummaryReason::MarkerLike), Vec::new()));
    };
    trim_added_final_newline(&mut regions, &base, &ours, &theirs);
    let conflicts = regions
        .iter()
        .filter(|region| matches!(region, ConflictRegion::Conflict { .. }))
        .count();
    if conflicts > MAX_CONFLICT_REGIONS {
        return Ok(file(
            Some(ConflictSummaryReason::TooManyConflicts),
            Vec::new(),
        ));
    }
    Ok(file(None, regions))
}

/// The resolved file (context + chosen sides + manual text) is capped at 2 MB.
const MAX_MANUAL_BYTES: usize = 2 * 1024 * 1024;

/// Per-region choice; `both` is ours followed by theirs.
#[derive(Debug, Clone, Deserialize, specta::Type)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum RegionChoice {
    Ours,
    Theirs,
    Both,
    Manual { text: String },
}

/// Whole-file side; `delete` accepts a deletion (only for deleted-by-us/them conflicts).
#[derive(Debug, Clone, Copy, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum FileSide {
    Ours,
    Theirs,
    Delete,
}

/// `regions`: one choice per conflict region, in order. `file`: a whole-file side, the only
/// option for summarized files.
#[derive(Debug, Clone, Deserialize, specta::Type)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ConflictResolution {
    Regions { choices: Vec<RegionChoice> },
    File { side: FileSide },
}

fn git_ok(
    root: &Path,
    repository: &git2::Repository,
    operation: &str,
    args: &[&str],
) -> Result<(), AppError> {
    let argv: Vec<&OsStr> = args.iter().map(OsStr::new).collect();
    require_success(root, repository, operation, run_git(root, &argv)?)
}

/// Builds the merged text from regions and choices (exact bytes, no reformatting).
fn merged_text(regions: &[ConflictRegion], choices: &[RegionChoice]) -> Result<String, AppError> {
    let conflicts = regions
        .iter()
        .filter(|region| matches!(region, ConflictRegion::Conflict { .. }))
        .count();
    if choices.len() != conflicts {
        return Err(AppError::validation(format!(
            "Expected {conflicts} conflict choices, got {}",
            choices.len()
        )));
    }
    let mut choices = choices.iter();
    let mut text = String::new();
    for region in regions {
        match region {
            ConflictRegion::Context { text: context } => text.push_str(context),
            ConflictRegion::Conflict { ours, theirs, .. } => match choices.next() {
                Some(RegionChoice::Ours) => text.push_str(ours),
                Some(RegionChoice::Theirs) => text.push_str(theirs),
                Some(RegionChoice::Both) => {
                    text.push_str(ours);
                    text.push_str(theirs);
                }
                Some(RegionChoice::Manual { text: manual }) => text.push_str(manual),
                None => unreachable!("choice count checked above"),
            },
        }
        if text.len() > MAX_MANUAL_BYTES {
            return Err(AppError::validation(
                "The resolved file must not exceed 2 MB",
            ));
        }
    }
    Ok(text)
}

/// Writes a resolution for one conflicted file and stages it (spec §6.8).
pub(crate) fn resolve(
    worktree_path: &Path,
    path: &str,
    expected_stamp: &str,
    resolution: &ConflictResolution,
) -> Result<(), AppError> {
    let relative = validate_file_path(path)?;
    let (root, repository) = open_worktree(worktree_path)?;
    let wanted = relative.to_string_lossy().into_owned();
    // `--` only ends option parsing; without `:(literal)` git expands `*`, `?`, `[..]` and
    // `:(magic)` in the name, so `pages/[id].tsx` would also touch `pages/i.tsx`.
    let literal = format!(":(literal){wanted}");
    let conflict = find_conflict(&repository, &wanted)?;
    if stamp(&conflict) != expected_stamp {
        return Err(AppError::new(
            ErrorKind::Conflict,
            format!("{wanted} changed since it was read; reload it before resolving"),
        ));
    }
    match resolution {
        ConflictResolution::Regions { choices } => {
            let file = read_conflict(&repository, &conflict, &wanted)?;
            if file.summary.is_some() {
                return Err(AppError::validation(format!(
                    "{wanted} can only be resolved by choosing ours or theirs"
                )));
            }
            let text = merged_text(&file.regions, choices)?;
            ensure_path_stays_in_worktree(&root, &relative, &repository)?;
            let target = root.join(&relative);
            if fs::symlink_metadata(&target).is_ok_and(|meta| meta.file_type().is_symlink()) {
                return Err(AppError::validation(format!(
                    "{wanted} is a symlink in the worktree; resolve it in the terminal"
                )));
            }
            fs::write(&target, text.as_bytes())
                .map_err(|error| AppError::io(format!("Could not write {wanted}: {error}")))?;
            git_ok(&root, &repository, "add", &["add", "--", &literal])?;
            // Regions are normalized index text. Re-materialize the file from the index so eol /
            // attribute conversion applies; it must be removed first, or git sees it as current.
            fs::remove_file(&target)
                .map_err(|error| AppError::io(format!("Could not refresh {wanted}: {error}")))?;
            git_ok(
                &root,
                &repository,
                "checkout",
                &["checkout", "--", &literal],
            )
        }
        ConflictResolution::File {
            side: FileSide::Delete,
        } => {
            if !matches!(
                kind(&conflict),
                ConflictKind::DeletedByUs | ConflictKind::DeletedByThem
            ) {
                return Err(AppError::validation(format!(
                    "{wanted} was not deleted on either side"
                )));
            }
            git_ok(&root, &repository, "rm", &["rm", "-q", "--", &literal])
        }
        ConflictResolution::File { side } => {
            let (flag, entry) = match side {
                FileSide::Ours => ("--ours", &conflict.our),
                _ => ("--theirs", &conflict.their),
            };
            let Some(entry) = entry else {
                return Err(AppError::validation(format!(
                    "That side deleted {wanted}; choose delete to accept the deletion"
                )));
            };
            // `checkout --theirs` is a no-op for a gitlink and `add` would stage the submodule's
            // current HEAD; record the chosen commit directly.
            if entry.mode == MODE_GITLINK {
                let cacheinfo = format!("160000,{},{wanted}", entry.id);
                return git_ok(
                    &root,
                    &repository,
                    "update-index",
                    &["update-index", "--cacheinfo", &cacheinfo],
                );
            }
            git_ok(
                &root,
                &repository,
                "checkout",
                &["checkout", flag, "--", &literal],
            )?;
            git_ok(&root, &repository, "add", &["add", "--", &literal])
        }
    }
}

/// `git merge|cherry-pick|revert --abort` for the in-progress operation (rebase: M6-08).
pub(crate) fn abort(worktree_path: &Path) -> Result<(), AppError> {
    let (root, repository) = open_worktree(worktree_path)?;
    let command = match operation(&repository) {
        ConflictOperation::Merge => "merge",
        ConflictOperation::CherryPick => "cherry-pick",
        ConflictOperation::Revert => "revert",
        ConflictOperation::Rebase => {
            return Err(AppError::validation(
                "Abort a rebase from the Rebase screen",
            ));
        }
        ConflictOperation::None => {
            return Err(AppError::validation(
                "No merge, cherry-pick, or revert is in progress",
            ));
        }
    };
    git_ok(
        &root,
        &repository,
        &format!("{command} --abort"),
        &[command, "--abort"],
    )
}

/// `cherry-pick|revert --continue`. When the resolution left nothing to commit, git refuses; say
/// so and point to `--skip` (abort would also drop earlier picks of a multi-commit sequence).
fn sequencer_continue(
    root: &Path,
    repository: &git2::Repository,
    command: &str,
) -> Result<(), AppError> {
    let output = run_git(root, &[OsStr::new(command), OsStr::new("--continue")])?;
    let text = crate::commit::combined_text(&output);
    if !output.status.success()
        && (text.contains("is now empty") || text.contains("nothing to commit"))
    {
        let mut error = AppError::validation(format!(
            "The resolved changes are already in this branch, so there is nothing to commit. \
             Run `git {command} --skip` in the terminal to move on, or abort."
        ));
        error.detail = Some(text);
        return Err(error);
    }
    require_success(root, repository, &format!("{command} --continue"), output)
}

/// "Mark resolved & commit": refused while any path is still conflicted.
pub(crate) fn continue_operation(worktree_path: &Path) -> Result<(), AppError> {
    let (root, repository) = open_worktree(worktree_path)?;
    let remaining = list(&root)?.files.len();
    if remaining > 0 {
        return Err(AppError::new(
            ErrorKind::Conflict,
            format!("{remaining} file(s) still have conflicts"),
        ));
    }
    match operation(&repository) {
        ConflictOperation::Merge => git_ok(&root, &repository, "commit", &["commit", "--no-edit"]),
        ConflictOperation::CherryPick => sequencer_continue(&root, &repository, "cherry-pick"),
        ConflictOperation::Revert => sequencer_continue(&root, &repository, "revert"),
        ConflictOperation::Rebase => Err(AppError::validation(
            "Continue a rebase from the Rebase screen",
        )),
        ConflictOperation::None => Err(AppError::validation(
            "No merge, cherry-pick, or revert is in progress",
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::ErrorKind;
    use std::{
        fs,
        path::PathBuf,
        process::Command,
        sync::atomic::{AtomicUsize, Ordering},
    };

    static NEXT_DIR: AtomicUsize = AtomicUsize::new(0);

    struct TestDir(PathBuf);

    impl TestDir {
        fn new(label: &str) -> Self {
            let id = NEXT_DIR.fetch_add(1, Ordering::Relaxed);
            let path = std::env::temp_dir().join(format!(
                "branchwork-m6-conflict-{label}-{}-{id}",
                std::process::id()
            ));
            let _ = fs::remove_dir_all(&path);
            fs::create_dir_all(&path).unwrap();
            Self(path.canonicalize().unwrap())
        }
    }

    impl Drop for TestDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn git(cwd: &Path, args: &[&str]) -> std::process::Output {
        Command::new("git")
            .arg("-C")
            .arg(cwd)
            .args(args)
            .env("GIT_TERMINAL_PROMPT", "0")
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_EDITOR", "true")
            .output()
            .unwrap()
    }

    fn ok(cwd: &Path, args: &[&str]) -> String {
        let output = git(cwd, args);
        assert!(
            output.status.success(),
            "git {args:?}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8_lossy(&output.stdout).trim().to_owned()
    }

    fn commit(path: &Path, files: &[(&str, &[u8])], message: &str) -> String {
        for (name, contents) in files {
            fs::write(path.join(name), contents).unwrap();
            ok(path, &["add", name]);
        }
        ok(path, &["commit", "-q", "-m", message]);
        ok(path, &["rev-parse", "HEAD"])
    }

    fn repo(label: &str) -> TestDir {
        let dir = TestDir::new(label);
        ok(&dir.0, &["init", "-q", "-b", "main"]);
        ok(&dir.0, &["config", "user.name", "Branchwork Test"]);
        ok(&dir.0, &["config", "user.email", "test@example.com"]);
        dir
    }

    const BASE: &str = "a\nb\nc\nd\ne\nf\ng\n";
    const OURS: &str = "a\nB-ours\nc\nd\ne\nF-ours\ng\n";
    const THEIRS: &str = "a\nB-theirs\nc\nd\ne\nF-theirs\ng\n";

    /// `main` and `topic` change the same two lines of `file.txt`; returns the topic tip.
    fn diverged(label: &str) -> (TestDir, String) {
        let dir = repo(label);
        commit(&dir.0, &[("file.txt", BASE.as_bytes())], "base");
        ok(&dir.0, &["switch", "-q", "-c", "topic"]);
        let topic = commit(&dir.0, &[("file.txt", THEIRS.as_bytes())], "theirs");
        ok(&dir.0, &["switch", "-q", "main"]);
        commit(&dir.0, &[("file.txt", OURS.as_bytes())], "ours");
        (dir, topic)
    }

    #[test]
    fn list_reports_paths_kinds_and_operation_for_merge_and_cherry_pick() {
        let (dir, _) = diverged("list-merge");
        assert!(!git(&dir.0, &["merge", "topic"]).status.success());
        let listed = list(&dir.0).unwrap();
        assert_eq!(listed.operation, ConflictOperation::Merge);
        assert_eq!(listed.files.len(), 1);
        assert_eq!(listed.files[0].path, "file.txt");
        assert_eq!(listed.files[0].kind, ConflictKind::BothModified);

        let (dir, topic) = diverged("list-pick");
        assert!(!git(&dir.0, &["cherry-pick", &topic]).status.success());
        let listed = list(&dir.0).unwrap();
        assert_eq!(listed.operation, ConflictOperation::CherryPick);
        assert_eq!(listed.files.len(), 1);
        assert_eq!(listed.files[0].path, "file.txt");
        assert_eq!(listed.files[0].kind, ConflictKind::BothModified);
    }

    #[test]
    fn read_splits_two_conflicts_with_base_and_context_plus_ours_is_the_all_ours_merge() {
        let (dir, _) = diverged("read");
        assert!(!git(&dir.0, &["merge", "topic"]).status.success());

        let file = read(&dir.0, "file.txt").unwrap();

        assert!(file.summary.is_none());
        let conflicts: Vec<_> = file
            .regions
            .iter()
            .filter_map(|region| match region {
                ConflictRegion::Conflict {
                    ours, base, theirs, ..
                } => Some((ours, base, theirs)),
                ConflictRegion::Context { .. } => None,
            })
            .collect();
        assert_eq!(conflicts.len(), 2);
        assert_eq!(
            conflicts[0],
            (
                &"B-ours\n".to_string(),
                &"b\n".to_string(),
                &"B-theirs\n".to_string()
            )
        );
        assert_eq!(conflicts[1].0, "F-ours\n");
        let all_ours: String = file
            .regions
            .iter()
            .map(|region| match region {
                ConflictRegion::Context { text } => text.as_str(),
                ConflictRegion::Conflict { ours, .. } => ours.as_str(),
            })
            .collect();
        assert_eq!(all_ours, OURS);
    }

    #[test]
    fn add_add_conflict_reads_against_an_empty_base() {
        let dir = repo("add-add");
        commit(&dir.0, &[("README.md", b"r\n")], "base");
        ok(&dir.0, &["switch", "-q", "-c", "topic"]);
        commit(&dir.0, &[("new.txt", b"theirs\n")], "theirs");
        ok(&dir.0, &["switch", "-q", "main"]);
        commit(&dir.0, &[("new.txt", b"ours\n")], "ours");
        assert!(!git(&dir.0, &["merge", "topic"]).status.success());

        let file = read(&dir.0, "new.txt").unwrap();

        assert_eq!(file.kind, ConflictKind::BothAdded);
        assert!(file.regions.contains(&ConflictRegion::Conflict {
            index: 0,
            ours: "ours\n".into(),
            base: String::new(),
            theirs: "theirs\n".into(),
        }));
    }

    #[test]
    fn binary_large_and_deleted_files_return_summaries() {
        let dir = repo("summaries");
        let big_base = "x\n".repeat(600 * 1024);
        commit(
            &dir.0,
            &[
                ("bin.dat", b"\0base"),
                ("big.txt", big_base.as_bytes()),
                ("gone.txt", b"keep\n"),
            ],
            "base",
        );
        ok(&dir.0, &["switch", "-q", "-c", "topic"]);
        fs::remove_file(dir.0.join("gone.txt")).unwrap();
        ok(&dir.0, &["rm", "-q", "--cached", "gone.txt"]);
        commit(
            &dir.0,
            &[
                ("bin.dat", b"\0theirs"),
                ("big.txt", format!("{big_base}theirs\n").as_bytes()),
            ],
            "theirs",
        );
        ok(&dir.0, &["switch", "-q", "main"]);
        commit(
            &dir.0,
            &[
                ("bin.dat", b"\0ours"),
                ("big.txt", format!("{big_base}ours\n").as_bytes()),
                ("gone.txt", b"changed\n"),
            ],
            "ours",
        );
        assert!(!git(&dir.0, &["merge", "topic"]).status.success());

        let reason = |path| read(&dir.0, path).unwrap().summary.unwrap().reason;
        assert_eq!(reason("bin.dat"), ConflictSummaryReason::Binary);
        assert_eq!(reason("big.txt"), ConflictSummaryReason::TooLarge);
        let gone = read(&dir.0, "gone.txt").unwrap();
        assert_eq!(gone.kind, ConflictKind::DeletedByThem);
        assert_eq!(
            gone.summary.unwrap().reason,
            ConflictSummaryReason::DeletedByThem
        );
        assert!(gone.regions.is_empty());
    }

    #[test]
    fn clean_path_is_not_found_and_traversal_is_rejected() {
        let (dir, _) = diverged("paths");
        commit(&dir.0, &[("clean.txt", b"c\n")], "tracked clean file");
        assert!(!git(&dir.0, &["merge", "topic"]).status.success());

        assert_eq!(
            read(&dir.0, "clean.txt").unwrap_err().kind,
            ErrorKind::NotFound
        );
        assert_eq!(
            read(&dir.0, "../x").unwrap_err().kind,
            ErrorKind::Validation
        );
    }

    // Regression: libgit2 ends every conflict section with a newline, so a side without a final
    // newline gained one and "choose ours" would have rewritten the file.
    #[test]
    fn conflict_at_end_of_file_keeps_a_missing_final_newline() {
        let dir = repo("eof");
        commit(&dir.0, &[("f.txt", b"a\nb\nc")], "base");
        ok(&dir.0, &["switch", "-q", "-c", "topic"]);
        commit(&dir.0, &[("f.txt", b"a\nb\nC-theirs")], "theirs");
        ok(&dir.0, &["switch", "-q", "main"]);
        commit(&dir.0, &[("f.txt", b"a\nb\nC-ours")], "ours");
        assert!(!git(&dir.0, &["merge", "topic"]).status.success());

        let file = read(&dir.0, "f.txt").unwrap();
        let side = |pick_ours: bool| -> String {
            file.regions
                .iter()
                .map(|region| match region {
                    ConflictRegion::Context { text } => text.clone(),
                    ConflictRegion::Conflict { ours, theirs, .. } if pick_ours => ours.clone(),
                    ConflictRegion::Conflict { theirs, .. } => theirs.clone(),
                })
                .collect()
        };
        assert_eq!(side(true), "a\nb\nC-ours");
        assert_eq!(side(false), "a\nb\nC-theirs");
    }

    // Regression: symlinks were merged as text and submodule conflicts failed with NotFound.
    #[cfg(unix)]
    #[test]
    fn symlink_and_submodule_conflicts_return_summaries() {
        let dir = repo("modes");
        commit(&dir.0, &[("README.md", b"r\n")], "base");
        let gitlink = |sha: String| {
            ok(
                &dir.0,
                &[
                    "update-index",
                    "--add",
                    "--cacheinfo",
                    &format!("160000,{sha},sub"),
                ],
            );
        };
        let link = |target: &str| {
            let _ = fs::remove_file(dir.0.join("link"));
            std::os::unix::fs::symlink(target, dir.0.join("link")).unwrap();
            ok(&dir.0, &["add", "link"]);
        };
        link("target-base");
        gitlink("1".repeat(40));
        ok(&dir.0, &["commit", "-q", "-m", "link + sub"]);
        ok(&dir.0, &["switch", "-q", "-c", "topic"]);
        link("target-theirs");
        gitlink("2".repeat(40));
        ok(&dir.0, &["commit", "-q", "-m", "theirs"]);
        ok(&dir.0, &["switch", "-q", "main"]);
        link("target-ours");
        gitlink("3".repeat(40));
        ok(&dir.0, &["commit", "-q", "-m", "ours"]);
        assert!(!git(&dir.0, &["merge", "topic"]).status.success());

        let reason = |path| read(&dir.0, path).unwrap().summary.unwrap().reason;
        assert_eq!(reason("link"), ConflictSummaryReason::Symlink);
        assert_eq!(reason("sub"), ConflictSummaryReason::Submodule);
    }

    fn regions(choices: Vec<RegionChoice>) -> ConflictResolution {
        ConflictResolution::Regions { choices }
    }

    fn index_text(dir: &Path, path: &str) -> String {
        ok(dir, &["show", &format!(":{path}")])
    }

    #[test]
    fn resolve_writes_and_stages_ours_plus_manual() {
        let (dir, _) = diverged("resolve");
        assert!(!git(&dir.0, &["merge", "topic"]).status.success());
        let file = read(&dir.0, "file.txt").unwrap();

        let choices = vec![
            RegionChoice::Ours,
            RegionChoice::Manual {
                text: "F-manual\n".into(),
            },
        ];
        resolve(&dir.0, "file.txt", &file.stamp, &regions(choices)).unwrap();

        let expected = "a\nB-ours\nc\nd\ne\nF-manual\ng\n";
        assert_eq!(
            fs::read_to_string(dir.0.join("file.txt")).unwrap(),
            expected
        );
        assert_eq!(format!("{}\n", index_text(&dir.0, "file.txt")), expected);
        assert!(list(&dir.0).unwrap().files.is_empty());
    }

    #[test]
    fn both_concatenates_ours_then_theirs() {
        let (dir, _) = diverged("both");
        assert!(!git(&dir.0, &["merge", "topic"]).status.success());
        let file = read(&dir.0, "file.txt").unwrap();

        resolve(
            &dir.0,
            "file.txt",
            &file.stamp,
            &regions(vec![RegionChoice::Both, RegionChoice::Theirs]),
        )
        .unwrap();

        assert_eq!(
            fs::read_to_string(dir.0.join("file.txt")).unwrap(),
            "a\nB-ours\nB-theirs\nc\nd\ne\nF-theirs\ng\n"
        );
    }

    #[test]
    fn stale_stamp_and_wrong_choice_count_write_nothing() {
        let (dir, _) = diverged("stale");
        assert!(!git(&dir.0, &["merge", "topic"]).status.success());
        let file = read(&dir.0, "file.txt").unwrap();
        let before = fs::read_to_string(dir.0.join("file.txt")).unwrap();

        let stale = resolve(
            &dir.0,
            "file.txt",
            "x:y:z",
            &regions(vec![RegionChoice::Ours, RegionChoice::Ours]),
        );
        assert_eq!(stale.unwrap_err().kind, ErrorKind::Conflict);
        let short = resolve(
            &dir.0,
            "file.txt",
            &file.stamp,
            &regions(vec![RegionChoice::Ours]),
        );
        assert_eq!(short.unwrap_err().kind, ErrorKind::Validation);

        assert_eq!(fs::read_to_string(dir.0.join("file.txt")).unwrap(), before);
        assert_eq!(list(&dir.0).unwrap().files.len(), 1);
    }

    #[test]
    fn file_theirs_for_binary_and_delete_for_deleted_by_them() {
        let dir = repo("file-side");
        commit(
            &dir.0,
            &[("bin.dat", b"\0base"), ("gone.txt", b"keep\n")],
            "base",
        );
        ok(&dir.0, &["switch", "-q", "-c", "topic"]);
        ok(&dir.0, &["rm", "-q", "gone.txt"]);
        commit(&dir.0, &[("bin.dat", b"\0theirs")], "theirs");
        ok(&dir.0, &["switch", "-q", "main"]);
        commit(
            &dir.0,
            &[("bin.dat", b"\0ours"), ("gone.txt", b"changed\n")],
            "ours",
        );
        assert!(!git(&dir.0, &["merge", "topic"]).status.success());

        let bin = read(&dir.0, "bin.dat").unwrap();
        resolve(
            &dir.0,
            "bin.dat",
            &bin.stamp,
            &ConflictResolution::File {
                side: FileSide::Theirs,
            },
        )
        .unwrap();
        let gone = read(&dir.0, "gone.txt").unwrap();
        resolve(
            &dir.0,
            "gone.txt",
            &gone.stamp,
            &ConflictResolution::File {
                side: FileSide::Delete,
            },
        )
        .unwrap();

        assert_eq!(fs::read(dir.0.join("bin.dat")).unwrap(), b"\0theirs");
        assert!(!dir.0.join("gone.txt").exists());
        assert!(list(&dir.0).unwrap().files.is_empty());
    }

    #[test]
    fn abort_restores_the_pre_merge_head_and_clean_tree() {
        let (dir, _) = diverged("abort");
        let head = ok(&dir.0, &["rev-parse", "HEAD"]);
        assert!(!git(&dir.0, &["merge", "topic"]).status.success());

        abort(&dir.0).unwrap();

        assert_eq!(ok(&dir.0, &["rev-parse", "HEAD"]), head);
        assert_eq!(ok(&dir.0, &["status", "--porcelain"]), "");
        assert_eq!(list(&dir.0).unwrap().operation, ConflictOperation::None);
    }

    #[test]
    fn continue_is_refused_while_conflicted_then_commits_the_merge_and_finishes_a_pick() {
        let (dir, _) = diverged("continue-merge");
        assert!(!git(&dir.0, &["merge", "topic"]).status.success());
        assert_eq!(
            continue_operation(&dir.0).unwrap_err().kind,
            ErrorKind::Conflict
        );
        let file = read(&dir.0, "file.txt").unwrap();
        resolve(
            &dir.0,
            "file.txt",
            &file.stamp,
            &regions(vec![RegionChoice::Ours, RegionChoice::Theirs]),
        )
        .unwrap();
        continue_operation(&dir.0).unwrap();
        assert_eq!(
            ok(&dir.0, &["rev-list", "--parents", "-n", "1", "HEAD"])
                .split(' ')
                .count(),
            3
        );

        let (dir, topic) = diverged("continue-pick");
        assert!(!git(&dir.0, &["cherry-pick", &topic]).status.success());
        let file = read(&dir.0, "file.txt").unwrap();
        resolve(
            &dir.0,
            "file.txt",
            &file.stamp,
            &regions(vec![RegionChoice::Theirs, RegionChoice::Theirs]),
        )
        .unwrap();
        continue_operation(&dir.0).unwrap();
        assert_eq!(ok(&dir.0, &["log", "-1", "--format=%s"]), "theirs");
        assert_eq!(list(&dir.0).unwrap().operation, ConflictOperation::None);
    }

    // Regression: `checkout --theirs` is a no-op for a gitlink and `add` staged ours.
    #[test]
    fn choosing_theirs_for_a_submodule_stages_their_commit() {
        let dir = repo("sub-theirs");
        commit(&dir.0, &[("README.md", b"r\n")], "base");
        let gitlink = |sha: String| {
            ok(
                &dir.0,
                &[
                    "update-index",
                    "--add",
                    "--cacheinfo",
                    &format!("160000,{sha},sub"),
                ],
            );
        };
        gitlink("1".repeat(40));
        ok(&dir.0, &["commit", "-q", "-m", "sub"]);
        ok(&dir.0, &["switch", "-q", "-c", "topic"]);
        gitlink("2".repeat(40));
        ok(&dir.0, &["commit", "-q", "-m", "theirs"]);
        ok(&dir.0, &["switch", "-q", "main"]);
        gitlink("3".repeat(40));
        ok(&dir.0, &["commit", "-q", "-m", "ours"]);
        assert!(!git(&dir.0, &["merge", "topic"]).status.success());
        let file = read(&dir.0, "sub").unwrap();

        resolve(
            &dir.0,
            "sub",
            &file.stamp,
            &ConflictResolution::File {
                side: FileSide::Theirs,
            },
        )
        .unwrap();

        let staged = ok(&dir.0, &["ls-files", "-s", "--", "sub"]);
        assert_eq!(staged, format!("160000 {} 0\tsub", "2".repeat(40)));
    }

    // Regression: regions are strings, so a Latin-1 file was rewritten with U+FFFD on resolve.
    #[test]
    fn non_utf8_text_is_summarized_and_resolved_byte_exact() {
        let dir = repo("latin1");
        commit(&dir.0, &[("l.txt", b"caf\xe9\nbase\n")], "base");
        ok(&dir.0, &["switch", "-q", "-c", "topic"]);
        commit(&dir.0, &[("l.txt", b"caf\xe9\ntheirs\n")], "theirs");
        ok(&dir.0, &["switch", "-q", "main"]);
        commit(&dir.0, &[("l.txt", b"caf\xe9\nours\n")], "ours");
        assert!(!git(&dir.0, &["merge", "topic"]).status.success());

        let file = read(&dir.0, "l.txt").unwrap();
        assert_eq!(file.summary.unwrap().reason, ConflictSummaryReason::NotUtf8);
        let regions_attempt = resolve(
            &dir.0,
            "l.txt",
            &file.stamp,
            &regions(vec![RegionChoice::Ours]),
        );
        assert_eq!(regions_attempt.unwrap_err().kind, ErrorKind::Validation);
        resolve(
            &dir.0,
            "l.txt",
            &file.stamp,
            &ConflictResolution::File {
                side: FileSide::Ours,
            },
        )
        .unwrap();

        assert_eq!(fs::read(dir.0.join("l.txt")).unwrap(), b"caf\xe9\nours\n");
    }

    // Regression: the post-add checkout was a no-op, so eol=crlf files kept LF in the worktree.
    #[test]
    fn regions_resolve_applies_eol_attributes_to_the_worktree_file() {
        let dir = repo("eol-crlf");
        commit(
            &dir.0,
            &[(".gitattributes", b"*.txt text eol=crlf\n")],
            "attrs",
        );
        commit(&dir.0, &[("w.txt", b"a\nb\n")], "base");
        ok(&dir.0, &["switch", "-q", "-c", "topic"]);
        commit(&dir.0, &[("w.txt", b"a\nb-theirs\n")], "theirs");
        ok(&dir.0, &["switch", "-q", "main"]);
        commit(&dir.0, &[("w.txt", b"a\nb-ours\n")], "ours");
        assert!(!git(&dir.0, &["merge", "topic"]).status.success());
        let file = read(&dir.0, "w.txt").unwrap();

        resolve(
            &dir.0,
            "w.txt",
            &file.stamp,
            &regions(vec![RegionChoice::Ours]),
        )
        .unwrap();

        assert_eq!(fs::read(dir.0.join("w.txt")).unwrap(), b"a\r\nb-ours\r\n");
        // Ours equals HEAD, and the CRLF worktree file matches the index: nothing pending.
        assert_eq!(ok(&dir.0, &["status", "--porcelain", "--", "w.txt"]), "");
    }

    // Regression: a pick emptied by its resolution was reported as "conflicted".
    #[test]
    fn continue_explains_a_cherry_pick_emptied_by_its_resolution() {
        let (dir, topic) = diverged("empty-pick");
        assert!(!git(&dir.0, &["cherry-pick", &topic]).status.success());
        let file = read(&dir.0, "file.txt").unwrap();
        resolve(
            &dir.0,
            "file.txt",
            &file.stamp,
            &regions(vec![RegionChoice::Ours, RegionChoice::Ours]),
        )
        .unwrap();

        let error = continue_operation(&dir.0).unwrap_err();

        assert_eq!(error.kind, ErrorKind::Validation);
        assert!(error.message.contains("git cherry-pick --skip"));
    }

    // Regression (security review): glob characters in a conflicted path were expanded by git,
    // so resolving `[id].txt` reverted edits in `i.txt` and staged an untracked `d.txt`.
    #[test]
    fn resolving_a_path_with_glob_characters_touches_only_that_file() {
        let dir = repo("glob");
        commit(
            &dir.0,
            &[("[id].txt", b"base\n"), ("i.txt", b"keep\n")],
            "base",
        );
        ok(&dir.0, &["switch", "-q", "-c", "topic"]);
        commit(&dir.0, &[("[id].txt", b"theirs\n")], "theirs");
        ok(&dir.0, &["switch", "-q", "main"]);
        commit(&dir.0, &[("[id].txt", b"ours\n")], "ours");
        assert!(!git(&dir.0, &["merge", "topic"]).status.success());
        fs::write(dir.0.join("i.txt"), "uncommitted edit\n").unwrap();
        fs::write(dir.0.join("d.txt"), "untracked\n").unwrap();

        let file = read(&dir.0, "[id].txt").unwrap();
        resolve(
            &dir.0,
            "[id].txt",
            &file.stamp,
            &ConflictResolution::File {
                side: FileSide::Ours,
            },
        )
        .unwrap();

        assert_eq!(
            fs::read_to_string(dir.0.join("i.txt")).unwrap(),
            "uncommitted edit\n"
        );
        let staged = ok(&dir.0, &["diff", "--cached", "--name-only"]);
        assert!(
            !staged.contains("i.txt") && !staged.contains("d.txt"),
            "{staged}"
        );
        assert!(ok(&dir.0, &["status", "--porcelain"]).contains("?? d.txt"));
        assert!(list(&dir.0).unwrap().files.is_empty());
    }

    // Regression: an emptied revert reported "conflicted" and offered Resolve conflicts.
    #[test]
    fn continue_explains_a_revert_emptied_by_its_resolution() {
        let (dir, _) = diverged("empty-revert");
        let head = ok(&dir.0, &["rev-parse", "HEAD"]);
        commit(
            &dir.0,
            &[("file.txt", b"a\nB-later\nc\nd\ne\nF-later\ng\n")],
            "later",
        );
        assert!(
            !git(&dir.0, &["revert", "--no-edit", &head])
                .status
                .success()
        );
        let file = read(&dir.0, "file.txt").unwrap();
        let ours = vec![
            RegionChoice::Ours;
            file.regions
                .iter()
                .filter(|r| matches!(r, ConflictRegion::Conflict { .. }))
                .count()
        ];
        resolve(&dir.0, "file.txt", &file.stamp, &regions(ours)).unwrap();

        let error = continue_operation(&dir.0).unwrap_err();

        assert_eq!(error.kind, ErrorKind::Validation);
        assert!(
            error.message.contains("git revert --skip"),
            "{}",
            error.message
        );
    }

    // Regression (security review): a lone marker-like line silently cut the file short.
    #[test]
    fn unbalanced_marker_like_content_is_summarized() {
        let dir = repo("markers");
        let marker = "<".repeat(31);
        commit(
            &dir.0,
            &[("m.txt", format!("a\n{marker}\nb\n").as_bytes())],
            "base",
        );
        ok(&dir.0, &["switch", "-q", "-c", "topic"]);
        commit(
            &dir.0,
            &[("m.txt", format!("a\n{marker}\nb-theirs\n").as_bytes())],
            "theirs",
        );
        ok(&dir.0, &["switch", "-q", "main"]);
        commit(
            &dir.0,
            &[("m.txt", format!("a\n{marker}\nb-ours\n").as_bytes())],
            "ours",
        );
        assert!(!git(&dir.0, &["merge", "topic"]).status.success());

        let file = read(&dir.0, "m.txt").unwrap();

        assert_eq!(
            file.summary.unwrap().reason,
            ConflictSummaryReason::MarkerLike
        );
        assert!(file.regions.is_empty());
    }
}
