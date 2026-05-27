use crate::errors::SandcastleError;
use chrono::Local;
use std::process::Command;

#[cfg_attr(test, mockall::automock)]
pub trait GitExecutor: Send + Sync {
    fn exec_git(&self, args: Vec<String>, cwd: &str) -> Result<String, SandcastleError>;
}

pub struct RealGitExecutor;

impl GitExecutor for RealGitExecutor {
    fn exec_git(&self, args: Vec<String>, cwd: &str) -> Result<String, SandcastleError> {
        let output = Command::new("git")
            .args(&args)
            .current_dir(cwd)
            .env("LC_ALL", "C")
            .output()
            .map_err(|e| SandcastleError::Worktree {
                message: e.to_string(),
            })?;

        if !output.status.success() {
            return Err(SandcastleError::Worktree {
                message: String::from_utf8_lossy(&output.stderr).trim().to_string(),
            });
        }

        Ok(String::from_utf8_lossy(&output.stdout).to_string())
    }
}

pub struct GitManager {
    pub repo_dir: String,
    pub executor: Box<dyn GitExecutor>,
}

#[derive(Debug, PartialEq)]
pub struct WorktreeEntry {
    pub path: String,
    pub branch: Option<String>,
}

impl GitManager {
    pub fn new(repo_dir: &str) -> Self {
        Self {
            repo_dir: repo_dir.to_string(),
            executor: Box::new(RealGitExecutor),
        }
    }

    pub fn with_executor(repo_dir: &str, executor: Box<dyn GitExecutor>) -> Self {
        Self {
            repo_dir: repo_dir.to_string(),
            executor,
        }
    }

    pub fn exec_git(&self, args: &[&str]) -> Result<String, SandcastleError> {
        self.executor
            .exec_git(args.iter().map(|s| s.to_string()).collect(), &self.repo_dir)
    }

    pub fn get_current_branch(&self) -> Result<String, SandcastleError> {
        let output = self.exec_git(&["rev-parse", "--abbrev-ref", "HEAD"])?;
        Ok(output.trim().to_string())
    }

    pub fn list_worktrees(&self) -> Result<Vec<WorktreeEntry>, SandcastleError> {
        let output = self.exec_git(&["worktree", "list", "--porcelain"])?;
        let mut entries = Vec::new();
        let mut current_path = None;

        for line in output.lines() {
            if let Some(stripped) = line.strip_prefix("worktree ") {
                current_path = Some(stripped.to_string());
            } else if let Some(stripped) = line.strip_prefix("branch ") {
                if let Some(path) = current_path.take() {
                    entries.push(WorktreeEntry {
                        path,
                        branch: Some(stripped.to_string()),
                    });
                }
            } else if line.is_empty()
                && let Some(path) = current_path.take()
            {
                entries.push(WorktreeEntry { path, branch: None });
            }
        }
        Ok(entries)
    }
}

pub fn sanitize_name(name: &str) -> String {
    name.to_lowercase()
        .chars()
        .map(|c| if c.is_alphanumeric() { c } else { '-' })
        .collect()
}

pub fn format_timestamp() -> String {
    Local::now().format("%Y%m%d-%H%M%S").to_string()
}

pub fn generate_temp_branch_name(name: Option<&str>) -> String {
    let ts = format_timestamp();
    match name {
        Some(n) => format!("sandcastle/{}/{}", sanitize_name(n), ts),
        None => format!("sandcastle/{}", ts),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_sanitize_name() {
        assert_eq!(sanitize_name("My Project"), "my-project");
        assert_eq!(sanitize_name("foo_bar"), "foo-bar");
        assert_eq!(sanitize_name("123-ABC"), "123-abc");
        assert_eq!(sanitize_name("!@#$%^&*()"), "----------");
    }

    #[test]
    fn test_generate_temp_branch_name() {
        let name = generate_temp_branch_name(Some("fix-bug"));
        assert!(name.starts_with("sandcastle/fix-bug/"));

        let name_no_suffix = generate_temp_branch_name(None);
        assert!(name_no_suffix.starts_with("sandcastle/"));
    }

    #[test]
    fn test_list_worktrees_parsing() {
        let mut mock = MockGitExecutor::new();
        mock.expect_exec_git()
            .with(
                mockall::predicate::eq(vec!["worktree".to_string(), "list".to_string(), "--porcelain".to_string()]),
                mockall::predicate::eq("/tmp/repo")
            )
            .returning(|_, _| Ok(
                "worktree /tmp/repo\nHEAD 1234567890abcdef\nbranch refs/heads/main\n\nworktree /tmp/wt1\nHEAD 1234567890abcdef\nbranch refs/heads/feature\n\nworktree /tmp/wt2\nHEAD 1234567890abcdef\n\n".to_string()
            ));

        let manager = GitManager::with_executor("/tmp/repo", Box::new(mock));
        let worktrees = manager.list_worktrees().unwrap();

        assert_eq!(worktrees.len(), 3);
        assert_eq!(
            worktrees[0],
            WorktreeEntry {
                path: "/tmp/repo".to_string(),
                branch: Some("refs/heads/main".to_string()),
            }
        );
        assert_eq!(
            worktrees[1],
            WorktreeEntry {
                path: "/tmp/wt1".to_string(),
                branch: Some("refs/heads/feature".to_string()),
            }
        );
        assert_eq!(
            worktrees[2],
            WorktreeEntry {
                path: "/tmp/wt2".to_string(),
                branch: None,
            }
        );
    }
}
