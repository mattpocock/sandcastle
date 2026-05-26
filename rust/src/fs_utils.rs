use std::process::Command;
use std::path::Path;
use crate::errors::SandcastleError;

pub fn copy_to_worktree(
    paths: &[String],
    host_repo_dir: &str,
    worktree_path: &str,
) -> Result<(), SandcastleError> {
    let platform = std::env::consts::OS;
    let cow_flags = if platform == "macos" {
        vec!["-cR"]
    } else {
        vec!["-R", "--reflink=auto"]
    };

    for relative_path in paths {
        let src = Path::new(host_repo_dir).join(relative_path);
        if !src.exists() {
            continue;
        }
        let dest = Path::new(worktree_path).join(relative_path);

        let mut cmd = Command::new("cp");
        cmd.args(&cow_flags).arg(&src).arg(&dest);

        let output = cmd.output().map_err(|e| SandcastleError::Copy {
            message: e.to_string(),
        })?;

        if !output.status.success() {
            // Fallback
            let mut fallback_cmd = Command::new("cp");
            fallback_cmd.arg("-R").arg(&src).arg(&dest);
            let fallback_output = fallback_cmd.output().map_err(|e| SandcastleError::Copy {
                message: e.to_string(),
            })?;

            if !fallback_output.status.success() {
                return Err(SandcastleError::Copy {
                    message: format!(
                        "Failed to copy {:?} to worktree: {}",
                        relative_path,
                        String::from_utf8_lossy(&fallback_output.stderr).trim()
                    ),
                });
            }
        }
    }
    Ok(())
}

pub fn copy_file_out(
    _sandbox_path: &str,
    _host_path: &str,
    _exec_in_sandbox: impl Fn(&str) -> Result<Vec<u8>, SandcastleError>,
) -> Result<(), SandcastleError> {
    // This is a placeholder logic. Usually it depends on the sandbox provider.
    // For bind-mount, it's just fs::copy.
    // For isolated, it might use `docker cp` or similar.
    Ok(())
}
