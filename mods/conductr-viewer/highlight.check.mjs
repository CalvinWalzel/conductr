// node highlight.check.mjs: the highlighter splits lines into the right colored tokens.
import assert from "node:assert/strict";
import { tokens, languageOf } from "./highlight.js";

const kinds = (text, language) => tokens(text, language).filter((token) => token.kind).map((token) => [token.text, token.kind]);
const covers = (text, language) => assert.equal(tokens(text, language).map((token) => token.text).join(""), text);

assert.equal(languageOf("app/models/video.rb"), "ruby");
assert.equal(languageOf("Gemfile"), "ruby");
assert.equal(languageOf("client/src/App.tsx"), "js");
assert.equal(languageOf("README"), null);

assert.deepEqual(kinds("    object.submit_apple_video_packages # later", "ruby"), [["submit_apple_video_packages", "function"], ["# later", "comment"]]);
assert.deepEqual(kinds('next unless object.spotify? && "a # b"', "ruby"), [["next", "keyword"], ["unless", "keyword"], ["spotify?", "function"], ['"a # b"', "string"]]);
assert.deepEqual(kinds("has_many :episodes, dependent: :destroy", "ruby"), [[":episodes", "constant"], ["dependent:", "constant"], [":destroy", "constant"]]);
assert.deepEqual(kinds("const total = Math.max(1, items.length) // count", "js"), [["const", "keyword"], ["Math", "type"], ["max", "function"], ["1", "number"], ["// count", "comment"]]);
assert.deepEqual(kinds('  "run": [true, null]', "json"), [['"run"', "key"], ["true", "constant"], ["null", "constant"]]);
assert.deepEqual(kinds("  setup: bin/update", "yaml"), [["  setup", "key"]]);
for (const [text, language] of [["  end", "ruby"], ["a = 'x' + \"y\"", null], ["", "js"], ["/* open", "js"]]) covers(text, language);
console.log("highlight ok");
