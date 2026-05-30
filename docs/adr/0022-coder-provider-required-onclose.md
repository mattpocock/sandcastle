# `coder()` provider's `onClose` is required, with no default

## Context

When a Sandcastle run ends, `IsolatedSandboxHandle.close()` is called. For a Coder workspace there are three reasonable terminal actions:

- `delete` — `coder delete <ws> --yes`. Destroys cloud resources. Re-runs cost a full re-provision (minutes).
- `stop` — `coder stop <ws> --yes`. Workspace persists in stopped state. Re-runs are cheap.
- `leave` — do nothing. Workspace stays running.

Existing isolated providers (`vercel`, `daytona`) implicitly delete on close (`sandbox.stop()` for Vercel; `client.delete(sandbox)` for Daytona). The user has no knob — close means "destroy."

Coder workspaces are different in a way that matters here:

- **Persistence is the norm.** A Coder workspace is more like a developer VM than a Firecracker microVM. Deleting one a user has been living in is destructive in a way that deleting a Vercel sandbox is not.
- **Provisioning is slow.** Re-provisioning takes minutes; the cost of a wrong default is high.
- **Attach mode exists.** When the provider attached to a pre-existing workspace, the only safe behavior is "don't touch it on close" — the run did not create the workspace and has no business changing its state.

A defaulted-to-delete behavior matching Vercel/Daytona is wrong for attach mode (destroys someone's dev workspace silently). A defaulted-to-leave behavior matching attach-mode safety is wrong for create mode (leaks resources for users who forget to specify). Picking either default _and silently flipping it based on mode_ hides a destructive choice behind an inferred discriminator — exactly the kind of thing a user trying to migrate from another provider would not expect.

## Decision

`onClose: "delete" | "stop" | "leave"` is a **required field on `CoderCommonOptions`** with **no default**. Every call to `coder()` must specify what should happen at end of run, regardless of mode.

The TypeScript discriminated-union shape (see `CoderCreateFromTemplateOptions` and `CoderAttachToWorkspaceOptions`) means the field is required at compile time, not runtime — users cannot accidentally omit it.

Rejected alternatives:

- **Default to `"delete"` (Vercel/Daytona parity).** Wrong for attach mode; destructive default in create mode for a user used to long-lived Coder workspaces.
- **Default to `"leave"` (Coder-native intuition).** Resource leak in create mode for users who don't read the docs.
- **Mode-dependent default (`"delete"` on create, `"leave"` on attach).** Hides a destructive choice behind the discriminator; a user switching modes silently changes terminal behavior.
- **Two separate knobs (`onCreateClose`, `onAttachClose`).** Verbose; same value space; nothing to gain over a single required field.

## Consequences

- `coder({ template, onClose: "delete" })` is the minimal create-mode call; `coder({ workspace, onClose: "leave" })` is the minimal attach-mode call.
- The field cannot be omitted; TypeScript compilation fails. Users learn of the choice the first time they import the provider, not when their workspace silently disappears.
- This is an asymmetry with `vercel()` / `daytona()`. Documented in the README's Coder subsection; the asymmetry is intentional.
- Pre-1.0; if the constraint proves too strict, we can relax to a default in a `patch` changeset later. Going the other direction (adding a required field) is a breaking change, so the conservative choice is to be strict now.
