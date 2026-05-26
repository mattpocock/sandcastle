use thiserror::Error;

#[derive(Error, Debug)]
pub enum SandcastleError {
    #[error("ExecError: {message} (command: {command}, exit_code: {exit_code:?})")]
    Exec {
        message: String,
        command: String,
        exit_code: Option<i32>,
    },

    #[error("ExecHostError: {message} (command: {command})")]
    ExecHost {
        message: String,
        command: String,
    },

    #[error("CopyError: {message}")]
    Copy { message: String },

    #[error("DockerError: {message}")]
    Docker { message: String },

    #[error("PodmanError: {message}")]
    Podman { message: String },

    #[error("SyncError: {message}")]
    Sync { message: String },

    #[error("WorktreeError: {message}")]
    Worktree { message: String },

    #[error("PromptError: {message}")]
    Prompt { message: String },

    #[error("AgentError: {message} (preserved_worktree: {preserved_worktree_path:?})")]
    Agent {
        message: String,
        preserved_worktree_path: Option<String>,
    },

    #[error("ConfigDirError: {message}")]
    ConfigDir { message: String },

    #[error("InitError: {message}")]
    Init { message: String },

    #[error("AgentIdleTimeoutError: {message} (timeout_ms: {timeout_ms})")]
    AgentIdleTimeout {
        message: String,
        timeout_ms: u64,
        preserved_worktree_path: Option<String>,
    },

    #[error("WorktreeTimeoutError: {message} (timeout_ms: {timeout_ms}, path: {path}, op: {operation})")]
    WorktreeTimeout {
        message: String,
        timeout_ms: u64,
        path: String,
        operation: String, // "create" | "prune"
    },

    #[error("ContainerStartTimeoutError: {message} (timeout_ms: {timeout_ms})")]
    ContainerStartTimeout { message: String, timeout_ms: u64 },
}
