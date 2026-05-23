/**
 * Enhanced Edit Tool — improved version of pi's built-in edit tool
 *
 * Fixes identified issues:
 *   1. Shows failing `oldText` in error messages (built-in hides it)
 *   2. Adds tab/space normalization to fuzzy matching
 *   3. Shows nearby file context when match fails
 *   4. More descriptive error messages overall
 *
 * Omits renderCall/renderResult — inherits built-in renderer (diff highlighting).
 */

import type { ExtensionAPI, ExtensionContext, AgentToolUpdateCallback } from "@earendil-works/pi-coding-agent";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "@earendil-works/pi-ai";
import * as Diff from "diff";
import { constants } from "node:fs";
import { access as fsAccess, readFile as fsReadFile, writeFile as fsWriteFile } from "node:fs/promises";
import { resolve } from "node:path";

// ── Schema (same as built-in) ─────────────────────────────────

const replaceEditSchema = Type.Object({
  oldText: Type.String({
    description:
      "Exact text for one targeted replacement. It must be unique in the original file and must not overlap with any other edits[].oldText in the same call.",
  }),
  newText: Type.String({ description: "Replacement text for this targeted edit." }),
}, { additionalProperties: false });

const editSchema = Type.Object({
  path: Type.String({ description: "Path to the file to edit (relative or absolute)" }),
  edits: Type.Array(replaceEditSchema, {
    description:
      "One or more targeted replacements. Each edit is matched against the original file, not incrementally. Do not include overlapping or nested edits. If two changes touch the same block or nearby lines, merge them into one edit instead.",
  }),
}, { additionalProperties: false });

type EditInput = Static<typeof editSchema>;

// ── Line-ending & whitespace utils ────────────────────────────

function detectLineEnding(content: string): "\n" | "\r\n" {
  const crlfIdx = content.indexOf("\r\n");
  const lfIdx = content.indexOf("\n");
  if (lfIdx === -1) return "\n";
  if (crlfIdx === -1) return "\n";
  return crlfIdx < lfIdx ? "\r\n" : "\n";
}

function normalizeToLF(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function restoreLineEndings(text: string, ending: "\n" | "\r\n"): string {
  return ending === "\r\n" ? text.replace(/\n/g, "\r\n") : text;
}

function stripBom(content: string): { bom: string; text: string } {
  return content.startsWith("\uFEFF")
    ? { bom: "\uFEFF", text: content.slice(1) }
    : { bom: "", text: content };
}

// ── Enhanced fuzzy matching ───────────────────────────────────

/**
 * Enhanced normalization: built-in + tabs to 2 spaces.
 */
function normalizeForFuzzyMatch(text: string): string {
  return (
    text
      .normalize("NFKC")
      // tabs to 2 spaces (common indent mismatch)
      .replace(/\t/g, "  ")
      // Strip trailing whitespace per line
      .split("\n")
      .map((line: string) => line.trimEnd())
      .join("\n")
      // Smart single quotes to '
      .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
      // Smart double quotes to "
      .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
      // Various dashes/hyphens to -
      .replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g, "-")
      // Special spaces to regular space
      .replace(/[\u00A0\u2002-\u200A\u202F\u205F\u3000]/g, " ")
  );
}

/**
 * Find oldText in content, trying exact match first, then fuzzy.
 * When content is already fuzzy-normalized, pass isFuzzy=true to skip
 * re-normalizing content (only normalize oldText).
 */
function fuzzyFindText(
  content: string,
  oldText: string,
  contentIsFuzzy = false,
): { found: true; index: number; matchLength: number } | { found: false; index: -1; matchLength: 0 } {
  // Exact match first
  const exactIndex = content.indexOf(oldText);
  if (exactIndex !== -1) {
    return { found: true, index: exactIndex, matchLength: oldText.length };
  }

  // Fuzzy match: normalized content vs normalized oldText
  const fuzzyContent = contentIsFuzzy ? content : normalizeForFuzzyMatch(content);
  const fuzzyOldText = normalizeForFuzzyMatch(oldText);
  const fuzzyIndex = fuzzyContent.indexOf(fuzzyOldText);
  if (fuzzyIndex !== -1) {
    return { found: true, index: fuzzyIndex, matchLength: fuzzyOldText.length };
  }

  return { found: false, index: -1, matchLength: 0 };
}

/**
 * Count occurrences of oldText in already-normalized fuzzy content.
 * Accepts pre-normalized strings to avoid re-normalizing the entire file per edit.
 */
function countOccurrences(fuzzyContent: string, fuzzyOldText: string): number {
  let count = 0;
  let pos = 0;
  while ((pos = fuzzyContent.indexOf(fuzzyOldText, pos)) !== -1) {
    count++;
    pos += fuzzyOldText.length;
  }
  return count;
}

/**
 * Map a position in fuzzy-normalized content back to the original (LF-only) content.
 * Handles: tab→2-spaces expansion, trailing whitespace removal, unicode 1:1 transforms.
 */
function mapFuzzyPosToOriginal(original: string, fuzzy: string, fuzzyPos: number): number {
  let oi = 0;
  let fi = 0;
  while (fi < fuzzyPos && oi < original.length) {
    const oc = original[oi];
    const fc = fuzzy[fi];

    if (oc === "\t" && fc === " " && fi + 1 < fuzzy.length && fuzzy[fi + 1] === " ") {
      // Tab expanded to 2 spaces in fuzzy
      oi++;
      fi += 2;
    } else if (fc === "\n" && oc !== "\n") {
      // Trailing whitespace removed before newline in fuzzy; skip original whitespace
      oi++;
    } else if (oc !== fc) {
      // Unicode normalization (smart quotes, dashes, etc.) — 1:1 mapping
      oi++;
      fi++;
    } else {
      oi++;
      fi++;
    }
  }
  return oi;
}

/**
 * Show context around the area where oldText was expected.
 * Uses first 3 non-empty lines (or 80 chars) of hintText for more accurate matching.
 */
function nearbySnippet(content: string, hintText: string, contextLines = 3): string {
  // Build search keys with increasing specificity from the first non-empty lines of hintText.
  // Try multi-line first (more specific), fall back to fewer lines.
  const hintLines = hintText.split("\n");
  const nonEmpty: string[] = [];
  for (const line of hintLines) {
    const t = line.trim();
    if (t) nonEmpty.push(t);
    if (nonEmpty.length >= 3) break;
  }
  if (!nonEmpty.length) return "";

  const fuzzyContent = normalizeForFuzzyMatch(content);

  // Try matching with progressively fewer lines (3 → 2 → 1)
  let idx = -1;
  for (let n = nonEmpty.length; n >= 1; n--) {
    const searchKey = nonEmpty.slice(0, n).join("\n");
    const fuzzyHint = normalizeForFuzzyMatch(searchKey);
    idx = fuzzyContent.indexOf(fuzzyHint);
    if (idx !== -1) break;
  }
  if (idx === -1) return "";

  const lines = content.split("\n");
  let lineNum = 0;
  let bytePos = 0;
  for (let i = 0; i < lines.length; i++) {
    if (bytePos >= idx) {
      lineNum = i;
      break;
    }
    bytePos += lines[i].length + 1; // +1 for \n
  }

  const start = Math.max(0, lineNum - contextLines);
  const end = Math.min(lines.length, lineNum + contextLines + 1);
  const snippet: string[] = [];
  const lineWidth = String(end).length;

  for (let i = start; i < end; i++) {
    const marker = i === lineNum ? ">" : " ";
    const num = String(i + 1).padStart(lineWidth, " ");
    snippet.push(marker + " " + num + " | " + lines[i]);
  }

  return snippet.join("\n");
}

// ── Core edit logic with improved errors ──────────────────────

interface MatchedEdit {
  editIndex: number;
  matchIndex: number;
  matchLength: number;
  newText: string;
}

function applyEditsWithImprovedErrors(
  normalizedContent: string,
  edits: Array<{ oldText: string; newText: string }>,
  path: string,
): { baseContent: string; newContent: string } {
  // Normalize line endings in edits
  const normalizedEdits = edits.map((e) => ({
    oldText: normalizeToLF(e.oldText),
    newText: normalizeToLF(e.newText),
  }));

  // Empty oldText check
  for (let i = 0; i < normalizedEdits.length; i++) {
    if (normalizedEdits[i].oldText.length === 0) {
      const prefix =
        normalizedEdits.length === 1
          ? "oldText must not be empty in " + path + "."
          : "edits[" + i + "].oldText must not be empty in " + path + ".";
      throw new Error(prefix);
    }
  }

  // Build fuzzy content once (for search/validation), normalizedContent is used for actual edits
  const fuzzyContent = normalizeForFuzzyMatch(normalizedContent);
  const fuzzyEdits = normalizedEdits.map((e) => ({
    ...e,
    fuzzyOldText: normalizeForFuzzyMatch(e.oldText),
  }));

  // First pass: validate all edits exist and are unique in fuzzy space
  // (but record positions in original space for actual editing)
  const matchedEdits: MatchedEdit[] = [];

  for (let i = 0; i < fuzzyEdits.length; i++) {
    const edit = normalizedEdits[i];
    const fuzzyMatch = fuzzyFindText(fuzzyContent, edit.oldText, true);

    if (!fuzzyMatch.found) {
      // IMPROVEMENT: Show what text was searched for
      const oldTextPreview =
        edit.oldText.length > 120
          ? edit.oldText.slice(0, 120) + "..."
          : edit.oldText;
      const firstLine = edit.oldText.split("\n")[0] || "(empty)";
      const lineCount = edit.oldText.split("\n").length;
      const sizeHint =
        lineCount > 1
          ? " (" + lineCount + " lines, " + edit.oldText.length + " chars)"
          : " (" + edit.oldText.length + " chars)";

      // IMPROVEMENT: Show nearby context in the file
      const context = nearbySnippet(normalizedContent, edit.oldText);

      const prefix =
        normalizedEdits.length === 1
          ? "Could not find the exact text in " + path + "."
          : "Could not find edits[" + i + "] in " + path + ".";

      const lines: string[] = [
        prefix,
        "",
        "Searched for:",
        "  " + oldTextPreview + sizeHint,
        "",
        'First line: "' + firstLine + '"',
      ];

      if (context) {
        lines.push("", "Nearby content in file:", context);
      }

      lines.push(
        "",
        "Tips:",
        "  * Check indentation (tabs vs spaces, trailing whitespace)",
        "  * Use read to verify the exact file content",
        "  * If the text spans multiple lines, include the newlines between them",
        "  * oldText must match exactly -- use read to get the precise content",
      );

      throw new Error(lines.join("\n"));
    }

    // Check uniqueness in fuzzy space
    const occurrences = countOccurrences(fuzzyContent, fuzzyEdits[i].fuzzyOldText);
    if (occurrences > 1) {
      const prefix =
        normalizedEdits.length === 1
          ? "Found " + occurrences + " occurrences of the text in " + path + "."
          : "Found " + occurrences + " occurrences of edits[" + i + "] in " + path + ".";

      const oldTextPreview =
        edit.oldText.length > 80
          ? edit.oldText.slice(0, 80) + "..."
          : edit.oldText;

      throw new Error(
        prefix + " Each oldText must be unique.\n" +
          'Searched text: "' + oldTextPreview + '"\n' +
          "Please provide more context (surrounding lines) to make it unique.",
      );
    }

    // Map fuzzy match positions back to original (LF-only) content for the actual edit
    const origStart = mapFuzzyPosToOriginal(normalizedContent, fuzzyContent, fuzzyMatch.index);
    const origEnd = mapFuzzyPosToOriginal(normalizedContent, fuzzyContent, fuzzyMatch.index + fuzzyMatch.matchLength);

    matchedEdits.push({
      editIndex: i,
      matchIndex: origStart,
      matchLength: origEnd - origStart,
      newText: edit.newText,
    });
  }

  // Check for overlapping edits (in original space)
  matchedEdits.sort((a, b) => a.matchIndex - b.matchIndex);
  for (let i = 1; i < matchedEdits.length; i++) {
    const prev = matchedEdits[i - 1];
    const curr = matchedEdits[i];
    if (prev.matchIndex + prev.matchLength > curr.matchIndex) {
      throw new Error(
        "edits[" + prev.editIndex + "] and edits[" + curr.editIndex + "] overlap in " + path + ". " +
          "Merge them into one edit or target disjoint regions.\n" +
          "  edits[" + prev.editIndex + "] ends at position " + (prev.matchIndex + prev.matchLength) + "\n" +
          "  edits[" + curr.editIndex + "] starts at position " + curr.matchIndex,
      );
    }
  }

  // Apply edits to normalizedContent (original, not fuzzy) right-to-left
  let newContent = normalizedContent;
  for (let i = matchedEdits.length - 1; i >= 0; i--) {
    const edit = matchedEdits[i];
    newContent =
      newContent.substring(0, edit.matchIndex) +
      edit.newText +
      newContent.substring(edit.matchIndex + edit.matchLength);
  }

  if (normalizedContent === newContent) {
    const message =
      normalizedEdits.length === 1
        ? "No changes made to " + path + ". The replacement produced identical content. This might indicate an issue with special characters or the text not existing as expected."
        : "No changes made to " + path + ". The replacements produced identical content.";
    throw new Error(message);
  }

  return { baseContent: normalizedContent, newContent };
}

// ── Generate diff string (using the `diff` package) ───────────

function generateDiffString(
  oldContent: string,
  newContent: string,
  contextLines = 4,
): { diff: string; firstChangedLine: number } {
  const parts = Diff.diffLines(oldContent, newContent);
  const output: string[] = [];
  const oldLines = oldContent.split("\n");
  const newLines = newContent.split("\n");
  const maxLineNum = Math.max(oldLines.length, newLines.length);
  const lineNumWidth = String(maxLineNum).length;
  let oldLineNum = 1;
  let newLineNum = 1;
  let lastWasChange = false;
  let firstChangedLine: number | undefined;

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    const raw = part.value.endsWith("\n") ? part.value.slice(0, -1).split("\n") : part.value.split("\n");

    if (part.added || part.removed) {
      if (firstChangedLine === undefined) firstChangedLine = newLineNum;
      for (const line of raw) {
        if (part.added) {
          output.push("+" + String(newLineNum).padStart(lineNumWidth, " ") + " " + line);
          newLineNum++;
        } else {
          output.push("-" + String(oldLineNum).padStart(lineNumWidth, " ") + " " + line);
          oldLineNum++;
        }
      }
      lastWasChange = true;
    } else {
      const nextIsChange = i < parts.length - 1 && (parts[i + 1].added || parts[i + 1].removed);
      const hasLeading = lastWasChange;
      const hasTrailing = nextIsChange;

      if (hasLeading && hasTrailing) {
        if (raw.length <= contextLines * 2) {
          for (const line of raw) {
            output.push(" " + String(oldLineNum).padStart(lineNumWidth, " ") + " " + line);
            oldLineNum++;
            newLineNum++;
          }
        } else {
          const leading = raw.slice(0, contextLines);
          const trailing = raw.slice(raw.length - contextLines);
          for (const line of leading) {
            output.push(" " + String(oldLineNum).padStart(lineNumWidth, " ") + " " + line);
            oldLineNum++;
            newLineNum++;
          }
          output.push(" " + "".padStart(lineNumWidth, " ") + " ...");
          oldLineNum += raw.length - leading.length - trailing.length;
          newLineNum += raw.length - leading.length - trailing.length;
          for (const line of trailing) {
            output.push(" " + String(oldLineNum).padStart(lineNumWidth, " ") + " " + line);
            oldLineNum++;
            newLineNum++;
          }
        }
      } else if (hasLeading) {
        const shown = raw.slice(0, contextLines);
        for (const line of shown) {
          output.push(" " + String(oldLineNum).padStart(lineNumWidth, " ") + " " + line);
          oldLineNum++;
          newLineNum++;
        }
        if (raw.length > contextLines) {
          output.push(" " + "".padStart(lineNumWidth, " ") + " ...");
          oldLineNum += raw.length - contextLines;
          newLineNum += raw.length - contextLines;
        }
      } else if (hasTrailing) {
        const skipped = Math.max(0, raw.length - contextLines);
        if (skipped > 0) {
          output.push(" " + "".padStart(lineNumWidth, " ") + " ...");
          oldLineNum += skipped;
          newLineNum += skipped;
        }
        for (const line of raw.slice(skipped)) {
          output.push(" " + String(oldLineNum).padStart(lineNumWidth, " ") + " " + line);
          oldLineNum++;
          newLineNum++;
        }
      } else {
        oldLineNum += raw.length;
        newLineNum += raw.length;
      }
      lastWasChange = false;
    }
  }

  return { diff: output.join("\n"), firstChangedLine: firstChangedLine ?? 1 };
}

// ── Extension ─────────────────────────────────────────────────

export default function enhancedEditExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "edit",
    label: "edit (enhanced)",
    description: [
      "Edit a single file using exact text replacement. Every edits[].oldText must match a unique, non-overlapping region of the original file.",
      "",
      "Improvements over built-in:",
      "  * Shows exact oldText being searched for in error messages",
      "  * Fuzzy-matches whitespace (tabs vs spaces, trailing whitespace)",
      "  * Shows nearby file content when match fails",
      "  * Gives actionable tips on how to fix the edit",
    ].join("\n"),
    parameters: editSchema,
    promptSnippet:
      "Make precise file edits with exact text replacement, including multiple disjoint edits in one call",
    promptGuidelines: [
      "Use edit for precise changes (edits[].oldText must match exactly)",
      "When changing multiple separate locations in one file, use one edit call with multiple entries in edits[] instead of multiple edit calls",
      "Each edits[].oldText is matched against the original file, not after earlier edits are applied. Do not emit overlapping or nested edits. Merge nearby changes into one edit.",
      "Keep edits[].oldText as small as possible while still being unique in the file. Do not pad with large unchanged regions.",
    ],

    prepareArguments(input: unknown): EditInput {
      if (!input || typeof input !== "object") return input as EditInput;
      const args = input as Record<string, unknown>;

      // Some models send edits as JSON string
      if (typeof args.edits === "string") {
        try {
          const parsed = JSON.parse(args.edits);
          if (Array.isArray(parsed)) args.edits = parsed;
        } catch {
          // ignore parse errors
        }
      }

      // Some models send flat {path, oldText, newText} instead of {path, edits: [...]}
      if (typeof args.oldText === "string" && typeof args.newText === "string") {
        const edits = Array.isArray(args.edits) ? [...args.edits] : [];
        edits.push({ oldText: args.oldText, newText: args.newText });
        const { oldText: _oldText, newText: _newText, ...rest } = args;
        return { ...rest, edits } as EditInput;
      }

      return args as EditInput;
    },

    async execute(
      _toolCallId: string,
      params: EditInput,
      signal: AbortSignal | undefined,
      _onUpdate: AgentToolUpdateCallback<{ diff: string; firstChangedLine?: number }> | undefined,
      ctx: ExtensionContext,
    ) {
      const { path, edits } = params;
      const cwd = ctx.cwd;
      const absolutePath = resolve(cwd, path);

      return withFileMutationQueue(absolutePath, () =>
        new Promise<{
          content: Array<{ type: "text"; text: string }>;
          details: { diff: string; firstChangedLine?: number };
        }>((resolve, reject) => {
          if (signal?.aborted) {
            reject(new Error("Operation aborted"));
            return;
          }

          let aborted = false;
          const onAbort = () => {
            aborted = true;
            reject(new Error("Operation aborted"));
          };
          if (signal) signal.addEventListener("abort", onAbort, { once: true });

          void (async () => {
            try {
              // Validate edits array
              if (!Array.isArray(edits) || edits.length === 0) {
                reject(new Error("edits must contain at least one replacement."));
                return;
              }

              // Check file existence/access
              try {
                await fsAccess(absolutePath, constants.R_OK | constants.W_OK);
              } catch (error: unknown) {
                const code =
                  error instanceof Error && "code" in error
                    ? (error as NodeJS.ErrnoException).code
                    : "UNKNOWN";
                reject(new Error("Could not edit file: " + path + ". Error code: " + code + "."));
                return;
              }

              if (aborted) return;

              // Read file
              const buffer = await fsReadFile(absolutePath);
              const rawContent = buffer.toString("utf-8");
              if (aborted) return;

              // Strip BOM
              const { bom, text: content } = stripBom(rawContent);
              const originalEnding = detectLineEnding(content);
              const normalizedContent = normalizeToLF(content);

              // Apply edits with improved error messages
              const { baseContent, newContent } = applyEditsWithImprovedErrors(
                normalizedContent,
                edits,
                path,
              );

              if (aborted) return;

              // Write
              const finalContent = bom + restoreLineEndings(newContent, originalEnding);
              await fsWriteFile(absolutePath, finalContent, "utf-8");
              if (aborted) return;

              if (signal) signal.removeEventListener("abort", onAbort);

              const diffResult = generateDiffString(baseContent, newContent);
              resolve({
                content: [
                  {
                    type: "text" as const,
                    text: "Successfully replaced " + edits.length + " block(s) in " + path + ".",
                  },
                ],
                details: {
                  diff: diffResult.diff,
                  firstChangedLine: diffResult.firstChangedLine,
                },
              });
            } catch (error) {
              if (signal) signal.removeEventListener("abort", onAbort);
              if (!aborted) {
                reject(error instanceof Error ? error : new Error(String(error)));
              }
            }
          })();
        }),
      );
    },

    // No renderCall/renderResult -- inherits built-in renderer (diff, syntax highlighting)
  });
}