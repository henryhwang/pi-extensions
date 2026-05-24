/**
 * Enhanced Edit Tool — improved version of pi's built-in edit tool
 *
 * Key improvements over built-in:
 *   1. Fixes built-in file corruption when fuzzy matching fires
 *      (built-in normalizes entire file, converting smart quotes/dashes on all lines;
 *       this version maps fuzzy positions back to original content, preserving unrelated lines)
 *   2. Adds tab→spaces fuzzy matching (built-in cannot match tabs vs spaces)
 *   3. Shows failing oldText in error messages with nearby file context
 *   4. More descriptive, actionable error messages
 *   5. Custom renderCall/renderResult using enhanced matching for preview
 *      (avoids preview/execution divergence from inherited built-in renderer)
 */

import type { ExtensionAPI, ExtensionContext, AgentToolUpdateCallback } from "@earendil-works/pi-coding-agent";
import { withFileMutationQueue, renderDiff } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import type { Static } from "typebox";
import { Box, Container, Spacer, Text } from "@earendil-works/pi-tui";
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

// ── Result details (matches built-in EditToolDetails contract) ─

interface EditDetails {
  diff: string;
  patch: string;
  firstChangedLine?: number;
}

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
 * Normalize text for fuzzy matching.
 *
 * Unlike the built-in, this also normalizes tabs to 2 spaces and does NOT use
 * NFKC normalization (which can expand single characters to multiple, breaking
 * position mapping back to original content). The explicit smart-quote, dash,
 * and space replacements are all 1:1 character transforms.
 */
function normalizeForFuzzyMatch(text: string): string {
  return (
    text
      // tabs to 2 spaces (common indent mismatch — not in built-in)
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
 *
 * Handles: tab→2-spaces expansion, trailing whitespace removal, 1:1 unicode transforms.
 * All transforms in normalizeForFuzzyMatch are 1:1 character mappings except tab expansion
 * (1→2) and trailing whitespace removal (N→0), both of which are handled explicitly.
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
    } else {
      // Same character, or 1:1 unicode transform (smart quotes, dashes, etc.)
      oi++;
      fi++;
    }
  }
  return oi;
}

/**
 * Show context around the area where oldText was expected.
 * Uses first 3 non-empty lines of hintText for more accurate matching.
 */
function nearbySnippet(content: string, hintText: string, contextLines = 3): string {
  // Build search keys with increasing specificity from the first non-empty lines of hintText.
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
  let fuzzyIdx = -1;
  for (let n = nonEmpty.length; n >= 1; n--) {
    const searchKey = nonEmpty.slice(0, n).join("\n");
    const fuzzyHint = normalizeForFuzzyMatch(searchKey);
    fuzzyIdx = fuzzyContent.indexOf(fuzzyHint);
    if (fuzzyIdx !== -1) break;
  }

  // If whole-line matching failed, try a prefix of the first non-empty line
  // (helps when oldText has content errors like "bar" vs "foo")
  if (fuzzyIdx === -1 && nonEmpty.length > 0) {
    const firstLine = nonEmpty[0];
    // Try progressively shorter prefixes: 80, 40, 20, 10, 5 chars
    for (const prefixLen of [80, 40, 20, 10, 5]) {
      if (prefixLen >= firstLine.length) continue;
      const prefix = firstLine.slice(0, prefixLen);
      // Only try if prefix is at least 5 chars and ends at a word boundary or is long enough
      const fuzzyPrefix = normalizeForFuzzyMatch(prefix);
      fuzzyIdx = fuzzyContent.indexOf(fuzzyPrefix);
      if (fuzzyIdx !== -1) break;
    }
  }
  if (fuzzyIdx === -1) return "";

  // Map fuzzy position back to original content before line-walking
  const origIdx = mapFuzzyPosToOriginal(content, fuzzyContent, fuzzyIdx);

  const lines = content.split("\n");
  let lineNum = 0;
  let charPos = 0;
  for (let i = 0; i < lines.length; i++) {
    if (charPos >= origIdx) {
      lineNum = i;
      break;
    }
    charPos += lines[i].length + 1; // +1 for \n
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

  // First pass: validate all edits exist and are unique, map positions to original space
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
    const fuzzyOccurrences = countOccurrences(fuzzyContent, fuzzyEdits[i].fuzzyOldText);
    if (fuzzyOccurrences > 1) {
      // Fuzzy match is ambiguous — check if the exact oldText is unique in original content.
      // This handles cases where different originals normalize to the same fuzzy text
      // (e.g., "hello\tworld" and "hello  world" both fuzzy to "hello  world").
      const exactIdx = normalizedContent.indexOf(edit.oldText);
      if (exactIdx !== -1) {
        const nextIdx = normalizedContent.indexOf(edit.oldText, exactIdx + 1);
        if (nextIdx === -1) {
          // Unique exact match in original space — use it directly
          matchedEdits.push({
            editIndex: i,
            matchIndex: exactIdx,
            matchLength: edit.oldText.length,
            newText: edit.newText,
          });
          continue;
        }
        // Multiple exact matches too — truly ambiguous, fall through to error
      }

      const prefix =
        normalizedEdits.length === 1
          ? "Found " + fuzzyOccurrences + " occurrences of the text in " + path + "."
          : "Found " + fuzzyOccurrences + " occurrences of edits[" + i + "] in " + path + ".";

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

// ── Diff generation ───────────────────────────────────────────

function generateDiffString(
  oldContent: string,
  newContent: string,
  contextLines = 4,
): { diff: string; firstChangedLine: number | undefined } {
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

  return { diff: output.join("\n"), firstChangedLine };
}

function generateUnifiedPatch(path: string, oldContent: string, newContent: string, contextLines = 4): string {
  return Diff.createTwoFilesPatch(path, path, oldContent, newContent, undefined, undefined, {
    context: contextLines,
  });
}

// ── Preview computation (for renderCall) ──────────────────────

type EditPreview = { diff: string; firstChangedLine: number } | { error: string };

/**
 * Compute edit preview using the enhanced matching engine.
 * This avoids preview/execution divergence from the built-in's computeEditsDiff.
 */
async function computeEnhancedEditDiff(
  path: string,
  edits: Array<{ oldText: string; newText: string }>,
  cwd: string,
): Promise<EditPreview> {
  const absolutePath = resolve(cwd, path);
  try {
    try {
      await fsAccess(absolutePath, constants.R_OK);
    } catch (error: unknown) {
      const code =
        error instanceof Error && "code" in error
          ? (error as NodeJS.ErrnoException).code
          : "UNKNOWN";
      return { error: "Could not edit file: " + path + ". Error code: " + code + "." };
    }

    const buffer = await fsReadFile(absolutePath);
    const rawContent = buffer.toString("utf-8");
    const { text: content } = stripBom(rawContent);
    const normalizedContent = normalizeToLF(content);

    const { baseContent, newContent } = applyEditsWithImprovedErrors(normalizedContent, edits, path);
    return generateDiffString(baseContent, newContent);
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

// ── Rendering ─────────────────────────────────────────────────

interface EditCallComponent extends Box {
  preview?: EditPreview;
  previewArgsKey?: string;
  previewPending?: boolean;
  settledError?: boolean;
}

interface EditRenderState {
  callComponent?: EditCallComponent;
}

function createCallComponent(): EditCallComponent {
  return Object.assign(new Box(1, 1, (text: string) => text), {
    preview: undefined,
    previewArgsKey: undefined,
    previewPending: false,
    settledError: false,
  });
}

function getCallComponent(state: EditRenderState, lastComponent?: Component): EditCallComponent {
  if (lastComponent instanceof Box) {
    const component = lastComponent as EditCallComponent;
    state.callComponent = component;
    return component;
  }
  if (state.callComponent) {
    return state.callComponent;
  }
  const component = createCallComponent();
  state.callComponent = component;
  return component;
}

function getRenderableInput(args: unknown): { path: string; edits: Array<{ oldText: string; newText: string }> } | null {
  if (!args || typeof args !== "object") return null;
  const a = args as Record<string, unknown>;
  const path = typeof a.path === "string" ? a.path : null;
  if (!path) return null;
  if (
    Array.isArray(a.edits) &&
    a.edits.length > 0 &&
    a.edits.every((e: unknown) => typeof (e as Record<string, unknown>)?.oldText === "string" && typeof (e as Record<string, unknown>)?.newText === "string")
  ) {
    return { path, edits: a.edits as Array<{ oldText: string; newText: string }> };
  }
  if (typeof a.oldText === "string" && typeof a.newText === "string") {
    return { path, edits: [{ oldText: a.oldText as string, newText: a.newText as string }] };
  }
  return null;
}

// Minimal Component type for rendering
type Component = InstanceType<typeof Box> | InstanceType<typeof Container>;

function getHeaderBg(preview: EditPreview | undefined, settledError: boolean, theme: { bg: (color: string, text: string) => string }): (text: string) => string {
  if (preview) {
    if ("error" in preview) return (text: string) => theme.bg("toolErrorBg", text);
    return (text: string) => theme.bg("toolSuccessBg", text);
  }
  if (settledError) return (text: string) => theme.bg("toolErrorBg", text);
  return (text: string) => theme.bg("toolPendingBg", text);
}

function buildCallComponent(component: EditCallComponent, args: unknown, theme: { fg: (color: string, text: string) => string; bg: (color: string, text: string) => string; bold: (text: string) => string }): EditCallComponent {
  component.setBgFn(getHeaderBg(component.preview, component.settledError, theme));
  component.clear();

  const rawPath = String((args as Record<string, unknown>)?.path ?? "???");
  const header = theme.fg("toolTitle", theme.bold("edit")) + " " + theme.fg("accent", rawPath);
  component.addChild(new Text(header, 0, 0));

  if (!component.preview) {
    return component;
  }

  const body =
    "error" in component.preview
      ? theme.fg("error", component.preview.error)
      : renderDiff(component.preview.diff);

  component.addChild(new Spacer(1));
  component.addChild(new Text(body, 0, 0));
  return component;
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
      "  * Preserves unrelated file content when fuzzy matching (built-in can corrupt)",
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
      _onUpdate: AgentToolUpdateCallback<EditDetails> | undefined,
      ctx: ExtensionContext,
    ) {
      const { path, edits } = params;
      const absolutePath = resolve(ctx.cwd, path);

      return withFileMutationQueue(absolutePath, async () => {
        // Check signal after each await (same pattern as built-in).
        // Do not reject from an abort event listener: that would release the
        // mutation queue while an in-flight filesystem operation may still finish.
        const throwIfAborted = () => {
          if (signal?.aborted) throw new Error("Operation aborted");
        };

        throwIfAborted();

        // Validate edits array
        if (!Array.isArray(edits) || edits.length === 0) {
          throw new Error("edits must contain at least one replacement.");
        }

        // Check file existence/access
        try {
          await fsAccess(absolutePath, constants.R_OK | constants.W_OK);
        } catch (error: unknown) {
          throwIfAborted();
          const code =
            error instanceof Error && "code" in error
              ? (error as NodeJS.ErrnoException).code
              : "UNKNOWN";
          throw new Error("Could not edit file: " + path + ". Error code: " + code + ".");
        }

        throwIfAborted();

        // Read file
        const buffer = await fsReadFile(absolutePath);
        const rawContent = buffer.toString("utf-8");
        throwIfAborted();

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

        throwIfAborted();

        // Write
        const finalContent = bom + restoreLineEndings(newContent, originalEnding);
        await fsWriteFile(absolutePath, finalContent, "utf-8");
        throwIfAborted();

        const diffResult = generateDiffString(baseContent, newContent);
        const patch = generateUnifiedPatch(path, baseContent, newContent);

        return {
          content: [
            {
              type: "text" as const,
              text: "Successfully replaced " + edits.length + " block(s) in " + path + ".",
            },
          ],
          details: {
            diff: diffResult.diff,
            patch,
            firstChangedLine: diffResult.firstChangedLine,
          } satisfies EditDetails,
        };
      });
    },

    // Custom rendering using the enhanced matching engine for previews.
    // This avoids the preview/execution divergence that would occur if we
    // inherited the built-in renderer (which uses computeEditsDiff with the
    // built-in matching engine that lacks tab normalization).

    renderCall(args: EditInput, theme: { fg: (color: string, text: string) => string; bg: (color: string, text: string) => string; bold: (text: string) => string }, context: { state: EditRenderState; lastComponent?: Component; argsComplete: boolean; invalidate: () => void; cwd: string }): Component {
      const component = getCallComponent(context.state, context.lastComponent);
      const previewInput = getRenderableInput(args);
      const argsKey = previewInput
        ? JSON.stringify({ path: previewInput.path, edits: previewInput.edits })
        : undefined;

      // Reset if args changed
      if (component.previewArgsKey !== argsKey) {
        component.preview = undefined;
        component.previewArgsKey = argsKey;
        component.previewPending = false;
        component.settledError = false;
      }

      // Compute preview asynchronously when args are complete
      if (context.argsComplete && previewInput && !component.preview && !component.previewPending) {
        component.previewPending = true;
        const requestKey = argsKey;
        void computeEnhancedEditDiff(previewInput.path, previewInput.edits, context.cwd).then(
          (preview) => {
            if (component.previewArgsKey === requestKey) {
              component.preview = preview;
              component.previewArgsKey = requestKey;
              component.previewPending = false;
              context.invalidate();
            }
          },
        );
      }

      return buildCallComponent(component, args, theme);
    },

    renderResult(
      result: { content: Array<{ type: string; text: string }>; details?: EditDetails; isError?: boolean },
      _options: { expanded: boolean; isPartial: boolean },
      theme: { fg: (color: string, text: string) => string; bg: (color: string, text: string) => string; bold: (text: string) => string },
      context: { state: EditRenderState; lastComponent?: Component; args?: EditInput; isError: boolean },
    ): Component {
      const callComponent = context.state.callComponent;
      const previewInput = getRenderableInput(context.args);
      const argsKey = previewInput
        ? JSON.stringify({ path: previewInput.path, edits: previewInput.edits })
        : undefined;

      const resultDiff = !context.isError ? result.details?.diff : undefined;
      let changed = false;

      if (callComponent) {
        // Update preview with actual result diff
        if (typeof resultDiff === "string") {
          const newPreview: EditPreview = {
            diff: resultDiff,
            firstChangedLine: result.details?.firstChangedLine,
          };
          // Only update if different from current preview
          if (
            !callComponent.preview ||
            "error" in callComponent.preview ||
            callComponent.preview.diff !== resultDiff
          ) {
            callComponent.preview = newPreview;
            callComponent.previewArgsKey = argsKey;
            changed = true;
          }
        }

        // Update error state
        if (callComponent.settledError !== context.isError) {
          callComponent.settledError = context.isError;
          changed = true;
        }

        if (changed) {
          buildCallComponent(callComponent, context.args, theme);
        }
      }

      // Render result body
      const component = (context.lastComponent as Container) ?? new Container();
      component.clear();

      if (context.isError) {
        const errorText = result.content
          .filter((c) => c.type === "text")
          .map((c) => c.text || "")
          .join("\n");
        if (errorText) {
          component.addChild(new Spacer(1));
          component.addChild(new Text(theme.fg("error", errorText), 0, 0));
        }
        return component;
      }

      // For successful results, the diff is already shown in the call component
      // (via the preview mechanism). Only add extra output if there's something
      // not already displayed.
      return component;
    },
  });
}
