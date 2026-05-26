use async_trait::async_trait;
use crate::sandboxes::traits::{Sandbox, ExecOptions, ExecResult};
use crate::errors::SandcastleError;
use bollard::Docker;

#[cfg_attr(test, mockall::automock)]
#[async_trait]
pub trait DockerClient: Send + Sync {
    async fn connect_with_local_defaults() -> Result<Self, SandcastleError> where Self: Sized;
    async fn remove_container(&self, container_id: &str) -> Result<(), SandcastleError>;
}

pub struct RealDockerClient {
    pub docker: Docker,
}

#[async_trait]
impl DockerClient for RealDockerClient {
    async fn connect_with_local_defaults() -> Result<Self, SandcastleError> {
        let docker = Docker::connect_with_local_defaults().map_err(|e| SandcastleError::Docker {
            message: e.to_string(),
        })?;
        Ok(Self { docker })
    }

    async fn remove_container(&self, container_id: &str) -> Result<(), SandcastleError> {
        self.docker.remove_container(container_id, None).await.map_err(|e| SandcastleError::Docker {
            message: e.to_string(),
        })
    }
}

pub struct DockerSandbox {
    pub container_id: String,
    pub client: Box<dyn DockerClient>,
}

impl DockerSandbox {
    pub async fn new(container_id: &str) -> Result<Self, SandcastleError> {
        let client = RealDockerClient::connect_with_local_defaults().await?;
        Ok(Self {
            container_id: container_id.to_string(),
            client: Box::new(client),
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
        self.client.remove_container(&self.container_id).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_docker_sandbox_close() {
        let mut mock_client = MockDockerClient::new();
        mock_client.expect_remove_container()
            .with(mockall::predicate::eq("cont_123"))
            .returning(|_| Ok(()));

        let sandbox = DockerSandbox {
            container_id: "cont_123".to_string(),
            client: Box::new(mock_client),
        };

        sandbox.close().await.unwrap();
    }
}
