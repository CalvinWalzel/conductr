// Answer cards for Claude's can_use_tool requests: permissions, AskUserQuestion, and plan approval.
// answer(response) sends the control response; feedback() is what is typed in the composer.

import { div } from "gpui-kit";
import { v_flex, h_flex, TextView } from "gpui-base";

function button(t, id, label, primary, onClick) {
  return div().id(id).px(10).py(4).rounded(6).text_size(12)
    .bg(primary ? t.solid : t.raised).text_color(primary ? t.solid_foreground : t.foreground)
    .hover((s) => s.opacity(0.85)).child(label)
    .on_click((_e, cx) => onClick(cx));
}

export function frame(t, color, title, body, buttons) {
  return v_flex().gap(8).p(12).rounded(10).border(1).border_color(color).bg(t.surface)
    .child(div().text_size(12).font_semibold().text_color(color).child(title))
    .when(Boolean(body), (el) => el.child(body))
    .child(h_flex().gap(6).flex_wrap().children(buttons));
}

function detail(ask) {
  const input = ask.input;
  if (ask.tool === "Bash") return "```sh\n" + (input.command ?? "") + "\n```";
  if (input.file_path) return "`" + input.file_path + "`";
  return "```json\n" + JSON.stringify(input, null, 2).slice(0, 1500) + "\n```";
}

function remember(ask) {
  const suggestion = ask.suggestions[0];
  if (!suggestion) return null;
  if (suggestion.type === "setMode") return `Allow, then ${suggestion.mode === "acceptEdits" ? "accept edits" : suggestion.mode}`;
  return "Always allow";
}

export function card(t, ask, picks, { answer, feedback, notify }) {
  const allow = (cx, extra = {}) => answer({ behavior: "allow", updatedInput: ask.input, ...extra }, cx);
  const deny = (cx, fallback) => answer({ behavior: "deny", message: feedback() || fallback }, cx);

  if (ask.tool === "AskUserQuestion") {
    const questions = ask.input.questions ?? [];
    const chosen = picks[ask.id] ??= questions.map(() => []);
    const submit = (cx) => allow(cx, { updatedInput: { ...ask.input,
      answers: Object.fromEntries(questions.map((question, index) => [question.question, chosen[index].join(", ")])) } });
    const ready = chosen.every((labels) => labels.length);
    const single = questions.length === 1 && !questions[0].multiSelect;
    const body = v_flex().gap(10).children(questions.map((question, index) => v_flex().gap(6)
      .child(div().text_size(13).child(question.question))
      .child(h_flex().gap(6).flex_wrap().children((question.options ?? []).map((option, optionIndex) => {
        const on = chosen[index].includes(option.label);
        return div().id(`q-${ask.id}-${index}-${optionIndex}`).px(10).py(5).rounded(6).text_size(12)
          .border(1).border_color(on ? t.accent : t.border).bg(on ? t.selected : t.raised)
          .hover((s) => s.bg(t.hover)).child(option.label)
          .on_click((_e, cx) => {
            const labels = chosen[index];
            if (question.multiSelect) on ? labels.splice(labels.indexOf(option.label), 1) : labels.push(option.label);
            else labels.splice(0, labels.length, option.label);
            if (single) submit(cx); else notify(cx);
          });
      })))));
    return frame(t, t.accent, "Claude asks", body, single ? [
      button(t, `qd-${ask.id}`, "Answer in chat", false, (cx) => deny(cx, "The user will answer in the chat instead.")),
    ] : [
      button(t, `qs-${ask.id}`, "Submit", ready, (cx) => ready && submit(cx)),
      button(t, `qd-${ask.id}`, "Answer in chat", false, (cx) => deny(cx, "The user will answer in the chat instead.")),
    ]);
  }

  if (ask.tool === "ExitPlanMode") {
    const plan = v_flex().max_h(420).overflow_y_scrollbar().id(`plan-${ask.id}`)
      .child(TextView.markdown(`pm-${ask.id}`, ask.input.plan ?? "").selectable(true));
    return frame(t, t.accent, "Plan ready", plan, [
      button(t, `pa-${ask.id}`, "Approve", true, (cx) => allow(cx)),
      button(t, `pk-${ask.id}`, "Keep planning", false, (cx) => deny(cx, "Keep planning.")),
    ]);
  }

  const always = remember(ask);
  return frame(t, t.blocked, `Allow ${ask.tool}?`,
    TextView.markdown(`pd-${ask.id}`, detail(ask)).selectable(true), [
      button(t, `pa-${ask.id}`, "Allow", true, (cx) => allow(cx)),
      ...(always ? [button(t, `pr-${ask.id}`, always, false, (cx) => allow(cx, { updatedPermissions: ask.suggestions }))] : []),
      button(t, `pn-${ask.id}`, "Deny", false, (cx) => deny(cx, "The user denied this.")),
    ]);
}
