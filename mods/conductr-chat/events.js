// Folds Claude Code stream-json events (out.jsonl) into what the chat shows.

import { bubble } from "./parts.js";

export function emptyState() {
  return { items: [], results: {}, asks: [], sid: null, mode: null, commands: [], working: false,
    models: [], model: null, effort: null, fast: null, turn: {} };
}

function textOf(content) {
  if (typeof content === "string") return content;
  return (content ?? []).filter(block => block.type === "text").map(block => block.text).join("\n");
}

function base(path) {
  return String(path ?? "").split("/").pop();
}

// What a tool call shows: a title, and a detail such as the command or the path.
export function describe(name, input = {}) {
  switch (name) {
    case "Bash": return { title: input.description || "Run a command", detail: input.command ?? "", mono: true };
    case "Read": case "Write": case "Edit": case "NotebookEdit":
      return { title: name, detail: input.file_path ?? input.notebook_path ?? "", mono: true };
    case "Grep": return { title: "Search", detail: input.pattern ?? "", mono: true };
    case "Glob": return { title: "Find files", detail: input.pattern ?? "", mono: true };
    case "Agent": case "Task": return { title: input.description || "Agent", detail: input.subagent_type ?? "" };
    case "WebFetch": return { title: "Fetch", detail: input.url ?? "", mono: true };
    case "WebSearch": return { title: "Search the web", detail: input.query ?? "" };
    case "Skill": return { title: "Skill", detail: input.skill ?? "", mono: true };
    case "TodoWrite": return { title: "Update the to-do list", detail: "" };
    case "AskUserQuestion": return { title: "Ask a question", detail: input.questions?.[0]?.question ?? "" };
    default: return { title: name, detail: "" };
  }
}

export function fold(state, event, line = 0) {
  const items = state.items;
  switch (event.type) {
    case "system":
      if (event.subtype === "init") {
        state.sid = event.session_id;
        state.mode = event.permissionMode;
        state.model = event.model;
        state.fast = event.fast_mode_state ?? state.fast;
        // A turn starts here; Claude echoes the message only once it has thought.
        state.working = true;
        if (!state.commands.length) state.commands = (event.slash_commands ?? []).map((name) => ({ name }));
        // A new turn starts: requests left from a stopped process are gone.
        state.asks = [];
      }
      if (event.subtype === "status" && event.permissionMode) state.mode = event.permissionMode;
      break;
    case "user": {
      const content = event.message?.content;
      const results = Array.isArray(content) ? content.filter(block => block.type === "tool_result") : [];
      for (const result of results) {
        state.results[result.tool_use_id] = textOf(result.content);
        const plan = items.find((item) => item.kind === "plan" && item.id === result.tool_use_id);
        if (plan) plan.outcome = result.is_error ? "revised" : "approved";
        else if (result.is_error) items.push({ kind: "failure", id: result.tool_use_id, text: textOf(result.content) });
      }
      // Local command output, such as "Set model to …", is a notice in the transcript, not a message.
      if (results.length || event.isSynthetic || event.isMeta || /^<local-command-/.test(textOf(content))) break;
      // Claude Code's own mark for a stop, written as if the user said it.
      if (/^\[Request interrupted by user/.test(textOf(content))) {
        if (items[items.length - 1]?.kind !== "stopped") items.push({ kind: "stopped" });
        break;
      }
      items.push({ kind: "user", ...bubble(content) });
      state.turn = {};
      state.working = true;
      break;
    }
    case "assistant":
      state.turn.model = event.message?.model ?? state.turn.model;
      state.turn.uuid = event.uuid ?? state.turn.uuid;
      for (const block of event.message?.content ?? []) {
        if (block.type === "text" && block.text.trim()) {
          items.push({ kind: "agent", text: block.text });
          state.turn.text = block.text;
        }
        if (block.type === "thinking" && block.thinking?.trim()) items.push({ kind: "thinking", text: block.thinking.trim() });
        if (block.type === "tool_use" && block.name === "ExitPlanMode") {
          items.push({ kind: "plan", id: block.id, plan: block.input?.plan ?? "", outcome: null });
        } else if (block.type === "tool_use") {
          items.push({ kind: "call", id: block.id, name: block.name, ...describe(block.name, block.input) });
        }
      }
      break;
    case "control_request":
      if (event.request?.subtype === "can_use_tool") {
        const ask = { id: event.request_id, tool: event.request.tool_name, input: event.request.input ?? {},
          suggestions: event.request.permission_suggestions ?? [], toolUseId: event.request.tool_use_id };
        state.asks.push(ask);
        const plan = items.find((item) => item.kind === "plan" && item.id === ask.toolUseId);
        if (plan && !plan.plan) plan.plan = ask.input.plan ?? "";
      }
      break;
    case "control_response": {
      // set_permission_mode answers { mode }; set_model { model }; get_settings { applied: { model, effort } };
      // initialize { commands, models, current_permission_mode, ... }.
      const response = event.response?.response ?? {};
      const mode = response.mode ?? response.current_permission_mode;
      if (mode) state.mode = mode;
      if (response.commands) state.commands = response.commands;
      if (response.models) state.models = response.models;
      if (typeof response.model === "string") state.model = response.model;
      if (response.applied) {
        state.model = response.applied.model ?? state.model;
        state.effort = response.applied.effort ?? state.effort;
      }
      break;
    }
    // Written by the chat itself: what the user typed to answer a request, which Claude only sees
    // as a tool result.
    case "conductr_note": case "calvin_note":
      items.push({ kind: "user", text: event.text });
      break;
    // /clear: a new conversation; the session's settings stay.
    case "conversation_reset":
      items.length = 0;
      state.results = {};
      state.asks = [];
      break;
    case "result":
      state.working = false;
      state.asks = [];
      if (event.subtype === "error_during_execution") {
        if (items[items.length - 1]?.kind !== "stopped") items.push({ kind: "stopped" });
      }
      else if (event.is_error) items.push({ kind: "error", text: event.result || (event.errors ?? []).join("\n") || event.subtype });
      // A finished turn with a reply gets a footer: when, how long, the tokens, copy and fork.
      else if (state.turn.text) {
        const usage = event.usage ?? {};
        items.push({ kind: "turn", duration: event.duration_ms ?? 0, at: event.conductr_at ?? event.calvin_at ?? null, model: state.turn.model,
          fast: state.fast, text: state.turn.text, uuid: state.turn.uuid, line,
          tokens: { input: usage.input_tokens, output: usage.output_tokens,
            read: usage.cache_read_input_tokens, write: usage.cache_creation_input_tokens } });
      }
      state.turn = {};
      break;
  }
  return state;
}
