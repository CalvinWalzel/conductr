// A line-at-a-time syntax highlighter for diff rows: comments, strings, numbers, keywords,
// constants, types and method calls, by regex. It sees one line at a time, so a block comment or
// string that spans lines is only colored on the line where it starts.

const WORDS = {
  ruby: "alias and begin break case class def defined? do else elsif end ensure for if in module next not or redo rescue retry return self super then undef unless until when while yield private protected public require require_relative include extend raise attr_reader attr_writer attr_accessor lambda proc",
  js: "as async await break case catch class const continue debugger default delete do else enum export extends finally for from function get if implements import in instanceof interface let new of private protected public readonly return set static super switch this throw try type typeof var void while with yield",
  python: "and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield self",
  go: "break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var",
  rust: "as async await break const continue crate dyn else enum extern fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait type unsafe use where while",
  sh: "if then else elif fi case esac for while until do done in function return local export set unset shift exit",
  sql: "select from where and or not insert into values update set delete create table alter drop index join left right inner outer on as group by order having limit offset distinct union all case when then else end is in like between exists primary key references default",
  css: "",
  yaml: "",
  json: "",
};
const LITERALS = new Set(["true", "false", "nil", "null", "undefined", "None", "True", "False", "NaN"]);
const COMMENTS = { ruby: "#", python: "#", sh: "#", yaml: "#", toml: "#", js: "//", go: "//", rust: "//", json: "//", css: null, sql: "--" };
const BLOCK_COMMENTS = new Set(["js", "go", "rust", "css", "json", "sql"]);
const EXTENSIONS = {
  rb: "ruby", rake: "ruby", gemspec: "ruby", ru: "ruby", erb: "ruby", jbuilder: "ruby", builder: "ruby",
  js: "js", jsx: "js", mjs: "js", cjs: "js", ts: "js", tsx: "js", mts: "js", cts: "js",
  py: "python", go: "go", rs: "rust", sh: "sh", bash: "sh", zsh: "sh",
  sql: "sql", css: "css", scss: "css", yml: "yaml", yaml: "yaml", toml: "toml", json: "json", jsonc: "json",
};
const NAMES = { Gemfile: "ruby", Rakefile: "ruby", Guardfile: "ruby", Brewfile: "ruby", Dockerfile: "sh" };

export function languageOf(path) {
  const name = path.split("/").pop();
  return NAMES[name] ?? EXTENSIONS[name.includes(".") ? name.split(".").pop() : ""] ?? null;
}

const patterns = new Map();
function pattern(language) {
  if (patterns.has(language)) return patterns.get(language);
  const line = COMMENTS[language];
  const comment = [line && `${line.replace(/[/*]/g, "\\$&")}.*$`, BLOCK_COMMENTS.has(language) && "/\\*.*?(?:\\*/|$)"].filter(Boolean).join("|");
  const parts = [
    comment && `(?<comment>${comment})`,
    // JSON keys and YAML/TOML keys at the start of a line.
    language === "json" && `(?<key>"(?:\\\\.|[^"\\\\])*"(?=\\s*:))`,
    (language === "yaml" || language === "toml") && `(?<key>^\\s*[\\w.-]+(?=\\s*[:=]))`,
    `(?<string>"(?:\\\\.|[^"\\\\])*"?|'(?:\\\\.|[^'\\\\])*'?|\`(?:\\\\.|[^\`\\\\])*\`?)`,
    language === "ruby" && `(?<symbol>:[A-Za-z_]\\w*[?!]?|\\b[a-z_]\\w*:(?!:))`,
    `(?<number>\\b\\d[\\d_]*(?:\\.\\d+)?\\b)`,
    `(?<word>[A-Za-z_$][\\w$]*${language === "ruby" ? "[?!]?" : ""})`,
  ].filter(Boolean);
  const built = { regex: new RegExp(parts.join("|"), "g"), words: new Set((WORDS[language] ?? "").split(" ")) };
  patterns.set(language, built);
  return built;
}

// [{ text, kind }] covering the whole line; kind is a key of colors(), or null for plain text.
export function tokens(text, language) {
  const { regex, words } = pattern(language);
  const out = [];
  let at = 0;
  regex.lastIndex = 0;
  for (let match; (match = regex.exec(text)); ) {
    if (match[0] === "") { regex.lastIndex++; continue; }
    if (match.index > at) out.push({ text: text.slice(at, match.index), kind: null });
    const groups = match.groups;
    let kind = null;
    if (groups.comment) kind = "comment";
    else if (groups.key) kind = "key";
    else if (groups.string) kind = "string";
    else if (groups.symbol) kind = "constant";
    else if (groups.number) kind = "number";
    else {
      const word = groups.word, before = text[match.index - 1], after = text[match.index + word.length];
      kind = words.has(word) ? "keyword" : LITERALS.has(word) ? "constant" : /^[A-Z]/.test(word) ? "type"
        // In Ruby every `.name` is a method call; elsewhere only `name(` is.
        : (language === "ruby" && before === ".") || after === "(" ? "function" : null;
    }
    out.push({ text: match[0], kind });
    at = match.index + match[0].length;
  }
  if (at < text.length) out.push({ text: text.slice(at), kind: null });
  return out;
}

// The same roles and colors as the Editor's syntax option, from the theme.
export const colors = (t) => ({ keyword: t.ansi5, string: t.ansi2, comment: t.dim, function: t.ansi4, type: t.ansi3, number: t.ansi1, constant: t.ansi6, key: t.ansi4 });
