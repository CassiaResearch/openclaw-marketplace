import { describe, it, expect } from "vitest";
import { parseFrontmatter } from "./discovery.js";

describe("parseFrontmatter", () => {
  it("parses inline scalars", () => {
    const fm = parseFrontmatter(
      ["---", "name: my-skill", "description: A short one-liner.", "---", "", "body"].join("\n"),
    );
    expect(fm.name).toBe("my-skill");
    expect(fm.description).toBe("A short one-liner.");
  });

  it("folds a `description: >` block scalar across lines", () => {
    const fm = parseFrontmatter(
      [
        "---",
        "name: sdr-linkedin-outreach",
        "description: >",
        "  LinkedIn outreach playbook for CoPilot AI SDR. Covers the full sequence",
        "  from connection request through multi-touch follow-up.",
        "---",
      ].join("\n"),
    );
    expect(fm.description).toBe(
      "LinkedIn outreach playbook for CoPilot AI SDR. Covers the full sequence from connection request through multi-touch follow-up.",
    );
  });

  it("preserves newlines for a `|` literal block scalar", () => {
    const fm = parseFrontmatter(
      [
        "---",
        "name: x",
        "description: |",
        "  line one",
        "  line two",
        "---",
      ].join("\n"),
    );
    expect(fm.description).toBe("line one\nline two");
  });

  it("honors chomp indicators on block scalars (`>-`, `|+`)", () => {
    const folded = parseFrontmatter(
      ["---", "name: x", "description: >-", "  one", "  two", "---"].join("\n"),
    );
    expect(folded.description).toBe("one two");

    const literal = parseFrontmatter(
      ["---", "name: x", "description: |+", "  one", "  two", "---"].join("\n"),
    );
    expect(literal.description).toBe("one\ntwo");
  });

  it("treats blank lines inside a folded scalar as paragraph breaks", () => {
    const fm = parseFrontmatter(
      [
        "---",
        "name: x",
        "description: >",
        "  para one continues",
        "  on this line.",
        "",
        "  para two starts here.",
        "---",
      ].join("\n"),
    );
    expect(fm.description).toBe("para one continues on this line.\npara two starts here.");
  });

  it("does not consume continuation lines as their own top-level keys", () => {
    // Regression: the prior parser line-split everything and would treat a
    // continuation line like `  Use when: doing X` as a `Use when` key.
    const fm = parseFrontmatter(
      [
        "---",
        "name: x",
        "description: >",
        "  Some text. Use when: this happens.",
        "---",
      ].join("\n"),
    );
    expect(fm).not.toHaveProperty("Use when");
    expect(fm.description).toBe("Some text. Use when: this happens.");
  });
});
