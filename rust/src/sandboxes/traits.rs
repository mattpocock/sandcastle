use async_trait::async_trait;
use crate::errors::SandcastleError;

#[derive(Default)]
pub struct ExecOptions {
    pub cwd: Option<String>,
    pub sudo: bool,
    pub stdin: Option<String>,
}

pub struct ExecResult {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: i32,
}

#[async_trait]
pub trait Sandbox: Send + Sync {
    async fn exec(
        &self,
        command: &str,
        options: ExecOptions,
    ) -> Result<ExecResult, SandcastleError>;

    async fn copy_in(&self, host_path: &str, sandbox_path: &str) -> Result<(), SandcastleError>;
    async fn copy_out(&self, sandbox_path: &str, host_path: &str) -> Result<(), SandcastleError>;
    async fn close(&self) -> Result<(), SandcastleError>;
}
