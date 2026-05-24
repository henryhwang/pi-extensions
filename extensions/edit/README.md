# Enhanced Edit Tool

Overrides pi's built-in `edit` tool with improved error messages, fuzzy matching, and file corruption fixes.

## Improvements over built-in

| Issue | Built-in | Enhanced |
|-------|----------|----------|
| **File corruption on fuzzy match** | Normalizes **entire file** to fuzzy space; smart quotes/dashes on unrelated lines silently converted to ASCII | Maps fuzzy positions back to original content; only the matched region is replaced |
| **Tab fuzzy matching** | Cannot match tabs vs spaces | Normalizes `\t` → 2 spaces for matching |
| **Error on not-found** | `Could not find edits[1]` | Shows exact `oldText`, length, line count, first line |
| **File context** | None | `>` markers with 3 lines of surrounding content |
| **Tips** | "must match exactly" | Specific: check indentation, use `read`, include newlines |
| **Duplicate error** | Generic | Shows which text appeared multiple times |
| **Fuzzy uniqueness** | Checks only fuzzy space (different originals that normalize the same are treated as duplicates) | Falls back to original-space uniqueness check |
| **Preview/execution divergence** | N/A (built-in renderer is consistent) | Custom `renderCall`/`renderResult` using the same enhanced matching engine |

## Critical bug fixed: file corruption

When the built-in's fuzzy matching fires (e.g. smart quotes, trailing whitespace), it normalizes the **entire file** to fuzzy space and writes that back. This silently converts smart quotes `""` → `""` and em-dashes `—` → `-` on every line, not just the edited one.

Example:

```
Input:  Line 1 with "smart quotes"    ← \u201C/\u201D
        Line 3 has — dash             ← \u2014

After editing Line 2 (triggered fuzzy match via trailing whitespace):
Output: Line 1 with "smart quotes"    ← now ASCII "
        Line 3 has - dash             ← now ASCII -
```

This extension fixes the corruption by mapping fuzzy match positions back to original content offsets, then applying edits to the **original** content. Unrelated lines are untouched.

## What's preserved (identical to built-in)

- `additionalProperties: false` on both schemas
- `edits` as JSON string handling (Opus 4.6, GLM-5.1)
- Legacy flat `{path, oldText, newText}` format (non-`edits[]` models)
- Line ending normalization (`\r\n` → `\n`)
- BOM stripping (restored on write)
- `withFileMutationQueue` for parallel tool safety
- `Diff.diffLines` LCS-based diff generation
- Unified patch generation (`details.patch`)
- Right-to-left application for stable offsets
- Overlap detection between edits
- Uniqueness check for each `oldText`
- Abort signal handling (`throwIfAborted()` after each await)
- `promptSnippet` and `promptGuidelines` (LLM instructions)

## What's different from built-in

- **No NFKC normalization**: The built-in uses `text.normalize("NFKC")` which can expand single characters to multiple (e.g. ligatures `ﬁ` → `fi`), breaking position mapping back to original content. The explicit smart-quote, dash, and space replacements are all 1:1 character transforms and cover the practical cases.
- **Custom rendering**: Provides `renderCall`/`renderResult` that compute previews using the enhanced matching engine, avoiding preview/execution divergence.
- **`throwIfAborted()` pattern**: Uses the same check-after-each-await pattern as the built-in (not `signal.addEventListener`), avoiding premature mutation queue release.

## How it works

Registers a tool named `edit` (same as the built-in). pi's extension system automatically uses the extension version when both are registered. Custom `renderCall`/`renderResult` are provided to ensure the preview uses the same enhanced matching engine as execution.

## Dependencies

- `diff` (for unified patch generation and diff computation)
