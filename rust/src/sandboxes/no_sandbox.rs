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
