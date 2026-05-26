use async_trait::async_trait;
use crate::sandboxes::traits::{Sandbox, ExecOptions, ExecResult};
use crate::errors::SandcastleError;
use bollard::Docker;

pub struct DockerSandbox {
    pub container_id: String,
    pub docker: Docker,
}

impl DockerSandbox {
    pub fn new(container_id: &str) -> Result<Self, SandcastleError> {
        let docker = Docker::connect_with_local_defaults().map_err(|e| SandcastleError::Docker {
            message: e.to_string(),
        })?;
        Ok(Self {
            container_id: container_id.to_string(),
            docker,
        })
    }
}

#[async_trait]
impl Sandbox for DockerSandbox {
    async fn exec(
        &self,
        _command: &str,
        _options: ExecOptions,
    ) -> Result<ExecResult, SandcastleError> {
        // TODO: Implement exec using bollard
        Err(SandcastleError::Docker {
            message: "Docker execution not fully implemented yet".to_string(),
        })
    }

    async fn copy_in(&self, _host_path: &str, _sandbox_path: &str) -> Result<(), SandcastleError> {
        Ok(())
    }

    async fn copy_out(&self, _sandbox_path: &str, _host_path: &str) -> Result<(), SandcastleError> {
        Ok(())
    }

    async fn close(&self) -> Result<(), SandcastleError> {
        Ok(())
    }
}
