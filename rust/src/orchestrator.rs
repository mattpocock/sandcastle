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
