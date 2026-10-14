// calc — arithmetic, evaluated by a parser rather than by the language.
//
// ── why not just `js` ──
// `js` can do arithmetic and a great deal else. this exists because "what is 1234 * 5678"
// should not require handing a general evaluator a string, and because a model that
// reaches for a calculator tool rather than doing sums in its head is a model being
// correctly cautious about its own arithmetic.
//
// the sandbox is a tokeniser and a shunting-yard parser over `+ - * / % ^ ( )` and
// numbers — there is no host object reachable from it, because there is no host object in
// the parse tree to reach.

import { defineTool } from "../core/tools.js";
import { VfsError } from "../kernel/errors.js";

const OPS = {
  "+": { prec: 1, assoc: "left", fn: (a, b) => a + b },
  "-": { prec: 1, assoc: "left", fn: (a, b) => a - b },
  "*": { prec: 2, assoc: "left", fn: (a, b) => a * b },
  "/": { prec: 2, assoc: "left", fn: (a, b) => a / b },
  "%": { prec: 2, assoc: "left", fn: (a, b) => a % b },
  "^": { prec: 3, assoc: "right", fn: (a, b) => a ** b },
};

function tokenize(src) {
  const out = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (/[0-9.]/.test(ch)) {
      let j = i;
      while (j < src.length && /[0-9._]/.test(src[j])) j++;
      if (src[j] === "e" || src[j] === "E") {
        j++;
        if (src[j] === "+" || src[j] === "-") j++;
        while (j < src.length && /[0-9]/.test(src[j])) j++;
      }
      const raw = src.slice(i, j).replace(/_/g, "");
      const n = Number(raw);
      if (!Number.isFinite(n)) throw new VfsError("EINVAL", `not a number: ${raw}`);
      out.push({ t: "num", v: n });
      i = j;
      continue;
    }
    if (ch in OPS || ch === "(" || ch === ")") {
      // a leading `-` is a sign, not subtraction: `-3 + 1`
      const prev = out[out.length - 1];
      if (ch === "-" && (!prev || prev.t === "op" || prev.t === "(")) {
        out.push({ t: "num", v: 0 }, { t: "op", v: "-" });
        i++;
        continue;
      }
      out.push({ t: ch === "(" || ch === ")" ? ch : "op", v: ch });
      i++;
      continue;
    }
    throw new VfsError("EINVAL", `cannot parse: '${ch}' — only numbers and + - * / % ^ ( ) are allowed`);
  }
  return out;
}

function evaluate(tokens) {
  const values = [];
  const ops = [];
  const apply = () => {
    const op = ops.pop();
    const b = values.pop();
    const a = values.pop();
    if (a === undefined || b === undefined) throw new VfsError("EINVAL", "malformed expression");
    values.push(OPS[op].fn(a, b));
  };

  for (const tk of tokens) {
    if (tk.t === "num") {
      values.push(tk.v);
    } else if (tk.t === "(") {
      ops.push("(");
    } else if (tk.t === ")") {
      while (ops.length && ops[ops.length - 1] !== "(") apply();
      if (!ops.length) throw new VfsError("EINVAL", "unbalanced parentheses");
      ops.pop();
    } else {
      const o = OPS[tk.v];
      while (
        ops.length &&
        ops[ops.length - 1] !== "(" &&
        (OPS[ops[ops.length - 1]].prec > o.prec ||
          (OPS[ops[ops.length - 1]].prec === o.prec && o.assoc === "left"))
      ) {
        apply();
      }
      ops.push(tk.v);
    }
  }
  while (ops.length) {
    if (ops[ops.length - 1] === "(") throw new VfsError("EINVAL", "unbalanced parentheses");
    apply();
  }
  if (values.length !== 1) throw new VfsError("EINVAL", "malformed expression");
  return values[0];
}

export default defineTool({
  name: "calc",
  description:
    "Evaluate an arithmetic expression: + - * / % ^ and parentheses. Sandboxed to those, " +
    "so it cannot reach anything — which is why it is safe to hand a formula to.",
  params: {
    expression: { type: "string", positional: 0, required: true, description: "e.g. (1234 * 5678) + 99", input: true },
  },

  async run({ input }) {
    const value = evaluate(tokenize(input.expression));
    if (!Number.isFinite(value)) {
      throw new VfsError("EINVAL", `result is not a finite number: ${input.expression}`);
    }
    return { expression: input.expression, value };
  },
});
