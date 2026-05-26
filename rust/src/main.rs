use clap::{Parser, Subcommand};
use sandcastle::orchestrator::Orchestrator;
use sandcastle::sandboxes::NoSandbox;
use sandcastle::agents::ClaudeCode;

#[derive(Parser)]
#[command(name = "sandcastle")]
#[command(about = "CLI for orchestrating AI agents in isolated sandbox environments", version)]
struct Cli {
    #[command(subcommand)]
    command: Commands,
}

#[derive(Subcommand)]
enum Commands {
    /// Initialize a new Sandcastle project
    Init {
        #[arg(short, long)]
        template: Option<String>,
    },
    /// Run an agent with a prompt
    Run {
        #[arg(short, long)]
        prompt: String,
        #[arg(short, long, default_value_t = 3)]
        max_iterations: usize,
    },
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let cli = Cli::parse();

    match cli.command {
        Commands::Init { template } => {
            println!("Initializing project with template: {:?}", template);
            // TODO: Implement scaffold logic
        }
        Commands::Run { prompt, max_iterations } => {
            let sandbox = Box::new(NoSandbox {
                worktree_path: ".".to_string(),
            });
            let agent = Box::new(ClaudeCode {
                model: "claude-3-5-sonnet-latest".to_string(),
            });
            let orchestrator = Orchestrator::new(sandbox, agent);
            
            println!("Running agent with prompt: {}", prompt);
            orchestrator.run(&prompt, max_iterations).await?;
        }
    }

    Ok(())
}
