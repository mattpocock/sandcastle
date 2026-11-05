---
"@ai-hero/sandcastle": patch
---

Structured output now works when an agent splits its tagged reply across several assistant messages. Claude Code can continue a long reply in a new message and then repeat only the last message as its final result, so `run()` saw the closing tag without the opening one and threw "Structured output tag <result> not found". `run()` now reads the whole streamed reply in order, and `stdout` holds it once, without the repeated last message. This also applies when a hanging agent is completed by the completion timeout. Thanks @cookerpapa!
