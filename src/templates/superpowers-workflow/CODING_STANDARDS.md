# Coding Standards

<!-- Customize this file with your project's coding standards.
     The reviewer agent loads it during code review via @.sandcastle/CODING_STANDARDS.md
     so these standards are enforced during review without costing tokens during implementation. -->

## Style

### Python

- Use ruff for linting (rules: E, F, W, I)
- Line length: 100 characters
- No single-line ternaries: write `true if x else false` as multi-line
- Import sorting enforced via ruff
- No `Any` type unless absolutely necessary
- Always add return type annotations to functions

### Node / TypeScript

- Use ESLint with @typescript-eslint/parser
- TypeScript strict mode enabled
- Target: ES2022
- Use named exports over default exports
- Module resolution: bundler / esnext
- Paths aliased with `@/*` mapping to project root
- No `Any` type unless absolutely necessary

## Testing

- Every public function must have at least one test
- Use descriptive test names that explain the expected behavior
- Backend: pytest, frontend: jest + playwright for e2e
- Prefer integration tests where they provide more value than unit tests
- Test files co-located with source (backend/tests, frontend/**tests**)
- Do not test hard-coded values — set them in fixtures or config

## Architecture

- Keep modules focused on a single responsibility
- Prefer composition over inheritance
- No comments in code — write self-documenting code with clear names
- Only use these tags when necessary: #TODO, #FIXME, #HACK, #XXX, #NOTE, #TEMP, #REVIEW, #OPTIMIZE, #DEPRECATED
- Use type hints (Python) and TypeScript types to make intent clear
- Avoid deep nesting (max 3 levels of indentation)
- Prefer early returns over nested conditionals
