// Self-check for the markdown parser. Run: node src/lib/markdown.selfcheck.mjs
// Not imported by the app — smallest thing that fails if parsing breaks.
import assert from "node:assert";
import { parseMarkdown, splitBold } from "./markdown.js";

const b = parseMarkdown("# Title\n\nhello **world**\n\n- a\n- b\n## Money");
assert.deepStrictEqual(b[0], { type: "h", level: 1, text: "Title" });
assert.deepStrictEqual(b[1], { type: "p", text: "hello **world**" });
assert.deepStrictEqual(b[2], { type: "ul", items: ["a", "b"] });
assert.deepStrictEqual(b[3], { type: "h", level: 2, text: "Money" });

assert.deepStrictEqual(splitBold("a **b** c"), ["a ", "b", " c"]);
assert.deepStrictEqual(parseMarkdown(""), []);
assert.deepStrictEqual(parseMarkdown(null), []);

console.log("markdown self-check OK");
