// node parts.check.mjs: checks how a composer's chips split a message.
import assert from "node:assert/strict";
import { messageParts, blocks, sendArgs, bubble } from "./parts.js";

const content = (...pieces) => {
  let text = "";
  const tokens = [];
  for (const piece of pieces) {
    if (typeof piece === "string") text += piece;
    else {
      tokens.push({ range: { start: text.length, end: text.length + piece.text.length }, token: piece });
      text += piece.text;
    }
  }
  return { text, tokens };
};
const image = (n) => ({ id: `img-${n}`, text: `/chat/a${n}.png`, label: `a${n}.png` });

assert.deepEqual(messageParts(content("look at ", image(1), " and fix it")),
  [{ text: "look at" }, { image: "/chat/a1.png" }, { text: "and fix it" }]);
assert.deepEqual(messageParts(content(image(1), " ", image(2), " ")),
  [{ image: "/chat/a1.png" }, { image: "/chat/a2.png" }]);
assert.deepEqual(messageParts(content("see ", { id: "file-3", text: "@/src/a.rb", label: "a.rb" }, " please")),
  [{ text: "see @/src/a.rb please" }]);
assert.deepEqual(messageParts(content("  just text ")), [{ text: "just text" }]);
assert.deepEqual(messageParts(content("")), []);
const sent = [{ text: "see" }, { image: "/chat/attached-17-king.png" }, { text: "and @/src/a.rb please" }, { image: "/chat/pasted-18.png" }];
assert.deepEqual(sendArgs(sent), ["t:see", "t:[Image: /chat/attached-17-king.png]", "i:/chat/attached-17-king.png",
  "t:and @/src/a.rb please", "t:[Image: /chat/pasted-18.png]", "i:/chat/pasted-18.png"]);
assert.deepEqual(bubble(blocks(sent)), { text: "see\n\nand  please", attachments: [
  { image: true, path: "/chat/attached-17-king.png", name: "king.png" },
  { image: false, path: "/src/a.rb", name: "a.rb" },
  { image: true, path: "/chat/pasted-18.png", name: "Pasted image" }] });
assert.deepEqual(bubble([{ type: "text", text: "old" }, { type: "image" }]),
  { text: "old", attachments: [{ image: true, path: null, name: "Image" }] });
assert.deepEqual(bubble("look at @app/x.rb"), { text: "look at @app/x.rb", attachments: [] });
console.log("parts ok");
