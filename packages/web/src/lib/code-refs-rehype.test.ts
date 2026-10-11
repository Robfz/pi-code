import type { Element, ElementContent, Root } from "hast";
import { describe, expect, it } from "vitest";
import { CODE_REF_CLASS, rehypeCodeRefs } from "./code-refs-rehype";

const text = (value: string): ElementContent => ({ type: "text", value });
const el = (tagName: string, ...children: ElementContent[]): Element => ({
  type: "element",
  tagName,
  properties: {},
  children,
});
const ref = (value: string): Element => ({
  type: "element",
  tagName: "span",
  properties: { dataCodeRef: "", role: "button", tabIndex: 0, className: CODE_REF_CLASS },
  children: [text(value)],
});

/** `node` after the plugin ran on a tree holding it. */
function run(node: Element): Element {
  const tree: Root = { type: "root", children: [node] };
  rehypeCodeRefs()(tree);
  return tree.children[0] as Element;
}

describe("rehypeCodeRefs", () => {
  it("splits references out of paragraph text", () => {
    expect(run(el("p", text("See @src/a.ts:3 and @b.ts:4-5.")))).toEqual(
      el("p", text("See "), ref("@src/a.ts:3"), text(" and "), ref("@b.ts:4-5"), text(".")),
    );
    expect(run(el("p", text("@a.ts:1")))).toEqual(el("p", ref("@a.ts:1")));
  });

  it("marks references inside inline code", () => {
    expect(run(el("p", text("In "), el("code", text("@src/a.ts:3")), text(".")))).toEqual(
      el("p", text("In "), el("code", ref("@src/a.ts:3")), text(".")),
    );
  });

  it("scans each text node on its own, so emphasis starts a reference", () => {
    expect(run(el("p", text("x"), el("em", text("@a.ts:2")), text("y")))).toEqual(
      el("p", text("x"), el("em", ref("@a.ts:2")), text("y")),
    );
    expect(run(el("li", el("strong", text("Here: @a.ts:2-3"))))).toEqual(
      el("li", el("strong", text("Here: "), ref("@a.ts:2-3"))),
    );
  });

  it("leaves links and code blocks alone", () => {
    const link = el(
      "p",
      el("a", text("@a.ts:3")),
      text(" or "),
      el("a", el("code", text("@b.ts:1"))),
    );
    expect(run(structuredClone(link))).toEqual(link);
    const block = el("pre", el("code", text("@a.ts:3\n@b.ts:4\n")));
    expect(run(structuredClone(block))).toEqual(block);
  });

  it("leaves text without references and non-references as is", () => {
    const plain = el("p", text("src/a.ts:3, @scope/pkg, a@b.c:25 and (@a.ts:3)"));
    expect(run(structuredClone(plain))).toEqual(plain);
  });
});
