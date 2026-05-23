# Enhanced Edit Tool

Overrides pi's built-in `edit` tool with improved error messages and fuzzy matching.

## Improvements over built-in

| Issue | Built-in | Enhanced |
|-------|----------|----------|
| **Error on not-found** | `Could not find edits[1]` | Shows exact `oldText`, length, line count, first line |
| **File context** | None | `>` markers with 3 lines of surrounding content |
| **Fuzzy matching** | Unicode quotes, dashes, trailing whitespace | + tabs → 2 spaces |
| **Tips** | "must match exactly" | Specific: check indentation, use `read`, include newlines |
| **Duplicate error** | Generic | Shows which text appeared multiple times |

## What's preserved (identical to built-in)

- `additionalProperties: false` on both schemas
- `edits` as JSON string handling (Opus 4.6, GLM-5.1)
- Legacy flat `{path, oldText, newText}` format (non-`edits[]` models)
- Line ending normalization (`\r\n` → `\n`)
- BOM stripping (restored on write)
- `withFileMutationQueue` for parallel tool safety
- `Diff.diffLines` LCS-based diff generation
- Right-to-left application for stable offsets
- Overlap detection between edits
- Uniqueness check for each `oldText`
- Abort signal handling (respects cancellation)
- `promptSnippet` and `promptGuidelines` (LLM instructions)
- No `renderCall`/`renderResult` → inherits built-in renderer

## How it works

Registers a tool named `edit` (same as the built-in). pi's extension system
automatically uses the extension version when both are registered. The built-in
renderer is inherited by omitting `renderCall`/`renderResult`.