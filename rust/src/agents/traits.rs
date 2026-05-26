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

pub trait AgentProvider: Send + Sync {
    fn build_print_command(
        &self,
        prompt: &str,
        dangerously_skip_permissions: bool,
        resume_session: Option<&str>,
    ) -> PrintCommand;

    fn parse_stream_line(&self, line: &str) -> Vec<AgentEvent>;
}
