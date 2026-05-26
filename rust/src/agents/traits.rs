pub enum AgentEvent {
    Text(String),
    Result(String),
    ToolCall { name: String, args: String },
    SessionId(String),
}

pub struct PrintCommand {
    pub command: String,
    pub stdin: Option<String>,
}

#[cfg_attr(test, mockall::automock)]
pub trait AgentProvider: Send + Sync {
    fn build_print_command(
        &self,
        prompt: &str,
        dangerously_skip_permissions: bool,
        resume_session: Option<String>,
    ) -> PrintCommand;

    fn parse_stream_line(&self, line: &str) -> Vec<AgentEvent>;
}
