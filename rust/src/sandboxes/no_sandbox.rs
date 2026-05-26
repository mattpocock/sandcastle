use async_trait::async_trait;
use crate::sandboxes::traits::{Sandbox, ExecOptions, ExecResult};
use crate::errors::SandcastleError;
use std::process::Command;
use std::fs;

pub struct NoSandbox {
    pub worktree_path: String,
}

#[async_trait]
impl Sandbox for NoSandbox {
    async fn exec(
        &self,
        command: &str,
        options: ExecOptions,
    ) -> Result<ExecResult, SandcastleError> {
        let mut cmd = Command::new("sh");
        cmd.arg("-c").arg(command);
        
        if let Some(cwd) = options.cwd {
            cmd.current_dir(cwd);
        } else {
            cmd.current_dir(&self.worktree_path);
        }

        let output = cmd.output().map_err(|e| SandcastleError::Exec {
            message: e.to_string(),
            command: command.to_string(),
            exit_code: None,
        })?;

        Ok(ExecResult {
            stdout: String::from_utf8_lossy(&output.stdout).to_string(),
            stderr: String::from_utf8_lossy(&output.stderr).to_string(),
            exit_code: output.status.code().unwrap_or(-1),
        })
    }

    async fn copy_in(&self, host_path: &str, sandbox_path: &str) -> Result<(), SandcastleError> {
        fs::copy(host_path, sandbox_path).map_err(|e| SandcastleError::Copy {
            message: e.to_string(),
        })?;
        Ok(())
    }

    async fn copy_out(&self, sandbox_path: &str, host_path: &str) -> Result<(), SandcastleError> {
        fs::copy(sandbox_path, host_path).map_err(|e| SandcastleError::Copy {
            message: e.to_string(),
        })?;
        Ok(())
    }

    async fn close(&self) -> Result<(), SandcastleError> {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;
    use std::fs;

    #[tokio::test]
    async fn test_no_sandbox_exec() {
        let dir = tempdir().unwrap();
        let sandbox = NoSandbox {
            worktree_path: dir.path().to_str().unwrap().to_string(),
        };

        let result = sandbox.exec("echo hello", ExecOptions::default()).await.unwrap();
        assert_eq!(result.stdout.trim(), "hello");
        assert_eq!(result.exit_code, 0);

        let result = sandbox.exec("pwd", ExecOptions::default()).await.unwrap();
        // pwd should return the worktree path (normalized)
        let pwd = result.stdout.trim();
        assert!(fs::canonicalize(pwd).unwrap() == fs::canonicalize(dir.path()).unwrap());
    }

    #[tokio::test]
    async fn test_no_sandbox_copy() {
        let dir = tempdir().unwrap();
        let sandbox = NoSandbox {
            worktree_path: dir.path().to_str().unwrap().to_string(),
        };

        let host_file = dir.path().join("host.txt");
        let sandbox_file = dir.path().join("sandbox.txt");

        fs::write(&host_file, "host content").unwrap();
        
        sandbox.copy_in(host_file.to_str().unwrap(), sandbox_file.to_str().unwrap()).await.unwrap();
        assert_eq!(fs::read_to_string(&sandbox_file).unwrap(), "host content");

        fs::write(&sandbox_file, "sandbox content").unwrap();
        sandbox.copy_out(sandbox_file.to_str().unwrap(), host_file.to_str().unwrap()).await.unwrap();
        assert_eq!(fs::read_to_string(&host_file).unwrap(), "sandbox content");
    }
}
