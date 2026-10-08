# Support Vercel Sandbox SDK 2.x and 3.x, but not 1.x

Sandcastle supports `@vercel/sandbox` versions `>=2.0.0 <4`. The Vercel sandbox provider discovers the sandbox's default working directory at runtime because SDK 2.x starts in `/vercel/sandbox` while SDK 3.x starts in `/vercel`; this keeps the provider independent of either filesystem layout.

## Considered options

- **Keep the previous `>=1.0.0` range.** Rejected because real-provider tests found unreliable streaming in early 1.x releases: 1.0.2 lost output from both single and concurrent commands, and 1.1.0 lost output from concurrent commands. Although 1.10.2 passed, there is no documented compatibility boundary within 1.x, and an SDK-specific buffered or serialized fallback would weaken the provider's streaming and concurrency behavior.
- **Require 2.9.2 or newer.** Rejected because 2.0.0 passed the same real-provider harness, including a 200 KB stdin payload, streaming output, empty stdin, concurrent execution, non-zero exits, and temporary-file cleanup.
- **Allow 4.x and newer.** Rejected until a future major version is tested because Vercel has already changed its default filesystem layout across major versions.

## Consequences

The optional peer dependency range is narrower than Sandcastle's previous declaration, so this change receives a minor release while Sandcastle is pre-1.0. Supporting a future Vercel SDK major requires verifying the real provider behavior and deliberately widening the range.
