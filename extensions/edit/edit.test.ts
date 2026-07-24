import { describe, expect, test } from "bun:test";
import {
  mapFuzzyPosToOriginal,
  normalizeForFuzzyMatch,
} from "./index.ts";

// ============================================================
// normalizeForFuzzyMatch tests
// ============================================================

describe("normalizeForFuzzyMatch", () => {
  test("passes through plain ASCII unchanged", () => {
    expect(normalizeForFuzzyMatch("hello world")).toBe("hello world");
  });

  test("normalizes tabs to 2 spaces", () => {
    expect(normalizeForFuzzyMatch("\thello")).toBe("  hello");
  });

  test("strips trailing whitespace per line", () => {
    expect(normalizeForFuzzyMatch("hello   \nworld  ")).toBe("hello\nworld");
  });

  test("normalizes smart single quotes to ASCII apostrophe", () => {
    expect(normalizeForFuzzyMatch("don\u2019t")).toBe("don't");
  });

  test("normalizes smart double quotes to ASCII quotes", () => {
    expect(normalizeForFuzzyMatch("\u201Chello\u201D")).toBe('"hello"');
  });

  test("normalizes em-dash to ASCII hyphen", () => {
    expect(normalizeForFuzzyMatch("a\u2014b")).toBe("a-b");
  });

  test("normalizes en-dash to ASCII hyphen", () => {
    expect(normalizeForFuzzyMatch("pages 10\u201320")).toBe("pages 10-20");
  });

  // --- Arrow normalization (the fix) ---

  test("normalizes rightwards arrow (U+2192) to ->", () => {
    expect(normalizeForFuzzyMatch("A \u2192 B")).toBe("A -> B");
  });

  test("normalizes leftwards arrow (U+2190) to <-", () => {
    expect(normalizeForFuzzyMatch("A \u2190 B")).toBe("A <- B");
  });

  test("normalizes multiple rightwards arrows", () => {
    expect(normalizeForFuzzyMatch("RAGError \u2192 ParseError \u2192 ChunkingError"))
      .toBe("RAGError -> ParseError -> ChunkingError");
  });

  // --- Ellipsis normalization (the fix) ---

  test("normalizes ellipsis (U+2026) to three dots", () => {
    expect(normalizeForFuzzyMatch("Loading\u2026")).toBe("Loading...");
  });

  test("normalizes ellipsis in a sentence", () => {
    expect(normalizeForFuzzyMatch("wait\u2026 done")).toBe("wait... done");
  });

  // --- Special spaces ---

  test("normalizes NBSP (U+00A0) to regular space", () => {
    expect(normalizeForFuzzyMatch("hello\u00A0world")).toBe("hello world");
  });

  test("normalizes ideographic space (U+3000) to regular space", () => {
    expect(normalizeForFuzzyMatch("hello\u3000world")).toBe("hello world");
  });

  // --- Combined scenarios ---

  test("normalizes mixed Unicode in one string", () => {
    const input = "RAGError \u2192 ParseError\u2026 don\u2019t panic";
    const expected = "RAGError -> ParseError... don't panic";
    expect(normalizeForFuzzyMatch(input)).toBe(expected);
  });

  test("ASCII -> matches Unicode \u2192 after normalization (the bug scenario)", () => {
    const fileContent = "Error hierarchy: `RAGError` \u2192 `ParseError`";
    const llmOldText = "Error hierarchy: `RAGError` -> `ParseError`";
    expect(normalizeForFuzzyMatch(fileContent))
      .toBe(normalizeForFuzzyMatch(llmOldText));
  });

  test("ASCII ... matches Unicode \u2026 after normalization", () => {
    const fileContent = "Loading\u2026 done";
    const llmOldText = "Loading... done";
    expect(normalizeForFuzzyMatch(fileContent))
      .toBe(normalizeForFuzzyMatch(llmOldText));
  });
});

// ============================================================
// mapFuzzyPosToOriginal tests
// ============================================================

describe("mapFuzzyPosToOriginal", () => {
  test("identity mapping for plain ASCII (no normalization)", () => {
    const original = "hello world";
    const fuzzy = normalizeForFuzzyMatch(original);
    // Position 5 in both should be the same
    expect(mapFuzzyPosToOriginal(original, fuzzy, 5)).toBe(5);
  });

  test("maps position correctly with tab expansion (1->2)", () => {
    const original = "\thello";
    const fuzzy = normalizeForFuzzyMatch(original); // "  hello"
    // Position 4 in fuzzy ("ll") maps to position 3 in original ("ll")
    // fuzzy:   "  hello"  pos 4 = 'l'
    // original: "\thello" pos 3 = 'l'
    expect(mapFuzzyPosToOriginal(original, fuzzy, 4)).toBe(3);
  });

  // --- Arrow position mapping (the fix) ---

  test("maps position correctly with rightwards arrow (1->2)", () => {
    const original = "prefix \u2192 suffix";
    const fuzzy = normalizeForFuzzyMatch(original); // "prefix -> suffix"
    // Find "-> suffix" in fuzzy, map back to original
    const fuzzyPos = fuzzy.indexOf("-> suffix");
    const expectedOrig = original.indexOf("\u2192");
    expect(mapFuzzyPosToOriginal(original, fuzzy, fuzzyPos)).toBe(expectedOrig);
  });

  test("maps position after rightwards arrow correctly", () => {
    const original = "A \u2192 B \u2192 C";
    const fuzzy = normalizeForFuzzyMatch(original); // "A -> B -> C"
    // "C" is at fuzzy position 10, original position 8
    // fuzzy:   "A -> B -> C"  (len 12)
    // original: "A \u2192 B \u2192 C" (len 10)
    // Each \u2192 (1 char) becomes -> (2 chars), so after 2 arrows, fuzzy is +2 ahead
    const fuzzyPos = fuzzy.indexOf("C");
    const expectedOrig = original.indexOf("C");
    expect(mapFuzzyPosToOriginal(original, fuzzy, fuzzyPos)).toBe(expectedOrig);
  });

  test("maps position correctly with leftwards arrow (1->2)", () => {
    const original = "result \u2190 input";
    const fuzzy = normalizeForFuzzyMatch(original); // "result <- input"
    const fuzzyPos = fuzzy.indexOf("<- input");
    const expectedOrig = original.indexOf("\u2190");
    expect(mapFuzzyPosToOriginal(original, fuzzy, fuzzyPos)).toBe(expectedOrig);
  });

  // --- Ellipsis position mapping (the fix) ---

  test("maps position correctly with ellipsis (1->3)", () => {
    const original = "wait\u2026 done";
    const fuzzy = normalizeForFuzzyMatch(original); // "wait... done"
    const fuzzyPos = fuzzy.indexOf("... done");
    const expectedOrig = original.indexOf("\u2026");
    expect(mapFuzzyPosToOriginal(original, fuzzy, fuzzyPos)).toBe(expectedOrig);
  });

  test("maps position after ellipsis correctly", () => {
    const original = "wait\u2026 done";
    const fuzzy = normalizeForFuzzyMatch(original); // "wait... done"
    // "done" starts at fuzzy pos 8, original pos 5
    // \u2026 (1 char) becomes ... (3 chars), so fuzzy is +2 ahead after ellipsis
    const fuzzyPos = fuzzy.indexOf("done");
    const expectedOrig = original.indexOf("done");
    expect(mapFuzzyPosToOriginal(original, fuzzy, fuzzyPos)).toBe(expectedOrig);
  });

  // --- Full edit simulation: extract original substring via mapped positions ---

  test("full edit simulation: extract correct original substring with arrows", () => {
    const original = "A \u2192 B \u2192 C \u2192 D";
    const fuzzy = normalizeForFuzzyMatch(original);
    const oldText = "B -> C";
    const fuzzyOld = normalizeForFuzzyMatch(oldText);
    const matchPos = fuzzy.indexOf(fuzzyOld);
    const matchEnd = matchPos + fuzzyOld.length;
    const origStart = mapFuzzyPosToOriginal(original, fuzzy, matchPos);
    const origEnd = mapFuzzyPosToOriginal(original, fuzzy, matchEnd);
    // The extracted original should contain the Unicode arrows
    expect(original.slice(origStart, origEnd)).toBe("B \u2192 C");
  });

  test("full edit simulation: extract correct original substring with ellipsis", () => {
    const original = "start\u2026 middle \u2026end";
    const fuzzy = normalizeForFuzzyMatch(original);
    const oldText = "... middle ...";
    const fuzzyOld = normalizeForFuzzyMatch(oldText);
    const matchPos = fuzzy.indexOf(fuzzyOld);
    const matchEnd = matchPos + fuzzyOld.length;
    const origStart = mapFuzzyPosToOriginal(original, fuzzy, matchPos);
    const origEnd = mapFuzzyPosToOriginal(original, fuzzy, matchEnd);
    expect(original.slice(origStart, origEnd)).toBe("\u2026 middle \u2026");
  });

  // --- Trailing whitespace removal ---

  test("maps position correctly with trailing whitespace removal", () => {
    const original = "hello   \nworld";
    const fuzzy = normalizeForFuzzyMatch(original); // "hello\nworld"
    // "world" is at fuzzy pos 6, original pos 9 (after "hello   \n")
    const fuzzyPos = fuzzy.indexOf("world");
    const expectedOrig = original.indexOf("world");
    expect(mapFuzzyPosToOriginal(original, fuzzy, fuzzyPos)).toBe(expectedOrig);
  });
});
