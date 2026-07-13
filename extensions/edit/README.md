# Enhanced Edit Tool

Overrides pi's built-in `edit` tool with improved error messages, fuzzy matching, and file corruption fixes.

## Improvements over built-in

| Issue | Built-in | Enhanced |
|-------|----------|----------|
| **File corruption on fuzzy match** | Uses NFKC normalization which can expand characters (`ﬁ`→`fi`); affected lines get corrupted | Uses only 1:1 transforms; maps fuzzy positions back to original content; only the matched region is replaced |
| **Tab fuzzy matching** | Cannot match tabs vs spaces | Normalizes `\t` → 2 spaces for matching |
| **Error on not-found** | `Could not find edits[1]` | Shows exact `oldText`, length, line count, first line |
| **File context** | None | `>` markers with 3 lines of surrounding content |
| **Tips** | "must match exactly" | Specific: check indentation, use `read`, include newlines |
| **Duplicate error** | Generic | Shows which text appeared multiple times |
| **Fuzzy uniqueness** | Checks only fuzzy space (different originals that normalize the same are treated as duplicates) | Falls back to original-space uniqueness check |
| **Preview/execution divergence** | N/A (built-in renderer is consistent) | Custom `renderCall`/`renderResult` using the same enhanced matching engine |

## Critical bug fixed: file corruption

When the built-in's fuzzy matching fires (e.g. smart quotes, trailing whitespace), it uses `text.normalize("NFKC")` which can expand single characters to multiple (e.g. ligatures `ﬁ` → `fi`). The built-in's `applyReplacementsPreservingUnchangedLines` then rewrites affected lines from the normalized content, corrupting those lines.

This extension fixes the corruption by:
1. Not using NFKC normalization — only 1:1 character transforms (smart quotes, dashes, spaces)
2. Mapping fuzzy match positions back to original content offsets
3. Applying edits to the **original** content — unrelated bytes are untouched

## Features absorbed from built-in (verified against v0.80.6)

The built-in has evolved; these features were absorbed to stay compatible:

| Feature | Description |
|---------|-------------|
| **`renderShell: "self"`** | Tool renders its own shell (background/padding) instead of being wrapped in the default Box, avoiding double-boxing |
| **`file_path` field support** | Handles models that send `file_path` instead of `path` — remapped in `prepareArguments` (goes beyond built-in, which only handles it in rendering) and used in all render functions |
| **`resolveToCwd`** | Resolves paths with `~` expansion, Unicode space normalization, `@` prefix stripping, and `file://` URL handling (built-in's `resolveToCwd` is not exported, so reimplemented) |
| **`renderToolPath`** | Path display shortened with `~` and clickable hyperlinks (OSC 8) when terminal supports it |
| **Error deduplication** | `renderResult` skips error text if it's already shown in the call component's preview |
| **Result diff fallback** | Shows result diff in the result body when no `callComponent` exists (e.g. session restore edge cases) |
| **`setEditPreview`** | Proper change detection helper comparing error↔diff transitions, `diff`, and `firstChangedLine` |

## What's preserved (aligned with built-in v0.80.6)

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

> Note: the built-in relaxed `additionalProperties` from `false` to `true` in v0.80.5
> (CHANGELOG #6278, so model-invented fields like `explanation` are accepted). This
> extension matches that, so otherwise-valid edits are not rejected.

## What's different from built-in

- **No NFKC normalization**: The built-in uses `text.normalize("NFKC")` which can expand single characters to multiple (e.g. ligatures `ﬁ` → `fi`), breaking position mapping back to original content. The explicit smart-quote, dash, and space replacements are all 1:1 character transforms and cover the practical cases.
- **Custom rendering**: Provides `renderCall`/`renderResult` that compute previews using the enhanced matching engine, avoiding preview/execution divergence.
- **`throwIfAborted()` pattern**: Uses the same check-after-each-await pattern as the built-in (not `signal.addEventListener`), avoiding premature mutation queue release.

## How it works

Registers a tool named `edit` (same as the built-in). pi's extension system automatically uses the extension version when both are registered. Custom `renderCall`/`renderResult` are provided to ensure the preview uses the same enhanced matching engine as execution.

## Dependencies

- `diff` (for unified patch generation and diff computation)
