---
"@ai-hero/sandcastle": patch
---

Stop a host hook's whole process tree when it times out or is aborted. Before, `run()` rejected with "Host hook '…' timed out" but the hook (and anything it started, such as `sleep` in `sleep 15; echo late > f`) kept running and wrote its side effects after the run was over. A `copyToWorktree` copy that times out now kills its `cp` too.
