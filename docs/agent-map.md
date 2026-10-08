# Agent map dashboard

The local dashboard observes Sandcastle recordings without running agents or
requiring Docker. Start it in another terminal in an instrumented project:

```bash
npx sandcastle dashboard
# http://127.0.0.1:4317
```

Use `--cwd /path/to/project --port 4318` to choose a project or port. Existing
projects must use a package version containing the dashboard and record their
workflow with `createAgentMap`. Updating the dashboard does not require stopping
the agents; restart the dashboard process after updating the package.

## Follow a workflow

- Select a recorded session and batch in the sidebar. **Latest batch** follows
  new batches; selecting a job pins its batch so incoming work does not replace
  the job you are reading.
- **Workflow** shows planning, parallel issue lanes, review and integration.
  Expand **Planner decisions** to understand selected or deferred work.
- Find agents by title, issue, role or branch, or filter by status. **Needs
  attention** includes failed, blocked, stopped, interrupted and unknown agents.
- Select a sidebar job or workflow card to open its **Logs** tab. The URL keeps
  the session, job, batch and tab for reloads or links on the same host.
- On narrow screens, expand **Agents** to browse jobs. On desktop the sidebar
  scrolls independently. The workflow graph scrolls horizontally when needed.

## Read recorded activity

The wide log viewer uses larger monospace text, line numbers and optional line
wrapping. Search highlights text case-insensitively and filters matching
entries; **Previous** and **Next** navigate those entries. The event filter
selects messages, tool calls or a recorded agent error.

**Follow output** scrolls to new activity. Scrolling up disables follow, so
updates do not pull you away from what you are reading. **Pause updates** pauses
only the dashboard, never the agents. Connection failures retain the last
snapshot and retry automatically.

A recording without a heartbeat for 15 seconds is shown as **Unknown**, not
confirmed dead. A sleeping host or blocked runner event loop can cause this.
The map does not steal workflow ownership or launch replacement agents. Legacy
recordings explicitly marked interrupted remain readable.

**Copy visible** copies only currently filtered entries. **Download activity**
exports all retained activity for that agent, regardless of the current filter.
Agent details include branch, model, captured session ID, commits and usage when
reported. Usage is the last reported snapshot, not a billing total.

### Important limits

This is **recent recorded activity, not the full raw log**: the recorder retains
up to 150 activity events per agent and truncates each to 4,000 characters. A
recorded terminal error can appear as an additional entry. Line numbers refer
to the current retained window, not stable raw-file offsets. Use the workflow's
original log files for output outside this window.

Common credential patterns are filtered by the recorder, but this is not a
guarantee that every secret is removed. Review copied/downloaded text before
sharing. The dashboard remains loopback-only and read-only; no execution,
stop/retry, arbitrary file access or hosted sharing controls are added.

## Browser regression checks

From the Sandcastle source repository (Node.js 20+ for Playwright):

```bash
npm ci
npx playwright install chromium
npm run test:dashboard
```

Tests use a temporary recording and a loopback server with simulated agent
output. They do not start Docker, call a model, or mutate GitHub issues. Coverage
includes navigation, mobile layout, untrusted text rendering, search/filtering,
copy/download, live scroll position, batch pinning, reconnects and deep links.
