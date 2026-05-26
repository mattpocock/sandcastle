use crate::sandboxes::traits::{Sandbox, ExecOptions};
use crate::agents::traits::AgentProvider;
use crate::errors::SandcastleError;

pub struct Orchestrator {
    pub sandbox: Box<dyn Sandbox>,
    pub agent: Box<dyn AgentProvider>,
}

impl Orchestrator {
    pub fn new(sandbox: Box<dyn Sandbox>, agent: Box<dyn AgentProvider>) -> Self {
        Self { sandbox, agent }
    }

    pub async fn run(&self, prompt: &str, max_iterations: usize) -> Result<(), SandcastleError> {
        for i in 0..max_iterations {
            println!("Starting iteration {}", i + 1);
            let print_cmd = self.agent.build_print_command(prompt, true, None);
            let result = self.sandbox.exec(&print_cmd.command, ExecOptions {
                stdin: print_cmd.stdin,
                ..Default::default()
            }).await?;
            
            for line in result.stdout.lines() {
                let events = self.agent.parse_stream_line(line);
                for _event in events {
                    // Handle events (text, tool_call, etc.)
                }
            }

            if result.exit_code != 0 {
                return Err(SandcastleError::Exec {
                    message: "Agent iteration failed".to_string(),
                    command: print_cmd.command,
                    exit_code: Some(result.exit_code),
                });
            }

            println!("Iteration {} completed.", i + 1);
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sandboxes::traits::{MockSandbox, ExecResult};
    use crate::agents::traits::{MockAgentProvider, PrintCommand, AgentEvent};
    use mockall::predicate::*;

    #[tokio::test]
    async fn test_orchestrator_run() {
        let mut mock_sandbox = MockSandbox::new();
        let mut mock_agent = MockAgentProvider::new();

        mock_agent.expect_build_print_command()
            .with(eq("do something"), eq(true), eq(None))
            .returning(|_, _, _| PrintCommand {
                command: "agent-cmd".to_string(),
                stdin: Some("prompt".to_string()),
            });

        mock_sandbox.expect_exec()
            .with(eq("agent-cmd"), function(|opts: &ExecOptions| opts.stdin == Some("prompt".to_string())))
            .returning(|_, _| Ok(ExecResult {
                stdout: "line1\nline2".to_string(),
                stderr: "".to_string(),
                exit_code: 0,
            }));

        mock_agent.expect_parse_stream_line()
            .with(eq("line1"))
            .returning(|_| vec![AgentEvent::Text("parsed-line1".to_string())]);

        mock_agent.expect_parse_stream_line()
            .with(eq("line2"))
            .returning(|_| vec![AgentEvent::Text("parsed-line2".to_string())]);

        let orchestrator = Orchestrator::new(Box::new(mock_sandbox), Box::new(mock_agent));
        orchestrator.run("do something", 1).await.unwrap();
    }
}
