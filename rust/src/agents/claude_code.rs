use crate::agents::traits::{AgentProvider, AgentEvent};

pub struct ClaudeCode {
    pub model: String,
}

impl AgentProvider for ClaudeCode {
    fn build_print_command(
        &self,
        prompt: &str,
        _dangerously_skip_permissions: bool,
        _resume_session: Option<&str>,
    ) -> String {
        // Simplified for now
        format!("claude-code --model {} --prompt '{}'", self.model, prompt.replace("'", "'\\''"))
    }

    fn parse_stream_line(&self, _line: &str) -> Vec<AgentEvent> {
        // TODO: Implement parsing logic from AgentProvider.ts
        Vec::new()
    }
}
