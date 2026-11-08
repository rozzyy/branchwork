use crate::{diff, error::AppError};
use git2::{BranchType, Oid, Repository, Status, StatusOptions};
use serde::Serialize;
use std::{
    cmp::Reverse,
    collections::{BTreeSet, BinaryHeap, HashMap, HashSet},
    path::{Path, PathBuf},
};

pub const GRAPH_PAGE_SIZE: usize = 500;

type WorktreeRepositories = Vec<(PathBuf, Repository)>;
type CommitIndex = HashMap<Oid, CommitRecord>;
type RefIndex = HashMap<Oid, Vec<GraphRef>>;

#[derive(Debug, Clone, Serialize, PartialEq, Eq, PartialOrd, Ord, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum GraphRefKind {
    LocalBranch,
    RemoteBranch,
    Tag,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq, PartialOrd, Ord, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct GraphRef {
    pub name: String,
    pub kind: GraphRefKind,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct GraphNode {
    pub lane: usize,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct GraphEdge {
    pub from_lane: usize,
    pub to_lane: usize,
    pub parent_index: usize,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct GraphWorktreeHead {
    pub path: String,
    pub branch: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct GraphCommit {
    pub sha: String,
    pub short_sha: String,
    pub parents: Vec<String>,
    pub lane: usize,
    pub nodes: Vec<GraphNode>,
    pub edges: Vec<GraphEdge>,
    pub parent_lanes: Vec<usize>,
    pub refs: Vec<GraphRef>,
    pub worktree_heads: Vec<GraphWorktreeHead>,
    pub author_name: Option<String>,
    pub author_email: Option<String>,
    pub message: String,
    pub timestamp: i64,
    pub timezone_offset_minutes: i32,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct WipSummary {
    pub worktree_path: String,
    pub head: Option<String>,
    pub branch: Option<String>,
    pub staged_files: Vec<String>,
    pub unstaged_files: Vec<String>,
    pub untracked_files: Vec<String>,
    pub conflicted_files: Vec<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct GraphPage {
    pub page: usize,
    pub page_size: usize,
    pub total_commits: Option<usize>,
    pub has_more: bool,
    pub commits: Vec<GraphCommit>,
    pub wip: WipSummary,
    pub user_email: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct GraphCommitDetail {
    pub sha: String,
    pub changed_paths: Vec<String>,
}

#[derive(Clone)]
struct CommitRecord {
    parents: Vec<Oid>,
    time: i64,
    author_name: Option<String>,
    author_email: Option<String>,
    message: String,
    timezone_offset_minutes: i32,
}

pub fn read(project_path: &Path, worktree_path: &Path, page: usize) -> Result<GraphPage, AppError> {
    let start = page
        .checked_mul(GRAPH_PAGE_SIZE)
        .ok_or_else(|| AppError::validation("Graph page is out of range"))?;
    let end = start
        .checked_add(GRAPH_PAGE_SIZE)
        .ok_or_else(|| AppError::validation("Graph page is out of range"))?;
    let lookahead = end
        .checked_add(1)
        .ok_or_else(|| AppError::validation("Graph page is out of range"))?;

    let (main_repository, active_repository, worktrees) =
        open_project_worktrees(project_path, worktree_path)?;
    let (roots, ref_map) = collect_roots_and_refs(&main_repository)?;
    // ponytail: every page re-walks from the tips, so deep pages cost O(page) reads;
    // cache the walk frontier per project if deep paging becomes a hot path.
    let (ordered_oids, records) = collect_commit_prefix(&main_repository, &roots, lookahead)?;
    let has_more = ordered_oids.len() > end;
    let visible_end = end.min(ordered_oids.len());
    let worktree_heads = collect_worktree_heads(&worktrees)?;
    let mut commits = layout_commits(
        &ordered_oids[..visible_end],
        &records,
        &ref_map,
        &worktree_heads,
    )?;
    let commits = if start < commits.len() {
        commits.split_off(start)
    } else {
        Vec::new()
    };

    Ok(GraphPage {
        page,
        page_size: GRAPH_PAGE_SIZE,
        total_commits: (!has_more).then_some(ordered_oids.len()),
        has_more,
        commits,
        wip: read_wip(&active_repository, worktree_path)?,
        user_email: main_repository
            .config()
            .ok()
            .and_then(|config| config.get_string("user.email").ok())
            .map(|email| email.trim().to_owned())
            .filter(|email| !email.is_empty()),
    })
}

pub fn read_commit_detail(
    project_path: &Path,
    worktree_path: &Path,
    sha: &str,
) -> Result<GraphCommitDetail, AppError> {
    let oid = Oid::from_str(sha)
        .map_err(|error| AppError::validation(format!("Invalid commit SHA: {error}")))?;
    let (repository, _, _) = open_project_worktrees(project_path, worktree_path)?;
    let commit = repository
        .find_commit(oid)
        .map_err(|error| format!("Cannot read commit {sha}: {error}"))?;
    let tree = commit
        .tree()
        .map_err(|error| format!("Cannot read commit tree {sha}: {error}"))?;
    let parent_tree = commit.parent(0).ok().and_then(|parent| parent.tree().ok());
    let diff = repository
        .diff_tree_to_tree(parent_tree.as_ref(), Some(&tree), None)
        .map_err(|error| format!("Cannot read changed paths for {sha}: {error}"))?;
    let changed_paths = diff
        .deltas()
        .filter_map(|delta| delta.new_file().path().or_else(|| delta.old_file().path()))
        .map(|path| path.to_string_lossy().into_owned())
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect();
    Ok(GraphCommitDetail {
        sha: oid.to_string(),
        changed_paths,
    })
}

pub fn read_commit_file_diff(
    project_path: &Path,
    worktree_path: &Path,
    sha: &str,
    file_path: &str,
) -> Result<diff::DiffModel, AppError> {
    let (repository, _, _) = open_project_worktrees(project_path, worktree_path)?;
    diff::read_commit_file_diff(&repository, worktree_path, sha, file_path)
}

fn open_project_worktrees(
    project_path: &Path,
    active_path: &Path,
) -> Result<(Repository, Repository, WorktreeRepositories), AppError> {
    if !project_path.is_absolute() || !active_path.is_absolute() {
        return Err(AppError::validation(
            "Project and worktree paths must be absolute",
        ));
    }
    let project_path = project_path
        .canonicalize()
        .map_err(|error| AppError::io(format!("Cannot resolve project path: {error}")))?;
    let project_repository = Repository::open(&project_path)
        .map_err(|error| AppError::not_a_repo(format!("Invalid registered repository: {error}")))?;
    let registered_workdir = project_repository
        .workdir()
        .ok_or_else(|| {
            AppError::not_a_repo("Bare repositories cannot be used for the commit graph")
        })?
        .canonicalize()
        .map_err(|error| AppError::io(format!("Cannot resolve registered worktree: {error}")))?;
    if registered_workdir != project_path {
        return Err(AppError::validation(
            "Registered project path must be a worktree root",
        ));
    }

    let main_path = if project_repository.is_worktree() {
        project_repository
            .commondir()
            .parent()
            .ok_or_else(|| AppError::internal("Cannot resolve main worktree path"))?
    } else {
        project_repository.workdir().ok_or_else(|| {
            AppError::not_a_repo("Bare repositories cannot be used for the commit graph")
        })?
    }
    .canonicalize()
    .map_err(|error| AppError::io(format!("Cannot resolve main worktree path: {error}")))?;
    let main_repository = Repository::open(&main_path)
        .map_err(|error| AppError::not_a_repo(format!("Cannot open main worktree: {error}")))?;
    let common_dir = main_repository
        .commondir()
        .canonicalize()
        .map_err(|error| AppError::io(format!("Cannot resolve common Git directory: {error}")))?;

    let active_path = active_path
        .canonicalize()
        .map_err(|error| AppError::io(format!("Cannot resolve active worktree path: {error}")))?;
    let active_repository = Repository::open(&active_path)
        .map_err(|error| AppError::not_a_repo(format!("Cannot open active worktree: {error}")))?;
    let active_workdir = active_repository
        .workdir()
        .ok_or_else(|| AppError::not_a_repo("Active worktree is a bare repository"))?
        .canonicalize()
        .map_err(|error| AppError::io(format!("Cannot resolve active worktree: {error}")))?;
    let active_common_dir = active_repository
        .commondir()
        .canonicalize()
        .map_err(|error| {
            AppError::io(format!(
                "Cannot resolve active worktree Git directory: {error}"
            ))
        })?;
    if active_workdir != active_path || active_common_dir != common_dir {
        return Err(AppError::validation(
            "Active worktree does not belong to the registered project",
        ));
    }

    let mut worktrees = vec![(
        main_path.clone(),
        Repository::open(&main_path).map_err(|error| {
            AppError::not_a_repo(format!("Cannot reopen main worktree: {error}"))
        })?,
    )];
    let names = main_repository
        .worktrees()
        .map_err(|error| format!("Cannot list linked worktrees: {error}"))?;
    for name in names.iter() {
        let name = name
            .map_err(|error| format!("Cannot decode linked worktree name: {error}"))?
            .ok_or_else(|| "Linked worktree has no name".to_string())?;
        let worktree = main_repository
            .find_worktree(name)
            .map_err(|error| format!("Cannot find linked worktree {name}: {error}"))?;
        let path = worktree.path().canonicalize().map_err(|error| {
            AppError::io(format!("Cannot resolve linked worktree {name}: {error}"))
        })?;
        let repository = Repository::open_from_worktree(&worktree).map_err(|error| {
            AppError::not_a_repo(format!("Cannot open linked worktree {name}: {error}"))
        })?;
        worktrees.push((path, repository));
    }
    worktrees.sort_by(|left, right| left.0.cmp(&right.0));
    if !worktrees.iter().any(|(path, _)| path == &active_path) {
        return Err(AppError::not_found(
            "Active worktree is not registered with the project",
        ));
    }

    Ok((main_repository, active_repository, worktrees))
}

fn collect_roots_and_refs(repository: &Repository) -> Result<(BTreeSet<Oid>, RefIndex), AppError> {
    let mut roots = BTreeSet::new();
    let mut refs: HashMap<Oid, Vec<GraphRef>> = HashMap::new();
    for branch in repository
        .branches(None)
        .map_err(|error| format!("Cannot list repository branches: {error}"))?
    {
        let (branch, branch_type) =
            branch.map_err(|error| format!("Cannot read repository branch: {error}"))?;
        let name = branch
            .name()
            .map_err(|error| format!("Cannot decode branch name: {error}"))?
            .ok_or_else(|| "Branch has no name".to_string())?
            .to_string();
        let reference = branch.get();
        let commit = match reference.peel_to_commit() {
            Ok(commit) => commit,
            Err(_) => continue,
        };
        let kind = match branch_type {
            BranchType::Local => GraphRefKind::LocalBranch,
            BranchType::Remote => GraphRefKind::RemoteBranch,
        };
        roots.insert(commit.id());
        refs.entry(commit.id())
            .or_default()
            .push(GraphRef { name, kind });
    }

    for reference in repository
        .references_glob("refs/tags/*")
        .map_err(|error| format!("Cannot list repository tags: {error}"))?
    {
        let reference =
            reference.map_err(|error| format!("Cannot read repository tag: {error}"))?;
        let Some(name) = reference
            .name()
            .ok()
            .and_then(|name| name.strip_prefix("refs/tags/"))
        else {
            continue;
        };
        if let Ok(commit) = reference.peel_to_commit() {
            refs.entry(commit.id()).or_default().push(GraphRef {
                name: name.to_string(),
                kind: GraphRefKind::Tag,
            });
        }
    }

    for commit_refs in refs.values_mut() {
        commit_refs.sort();
        commit_refs.dedup();
    }
    Ok((roots, refs))
}

fn collect_commit_prefix(
    repository: &Repository,
    roots: &BTreeSet<Oid>,
    limit: usize,
) -> Result<(Vec<Oid>, CommitIndex), AppError> {
    // ponytail: own newest-first walk. Any libgit2 revwalk sort mode walks the
    // whole history before yielding (8.6 s at 100k commits); this stops at `limit`.
    let find = |oid: Oid| {
        repository
            .find_commit(oid)
            .map_err(|error| format!("Cannot read commit {oid}: {error}"))
    };
    // Frontier commits stay loaded so each commit is read once.
    let mut frontier = HashMap::new();
    let mut queue = BinaryHeap::new();
    for root in roots {
        if !frontier.contains_key(root) {
            let commit = find(*root)?;
            queue.push((commit.time().seconds(), *root));
            frontier.insert(*root, commit);
        }
    }
    let mut seen: HashSet<Oid> = frontier.keys().copied().collect();

    let mut ordered = Vec::with_capacity(limit);
    let mut records = HashMap::with_capacity(limit);
    while ordered.len() < limit {
        let Some((_, oid)) = queue.pop() else {
            break;
        };
        let commit = frontier
            .remove(&oid)
            .expect("queued commits are in the frontier");
        let parents: Vec<_> = commit.parent_ids().collect();
        for parent in &parents {
            if seen.insert(*parent) {
                let parent_commit = find(*parent)?;
                queue.push((parent_commit.time().seconds(), *parent));
                frontier.insert(*parent, parent_commit);
            }
        }
        let author = commit.author();
        let time = commit.time();
        records.insert(
            oid,
            CommitRecord {
                parents,
                time: time.seconds(),
                author_name: author.name().ok().map(str::to_string),
                author_email: author.email().ok().map(str::to_string),
                message: commit.message().unwrap_or_default().to_string(),
                timezone_offset_minutes: time.offset_minutes(),
            },
        );
        ordered.push(oid);
    }
    Ok((paged_topo_order(&ordered, &records), records))
}

/// Builds the order one page at a time. Page k is the start of a topological sort
/// over the commits walked up to page k's lookahead that are not on earlier pages,
/// so reading a later page never reorders an earlier one.
fn paged_topo_order(walked: &[Oid], records: &CommitIndex) -> Vec<Oid> {
    let mut ordered = Vec::with_capacity(walked.len());
    let mut placed = HashSet::with_capacity(walked.len());
    let mut window_end = 0;
    while ordered.len() < walked.len() {
        window_end =
            (window_end + GRAPH_PAGE_SIZE + usize::from(window_end == 0)).min(walked.len());
        let candidates: Vec<Oid> = walked[..window_end]
            .iter()
            .filter(|oid| !placed.contains(*oid))
            .copied()
            .collect();
        for oid in topo_order(&candidates, records)
            .into_iter()
            .take(GRAPH_PAGE_SIZE)
        {
            placed.insert(oid);
            ordered.push(oid);
        }
    }
    ordered
}

/// Stable child-before-parent order of a time-ordered prefix. Equals the input
/// unless committer clocks are skewed (a parent newer than its child).
fn topo_order(time_ordered: &[Oid], records: &CommitIndex) -> Vec<Oid> {
    let position: HashMap<Oid, usize> = time_ordered
        .iter()
        .enumerate()
        .map(|(index, oid)| (*oid, index))
        .collect();
    let mut pending_children = vec![0usize; time_ordered.len()];
    for oid in time_ordered {
        for parent in &records[oid].parents {
            if let Some(&index) = position.get(parent) {
                pending_children[index] += 1;
            }
        }
    }
    let mut ready: BinaryHeap<Reverse<usize>> = pending_children
        .iter()
        .enumerate()
        .filter(|(_, count)| **count == 0)
        .map(|(index, _)| Reverse(index))
        .collect();
    let mut ordered = Vec::with_capacity(time_ordered.len());
    while let Some(Reverse(index)) = ready.pop() {
        let oid = time_ordered[index];
        ordered.push(oid);
        for parent in &records[&oid].parents {
            if let Some(&parent_index) = position.get(parent) {
                pending_children[parent_index] -= 1;
                if pending_children[parent_index] == 0 {
                    ready.push(Reverse(parent_index));
                }
            }
        }
    }
    ordered
}

fn collect_worktree_heads(
    worktrees: &[(PathBuf, Repository)],
) -> Result<HashMap<Oid, Vec<GraphWorktreeHead>>, AppError> {
    let mut heads: HashMap<Oid, Vec<GraphWorktreeHead>> = HashMap::new();
    for (path, repository) in worktrees {
        let Ok(head) = repository.head() else {
            continue;
        };
        let Some(oid) = head.target() else {
            continue;
        };
        let path_text = path.to_string_lossy().into_owned();
        let branch = head.shorthand().ok().map(str::to_string);
        heads.entry(oid).or_default().push(GraphWorktreeHead {
            path: path_text,
            branch,
        });
    }
    for worktree_heads in heads.values_mut() {
        worktree_heads.sort_by(|left, right| left.path.cmp(&right.path));
    }
    Ok(heads)
}

fn layout_commits(
    ordered_oids: &[Oid],
    records: &HashMap<Oid, CommitRecord>,
    refs: &HashMap<Oid, Vec<GraphRef>>,
    worktree_heads: &HashMap<Oid, Vec<GraphWorktreeHead>>,
) -> Result<Vec<GraphCommit>, AppError> {
    let mut active_lanes: Vec<Option<Oid>> = Vec::new();
    let mut commits = Vec::with_capacity(ordered_oids.len());
    for oid in ordered_oids {
        let lane = if let Some(lane) = active_lanes.iter().position(|active| active == &Some(*oid))
        {
            lane
        } else if let Some(lane) = active_lanes.iter().position(Option::is_none) {
            active_lanes[lane] = Some(*oid);
            lane
        } else {
            active_lanes.push(Some(*oid));
            active_lanes.len() - 1
        };
        active_lanes[lane] = None;
        let record = &records[oid];
        let mut edges = Vec::with_capacity(record.parents.len());
        let mut parent_lanes = Vec::with_capacity(record.parents.len());
        for (parent_index, parent) in record.parents.iter().enumerate() {
            let parent_lane = if let Some(existing) = active_lanes
                .iter()
                .position(|active| active == &Some(*parent))
            {
                existing
            } else {
                let available = if active_lanes.get(lane).is_some_and(Option::is_none) {
                    Some(lane)
                } else {
                    active_lanes.iter().position(Option::is_none)
                };
                let target = available.unwrap_or_else(|| {
                    active_lanes.push(None);
                    active_lanes.len() - 1
                });
                active_lanes[target] = Some(*parent);
                target
            };
            parent_lanes.push(parent_lane);
            edges.push(GraphEdge {
                from_lane: lane,
                to_lane: parent_lane,
                parent_index,
            });
        }
        let sha = oid.to_string();
        commits.push(GraphCommit {
            // ponytail: fixed 7-char prefix; libgit2 short_id() costs ~4 ms per commit.
            short_sha: sha[..7].to_string(),
            sha,
            parents: record.parents.iter().map(ToString::to_string).collect(),
            lane,
            nodes: vec![GraphNode { lane }],
            edges,
            parent_lanes,
            refs: refs.get(oid).cloned().unwrap_or_default(),
            worktree_heads: worktree_heads.get(oid).cloned().unwrap_or_default(),
            author_name: record.author_name.clone(),
            author_email: record.author_email.clone(),
            message: record.message.clone(),
            timestamp: record.time,
            timezone_offset_minutes: record.timezone_offset_minutes,
        });
    }
    Ok(commits)
}

fn read_wip(repository: &Repository, worktree_path: &Path) -> Result<WipSummary, AppError> {
    let mut options = StatusOptions::new();
    options
        .include_untracked(true)
        .recurse_untracked_dirs(true)
        .include_ignored(false)
        .renames_head_to_index(true)
        .renames_index_to_workdir(true);
    let statuses = repository
        .statuses(Some(&mut options))
        .map_err(|error| format!("Cannot read active worktree status: {error}"))?;
    let mut staged = BTreeSet::new();
    let mut unstaged = BTreeSet::new();
    let mut untracked = BTreeSet::new();
    let mut conflicted = BTreeSet::new();
    for entry in statuses.iter() {
        let path = entry
            .path()
            .ok()
            .map(str::to_string)
            .unwrap_or_else(|| String::from_utf8_lossy(entry.path_bytes()).into_owned());
        let status = entry.status();
        if status.intersects(
            Status::INDEX_NEW
                | Status::INDEX_MODIFIED
                | Status::INDEX_DELETED
                | Status::INDEX_RENAMED
                | Status::INDEX_TYPECHANGE,
        ) {
            staged.insert(path.clone());
        }
        if status.intersects(
            Status::WT_MODIFIED | Status::WT_DELETED | Status::WT_RENAMED | Status::WT_TYPECHANGE,
        ) {
            unstaged.insert(path.clone());
        }
        if status.contains(Status::WT_NEW) {
            untracked.insert(path.clone());
        }
        if status.contains(Status::CONFLICTED) {
            conflicted.insert(path);
        }
    }
    let head = repository.head().ok();
    Ok(WipSummary {
        worktree_path: worktree_path.to_string_lossy().into_owned(),
        head: head
            .as_ref()
            .and_then(|reference| reference.target())
            .map(|oid| oid.to_string()),
        branch: head.and_then(|reference| reference.shorthand().ok().map(str::to_string)),
        staged_files: staged.into_iter().collect(),
        unstaged_files: unstaged.into_iter().collect(),
        untracked_files: untracked.into_iter().collect(),
        conflicted_files: conflicted.into_iter().collect(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use git2::{ObjectType, Signature, Time};
    use std::{
        fs,
        path::PathBuf,
        sync::atomic::{AtomicUsize, Ordering},
        time::Instant,
    };

    static NEXT_DIR: AtomicUsize = AtomicUsize::new(0);

    struct TestDir(PathBuf);

    impl TestDir {
        fn new() -> Self {
            let id = NEXT_DIR.fetch_add(1, Ordering::Relaxed);
            let path = std::env::temp_dir()
                .join(format!("branchwork-m1-graph-{}-{id}", std::process::id()));
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }
    }

    impl Drop for TestDir {
        fn drop(&mut self) {
            fs::remove_dir_all(&self.0).unwrap();
        }
    }

    fn init_repository(path: &Path) -> (Repository, Oid) {
        let repository = Repository::init(path).unwrap();
        let mut config = repository.config().unwrap();
        config.set_str("init.defaultBranch", "main").unwrap();
        config.set_str("user.email", "graph@example.com").unwrap();
        drop(config);
        repository.set_head("refs/heads/main").unwrap();
        fs::write(path.join("tracked.txt"), "initial").unwrap();
        let mut index = repository.index().unwrap();
        index.add_path(Path::new("tracked.txt")).unwrap();
        let tree_id = index.write_tree().unwrap();
        index.write().unwrap();
        let tree = repository.find_tree(tree_id).unwrap();
        let signature = signature(1_000);
        let initial = repository
            .commit(Some("HEAD"), &signature, &signature, "initial", &tree, &[])
            .unwrap();
        drop(tree);
        (repository, initial)
    }

    fn signature(seconds: i64) -> Signature<'static> {
        Signature::new("Graph Author", "graph@example.com", &Time::new(seconds, 0)).unwrap()
    }

    fn make_commit(repository: &Repository, parents: &[Oid], message: &str, seconds: i64) -> Oid {
        let parent_commits: Vec<_> = parents
            .iter()
            .map(|oid| repository.find_commit(*oid).unwrap())
            .collect();
        let tree = if let Some(parent) = parent_commits.first() {
            parent.tree().unwrap()
        } else {
            repository
                .find_tree(repository.index().unwrap().write_tree().unwrap())
                .unwrap()
        };
        let parent_refs: Vec<_> = parent_commits.iter().collect();
        let signature = signature(seconds);
        let oid = repository
            .commit(None, &signature, &signature, message, &tree, &parent_refs)
            .unwrap();
        drop(tree);
        oid
    }

    fn update_branch(repository: &Repository, name: &str, oid: Oid) {
        repository
            .reference(
                &format!("refs/heads/{name}"),
                oid,
                true,
                "test branch update",
            )
            .unwrap();
    }

    #[test]
    fn reads_branches_merges_tags_linked_worktree_heads_and_wip() {
        let temp = TestDir::new();
        let main_path = temp.0.join("repo");
        fs::create_dir(&main_path).unwrap();
        let (repository, initial) = init_repository(&main_path);
        let main_tip = make_commit(&repository, &[initial], "main work", 1_002);
        update_branch(&repository, "main", main_tip);
        let feature_tip = make_commit(&repository, &[initial], "feature work", 1_003);
        update_branch(&repository, "feature", feature_tip);
        repository
            .reference(
                "refs/remotes/origin/feature",
                feature_tip,
                true,
                "test remote",
            )
            .unwrap();
        repository
            .reference("refs/tags/v1", feature_tip, true, "test tag")
            .unwrap();
        let merge = make_commit(
            &repository,
            &[main_tip, feature_tip],
            "merge feature",
            1_004,
        );
        update_branch(&repository, "main", merge);

        let linked_path = temp.0.join("linked");
        repository.worktree("linked", &linked_path, None).unwrap();
        fs::write(linked_path.join("staged.txt"), "staged").unwrap();
        let linked_repository = Repository::open(&linked_path).unwrap();
        let mut index = linked_repository.index().unwrap();
        index.add_path(Path::new("staged.txt")).unwrap();
        index.write().unwrap();
        fs::write(linked_path.join("tracked.txt"), "unstaged").unwrap();
        fs::write(linked_path.join("untracked.txt"), "new").unwrap();

        let page = read(&main_path, &linked_path, 0).unwrap();
        assert_eq!(page.user_email.as_deref(), Some("graph@example.com"));
        let merge_row = page
            .commits
            .iter()
            .find(|row| row.sha == merge.to_string())
            .unwrap();
        assert_eq!(
            merge_row.parents,
            vec![main_tip.to_string(), feature_tip.to_string()]
        );
        assert_eq!(
            merge_row.nodes,
            vec![GraphNode {
                lane: merge_row.lane
            }]
        );
        assert_eq!(merge_row.parent_lanes, vec![merge_row.lane, 1]);
        assert_eq!(
            merge_row.edges,
            vec![
                GraphEdge {
                    from_lane: merge_row.lane,
                    to_lane: merge_row.lane,
                    parent_index: 0,
                },
                GraphEdge {
                    from_lane: merge_row.lane,
                    to_lane: 1,
                    parent_index: 1,
                },
            ]
        );
        assert!(
            merge_row
                .refs
                .iter()
                .any(|reference| reference.name == "main")
        );
        let feature_row = page
            .commits
            .iter()
            .find(|row| row.sha == feature_tip.to_string())
            .unwrap();
        assert!(feature_row.refs.iter().any(|reference| {
            reference.name == "feature" && reference.kind == GraphRefKind::LocalBranch
        }));
        assert!(feature_row.refs.iter().any(|reference| {
            reference.name == "origin/feature" && reference.kind == GraphRefKind::RemoteBranch
        }));
        assert!(
            feature_row
                .refs
                .iter()
                .any(|reference| { reference.name == "v1" && reference.kind == GraphRefKind::Tag })
        );
        assert!(
            merge_row
                .worktree_heads
                .iter()
                .any(|head| head.path == linked_path.canonicalize().unwrap().to_string_lossy())
        );
        let expected_wip_head = linked_repository
            .head()
            .unwrap()
            .target()
            .unwrap()
            .to_string();
        assert_eq!(page.wip.head.as_deref(), Some(expected_wip_head.as_str()));
        assert_eq!(page.wip.branch.as_deref(), Some("linked"));
        assert_eq!(page.wip.staged_files, vec!["staged.txt"]);
        assert_eq!(page.wip.unstaged_files, vec!["tracked.txt"]);
        assert_eq!(page.wip.untracked_files, vec!["untracked.txt"]);

        let repeated = read(&main_path, &linked_path, 0).unwrap();
        assert_eq!(
            page.commits
                .iter()
                .map(|row| (&row.sha, row.lane, &row.parent_lanes))
                .collect::<Vec<_>>(),
            repeated
                .commits
                .iter()
                .map(|row| (&row.sha, row.lane, &row.parent_lanes))
                .collect::<Vec<_>>()
        );
    }

    #[test]
    fn paginates_500_commits_with_stable_lanes_and_no_boundary_duplicates() {
        let temp = TestDir::new();
        let path = temp.0.join("repo");
        fs::create_dir(&path).unwrap();
        let (repository, mut parent) = init_repository(&path);
        for index in 1..501 {
            parent = make_commit(
                &repository,
                &[parent],
                &format!("commit {index}"),
                1_000 + index as i64,
            );
        }
        update_branch(&repository, "main", parent);

        let first = read(&path, &path, 0).unwrap();
        let repeated = read(&path, &path, 0).unwrap();
        let second = read(&path, &path, 1).unwrap();
        assert_eq!(first.commits.len(), GRAPH_PAGE_SIZE);
        assert_eq!(first.total_commits, None);
        assert!(first.has_more);
        assert_eq!(second.commits.len(), 1);
        assert_eq!(second.total_commits, Some(501));
        assert!(!second.has_more);
        assert_eq!(first.commits, repeated.commits);
        assert_ne!(first.commits[0].sha, second.commits[0].sha);
        let boundary = &first.commits[GRAPH_PAGE_SIZE - 1];
        assert_eq!(boundary.parents, vec![second.commits[0].sha.clone()]);
        assert_eq!(boundary.parent_lanes, vec![second.commits[0].lane]);
        assert!(
            first
                .commits
                .windows(2)
                .all(|rows| rows[0].sha != rows[1].sha)
        );
    }

    #[test]
    fn orders_children_before_parents_when_clocks_are_skewed() {
        let temp = TestDir::new();
        let path = temp.0.join("repo");
        fs::create_dir(&path).unwrap();
        let (repository, initial) = init_repository(&path);
        let future_parent = make_commit(&repository, &[initial], "future parent", 9_000);
        let past_child = make_commit(&repository, &[future_parent], "past child", 2_000);
        let side_child = make_commit(&repository, &[future_parent], "side child", 8_000);
        update_branch(&repository, "main", past_child);
        update_branch(&repository, "side", side_child);

        let page = read(&path, &path, 0).unwrap();
        let shas: Vec<_> = page
            .commits
            .iter()
            .map(|commit| commit.sha.clone())
            .collect();
        assert_eq!(
            shas,
            vec![
                side_child.to_string(),
                past_child.to_string(),
                future_parent.to_string(),
                initial.to_string()
            ]
        );
    }

    #[test]
    fn keeps_pages_consistent_when_a_skewed_child_is_past_the_page_cut() {
        let temp = TestDir::new();
        let path = temp.0.join("repo");
        fs::create_dir(&path).unwrap();
        let (repository, initial) = init_repository(&path);
        let mut main = initial;
        for index in 1..1199 {
            main = make_commit(&repository, &[main], "main", 10_000 + 2 * index as i64);
        }
        // Walked at index 499, while its older-dated child is walked near 700.
        let parent = make_commit(&repository, &[initial], "skewed parent", 11_401);
        let child = make_commit(&repository, &[parent], "older child", 10_997);
        let tip = make_commit(&repository, &[main, parent], "merge", 12_398);
        update_branch(&repository, "main", tip);
        update_branch(&repository, "side", child);

        let mut shas = Vec::new();
        for page in 0.. {
            let graph = read(&path, &path, page).unwrap();
            shas.extend(graph.commits.into_iter().map(|commit| commit.sha));
            if !graph.has_more {
                break;
            }
        }
        let unique: HashSet<_> = shas.iter().collect();
        assert_eq!(shas.len(), 1202);
        assert_eq!(unique.len(), 1202);
    }

    #[test]
    fn rejects_worktrees_outside_the_registered_project() {
        let temp = TestDir::new();
        let path = temp.0.join("repo");
        let unrelated = temp.0.join("unrelated");
        fs::create_dir(&path).unwrap();
        fs::create_dir(&unrelated).unwrap();
        init_repository(&path);
        init_repository(&unrelated);

        let error = read(&path, &unrelated, 0).unwrap_err();
        assert!(error.message.contains("does not belong"));
    }

    #[test]
    fn reads_changed_paths_for_the_selected_commit() {
        let temp = TestDir::new();
        let path = temp.0.join("repo");
        fs::create_dir(&path).unwrap();
        let (repository, initial) = init_repository(&path);
        fs::write(path.join("added.txt"), "added").unwrap();
        let mut index = repository.index().unwrap();
        index.add_path(Path::new("added.txt")).unwrap();
        let tree_id = index.write_tree().unwrap();
        index.write().unwrap();
        let tree = repository.find_tree(tree_id).unwrap();
        let parent = repository.find_commit(initial).unwrap();
        let signature = signature(1_001);
        let changed = repository
            .commit(
                Some("HEAD"),
                &signature,
                &signature,
                "add a file",
                &tree,
                &[&parent],
            )
            .unwrap();
        drop(tree);

        let detail = read_commit_detail(&path, &path, &changed.to_string()).unwrap();

        assert_eq!(detail.sha, changed.to_string());
        assert_eq!(detail.changed_paths, vec!["added.txt"]);
    }

    #[test]
    #[ignore = "manual Stage 3 graph performance measurement"]
    fn measures_first_page_for_100k_commits() {
        let temp = TestDir::new();
        let path = temp.0.join("repo");
        fs::create_dir(&path).unwrap();
        let (repository, initial) = init_repository(&path);
        let tree_id = repository.find_commit(initial).unwrap().tree_id();
        let odb = repository.odb().unwrap();
        let author = "Graph Author <graph@example.com>";
        let mut parent = initial;
        for index in 1..100_000 {
            let timestamp = 1_700_000_000 + index as i64;
            let content = format!(
                "tree {tree_id}\nparent {parent}\nauthor {author} {timestamp} +0000\ncommitter {author} {timestamp} +0000\n\ncommit {index}\n"
            );
            parent = odb.write(ObjectType::Commit, content.as_bytes()).unwrap();
        }
        update_branch(&repository, "main", parent);
        drop(odb);
        drop(repository);

        let start = Instant::now();
        let page = read(&path, &path, 0).unwrap();
        let elapsed = start.elapsed();
        println!(
            "Graph first page: {elapsed:?}, {} rows, has_more={}, known_total={:?}",
            page.commits.len(),
            page.has_more,
            page.total_commits,
        );
        assert_eq!(page.commits.len(), GRAPH_PAGE_SIZE);
        assert!(page.has_more);
        assert_eq!(page.total_commits, None);
    }
}
