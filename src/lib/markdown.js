// Tiny markdown → block list. No deps, no innerHTML — the caller renders these
// blocks as React elements so LLM-written digests can't inject markup (XSS-safe).
// Handles: #/##/### headings, - / * bullet lists, **bold** inline, paragraphs.

export function parseMarkdown(md) {
  const lines = String(md ?? "").replace(/\r\n/g, "\n").split("\n");
  const blocks = [];
  let list = null; // accumulating bullet items
  let para = []; // accumulating paragraph lines

  const flushPara = () => {
    if (para.length) blocks.push({ type: "p", text: para.join(" ") });
    para = [];
  };
  const flushList = () => {
    if (list) blocks.push({ type: "ul", items: list });
    list = null;
  };

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) {
      flushPara();
      flushList();
      continue;
    }
    const h = /^(#{1,3})\s+(.*)$/.exec(line);
    if (h) {
      flushPara();
      flushList();
      blocks.push({ type: "h", level: h[1].length, text: h[2] });
      continue;
    }
    const li = /^[-*]\s+(.*)$/.exec(line);
    if (li) {
      flushPara();
      (list ??= []).push(li[1]);
      continue;
    }
    flushList();
    para.push(line);
  }
  flushPara();
  flushList();
  return blocks;
}

// Split a line into [text, bold, text, bold, ...] segments on ** pairs.
// Even indices are plain, odd indices are bold.
export function splitBold(text) {
  return String(text ?? "").split("**");
}
