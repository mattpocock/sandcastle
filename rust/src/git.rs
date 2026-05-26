use std::process::Command;
use crate::errors::SandcastleError;
use chrono::Local;

pub struct GitManager {
    pub repo_dir: String,
}

#[derive(Debug)]
pub struct WorktreeEntry {
    pub path: String,
    pub branch: Option<String>,
}

impl GitManager {
    pub fn new(repo_dir: &str) -> Self {
        Self {
            repo_dir: repo_dir.to_string(),
        }
    }

    pub fn exec_git(&self, args: &[&str]) -> Result<String, SandcastleError> {
        let output = Command::new("git")
            .args(args)
            .current_dir(&self.repo_dir)
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

    pub fn get_current_branch(&self) -> Result<String, SandcastleError> {
        let output = self.exec_git(&["rev-parse", "--abbrev-ref", "HEAD"])?;
        Ok(output.trim().to_string())
    }

    pub fn list_worktrees(&self) -> Result<Vec<WorktreeEntry>, SandcastleError> {
        let output = self.exec_git(&["worktree", "list", "--porcelain"])?;
        let mut entries = Vec::new();
        let mut current_path = None;

        for line in output.lines() {
            if line.starts_with("worktree ") {
                current_path = Some(line[9..].to_string());
            } else if line.starts_with("branch ") {
                if let Some(path) = current_path.take() {
                    entries.push(WorktreeEntry {
                        path,
                        branch: Some(line[7..].to_string()),
                    });
                }
            } else if line.is_empty() {
                if let Some(path) = current_path.take() {
                    entries.push(WorktreeEntry {
                        path,
                        branch: None,
                    });
                }
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
