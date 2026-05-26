use crate::agents::traits::{AgentProvider, AgentEvent, PrintCommand};
use serde_json::Value;

pub struct ClaudeCode {
    pub model: String,
}

impl ClaudeCode {
    pub fn new(model: &str) -> Self {
        Self {
            model: model.to_string(),
        }
    }
}

fn shell_escape(s: &str) -> String {
    format!("'{}'", s.replace("'", "'\\''"))
}

impl AgentProvider for ClaudeCode {
    fn build_print_command(
        &self,
        prompt: &str,
        dangerously_skip_permissions: bool,
        resume_session: Option<&str>,
    ) -> PrintCommand {
        let skip_perms = if dangerously_skip_permissions {
            " --dangerously-skip-permissions"
        } else {
            ""
        };
        let resume_flag = match resume_session {
            Some(s) => format!(" --resume {}", shell_escape(s)),
            None => "".to_string(),
        };

        PrintCommand {
            command: format!(
                "claude --print --verbose{} --output-format stream-json --model {}{} -p -",
                skip_perms,
                shell_escape(&self.model),
                resume_flag
            ),
            stdin: Some(prompt.to_string()),
        }
    }

    fn parse_stream_line(&self, line: &str) -> Vec<AgentEvent> {
        if !line.starts_with('{') {
            return Vec::new();
        }

        let obj: Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(_) => return Vec::new(),
        };

        let mut events = Vec::new();

        if obj["type"] == "assistant" {
            if let Some(content) = obj["message"]["content"].as_array() {
                let mut texts = String::new();
                for block in content {
                    if block["type"] == "text" {
                        if let Some(text) = block["text"].as_str() {
                            texts.push_str(text);
                        }
                    } else if block["type"] == "tool_use" {
                        if let Some(name) = block["name"].as_str() {
                            let arg_field = match name {
                                "Bash" => Some("command"),
                                "WebSearch" => Some("query"),
                                "WebFetch" => Some("url"),
                                "Agent" => Some("description"),
                                _ => None,
                            };

                            if let Some(field) = arg_field {
                                if let Some(arg_value) = block["input"][field].as_str() {
                                    if !texts.is_empty() {
                                        events.push(AgentEvent::Text(texts.clone()));
                                        texts.clear();
                                    }
                                    events.push(AgentEvent::ToolCall {
                                        name: name.to_string(),
                                        args: arg_value.to_string(),
                                    });
                                }
                            }
                        }
                    }
                }
                if !texts.is_empty() {
                    events.push(AgentEvent::Text(texts));
                }
                return events;
            }
        }

        if obj["type"] == "result" {
            if let Some(result) = obj["result"].as_str() {
                return vec![AgentEvent::Result(result.to_string())];
            }
        }

        if obj["type"] == "system" && obj["subtype"] == "init" {
            if let Some(session_id) = obj["session_id"].as_str() {
                return vec![AgentEvent::SessionId(session_id.to_string())];
            }
        }

        Vec::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_claude_code_build_print_command() {
        let provider = ClaudeCode::new("claude-sonnet");
        let cmd = provider.build_print_command("hello", true, Some("session-123"));
        
        assert!(cmd.command.contains("--dangerously-skip-permissions"));
        assert!(cmd.command.contains("--model 'claude-sonnet'"));
        assert!(cmd.command.contains("--resume 'session-123'"));
        assert_eq!(cmd.stdin, Some("hello".to_string()));
    }

    #[test]
    fn test_claude_code_parse_stream_line_text() {
        let provider = ClaudeCode::new("claude-sonnet");
        let line = r#"{"type":"assistant","message":{"content":[{"type":"text","text":"Hello world"}]}}"#;
        let events = provider.parse_stream_line(line);
        
        assert_eq!(events.len(), 1);
        if let AgentEvent::Text(text) = &events[0] {
            assert_eq!(text, "Hello world");
        } else {
            panic!("Expected Text event");
        }
    }

    #[test]
    fn test_claude_code_parse_stream_line_tool_call() {
        let provider = ClaudeCode::new("claude-sonnet");
        let line = r#"{"type":"assistant","message":{"content":[{"type":"text","text":"Running command..."},{"type":"tool_use","name":"Bash","input":{"command":"ls -la"}}]}}"#;
        let events = provider.parse_stream_line(line);
        
        assert_eq!(events.len(), 2);
        if let AgentEvent::Text(text) = &events[0] {
            assert_eq!(text, "Running command...");
        } else {
            panic!("Expected Text event");
        }
        
        if let AgentEvent::ToolCall { name, args } = &events[1] {
            assert_eq!(name, "Bash");
            assert_eq!(args, "ls -la");
        } else {
            panic!("Expected ToolCall event");
        }
    }

    #[test]
    fn test_claude_code_parse_stream_line_result() {
        let provider = ClaudeCode::new("claude-sonnet");
        let line = r#"{"type":"result","result":"Success"}"#;
        let events = provider.parse_stream_line(line);
        
        assert_eq!(events.len(), 1);
        if let AgentEvent::Result(res) = &events[0] {
            assert_eq!(res, "Success");
        } else {
            panic!("Expected Result event");
        }
    }

    #[test]
    fn test_claude_code_parse_stream_line_session_id() {
        let provider = ClaudeCode::new("claude-sonnet");
        let line = r#"{"type":"system","subtype":"init","session_id":"sess_123"}"#;
        let events = provider.parse_stream_line(line);
        
        assert_eq!(events.len(), 1);
        if let AgentEvent::SessionId(id) = &events[0] {
            assert_eq!(id, "sess_123");
        } else {
            panic!("Expected SessionId event");
        }
    }
}
