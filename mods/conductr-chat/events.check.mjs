// node events.check.mjs: checks the stream-json fold.
import assert from "node:assert/strict";
import { emptyState, fold } from "./events.js";

const state = emptyState();
const events = [
  { type: "control_response", response: { response: { commands: [{ name: "hello", description: "Say hi" }], current_permission_mode: "auto" } } },
  { type: "system", subtype: "init", session_id: "s1", permissionMode: "default", slash_commands: ["ignored"] },
  { type: "user", isReplay: true, message: { content: [{ type: "text", text: "Hi" }] } },
  { type: "user", message: { content: "<local-command-stdout>Set model to `fable`</local-command-stdout>" } },
  { type: "assistant", message: { content: [{ type: "thinking", thinking: "Listing first." }, { type: "text", text: "Looking." }, { type: "tool_use", id: "a", name: "Bash", input: { command: "ls" } }] } },
  { type: "assistant", message: { content: [{ type: "tool_use", id: "b", name: "Read", input: { file_path: "/x/notes.txt" } }] } },
  { type: "control_request", request_id: "r1", request: { subtype: "can_use_tool", tool_name: "Read", input: { file_path: "/x/notes.txt" } } },
  { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "a", content: "notes.txt" }] } },
  { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "b", is_error: true, content: "Exit code 2" }] } },
  { type: "assistant", message: { content: [{ type: "tool_use", id: "p", name: "ExitPlanMode", input: {} }] } },
  { type: "control_request", request_id: "r2", request: { subtype: "can_use_tool", tool_name: "ExitPlanMode", tool_use_id: "p", input: { plan: "# Plan" } } },
  { type: "conductr_note", text: "Make it shorter" },
  { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "p", is_error: true, content: "Make it shorter" }] } },
  { type: "system", subtype: "status", permissionMode: "plan" },
  { type: "user", message: { content: [{ type: "text", text: "[Request interrupted by user]" }] } },
  { type: "result", subtype: "error_during_execution", is_error: true },
  { type: "control_response", response: { response: { applied: { model: "claude-sonnet-5-5", effort: "low" } } } },
  { type: "control_response", response: { response: { model: "claude-opus-5-5" } } },
];
for (const event of events) fold(state, event);
const turn = emptyState();
fold(turn, { type: "user", isReplay: true, message: { content: "Hi" } }, 1);
fold(turn, { type: "assistant", uuid: "u1", message: { model: "claude-opus-5-5", content: [{ type: "text", text: "Hello." }] } }, 2);
fold(turn, { type: "result", subtype: "success", duration_ms: 1200, conductr_at: 1800000000, usage: { input_tokens: 2, output_tokens: 15 } }, 3);
assert.deepEqual(turn.items.map((item) => item.kind), ["user", "agent", "turn"]);
assert.equal(turn.items[2].text, "Hello.");
assert.equal(turn.items[2].uuid, "u1");
assert.equal(turn.items[2].line, 3);
assert.equal(turn.items[2].tokens.output, 15);
const cleared = fold(structuredClone(state), { type: "conversation_reset" });
assert.deepEqual(cleared.items, []);
assert.equal(cleared.sid, "s1");

assert.equal(state.sid, "s1");
assert.equal(state.mode, "plan");
assert.deepEqual(state.commands, [{ name: "hello", description: "Say hi" }]);
assert.deepEqual(state.items.map((item) => item.kind), ["user", "thinking", "agent", "call", "call", "failure", "plan", "user", "stopped"]);
assert.equal(state.items[6].plan, "# Plan");
assert.equal(state.items[6].outcome, "revised");
assert.deepEqual([state.items[3].title, state.items[3].detail, state.items[4].detail], ["Run a command", "ls", "/x/notes.txt"]);
assert.equal(state.items[5].text, "Exit code 2");
assert.equal(state.results.a, "notes.txt");
assert.equal(state.working, false);
assert.deepEqual(state.asks, []);
assert.equal(state.model, "claude-opus-5-5");
assert.equal(state.effort, "low");
console.log("events ok");
