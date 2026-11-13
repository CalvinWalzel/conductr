// A composer's content as a message in order: [{ text }, { image: path }, …]. An image chip's token
// id starts with "img-" and its text is the image's path; any other chip stays in the text.
export function messageParts(content) {
  const parts = [];
  let from = 0;
  const addText = (end) => {
    const text = content.text.slice(from, end).trim();
    if (text) parts.push({ text });
  };
  const images = content.tokens.filter((span) => span.token.id.startsWith("img-"))
    .sort((a, b) => a.range.start - b.range.start);
  for (const span of images) {
    addText(span.range.start);
    parts.push({ image: span.token.text });
    from = span.range.end;
  }
  addText(content.text.length);
  return parts;
}

// The parts as Claude gets them: a text block naming each image's path comes before it, so the
// transcript says which file it was.
export const blocks = (parts) => parts.flatMap((part) => (part.image
  ? [{ type: "text", text: `[Image: ${part.image}]` }, { type: "image", path: part.image }]
  : [{ type: "text", text: part.text }]));

// send.sh's arguments for the parts.
export const sendArgs = (parts) => blocks(parts).map((block) => (block.type === "image" ? `i:${block.path}` : `t:${block.text}`));

export function attachmentName(path) {
  const name = path.split("/").pop();
  return /^pasted-\d+\.png$/.test(name) ? "Pasted image" : name.replace(/^attached-\d+-/, "");
}

// A user message's content blocks as the chat shows them: its text, and its attachments in order
// ({ image, path, name }). An image's path is in the text block before it; a dropped file is an
// absolute @path in the text, which is cut out of it.
export function bubble(content) {
  const texts = [];
  const attachments = [];
  let path = null;
  for (const block of typeof content === "string" ? [{ type: "text", text: content }] : content ?? []) {
    const marker = block.type === "text" && block.text.match(/^\[Image: (.+)\]$/);
    if (marker) path = marker[1];
    else if (block.type === "image") {
      attachments.push({ image: true, path, name: path ? attachmentName(path) : "Image" });
      path = null;
    } else if (block.type === "text") {
      texts.push(block.text.replace(/(^|\s)@(\/\S+)/g, (_match, space, file) => {
        attachments.push({ image: false, path: file, name: file.split("/").pop() });
        return space;
      }).trim());
    }
  }
  return { text: texts.filter(Boolean).join("\n\n"), attachments };
}
