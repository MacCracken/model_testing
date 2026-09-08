// calc.js — a small exact arithmetic evaluator for the calculator tool: integers and decimals with
// + - * / and parentheses, unary minus, thousands separators tolerated, × and ÷ accepted. No eval.

export function calc(expression) {
  const s = String(expression ?? "").replace(/×/g, "*").replace(/÷/g, "/").replace(/−/g, "-");
  let i = 0;
  const skip = () => { while (i < s.length && /\s/.test(s[i])) i++; };
  const peek = () => { skip(); return s[i]; };
  function number() {
    skip();
    const m = /^\d[\d,]*(\.\d+)?|^\.\d+/.exec(s.slice(i));
    if (!m) throw new Error(`expected a number at position ${i} in "${s}"`);
    i += m[0].length;
    return Number(m[0].replace(/,/g, ""));
  }
  function factor() {
    const c = peek();
    if (c === "(") { i++; const v = expr(); if (peek() !== ")") throw new Error("missing )"); i++; return v; }
    if (c === "-") { i++; return -factor(); }
    if (c === "+") { i++; return factor(); }
    return number();
  }
  function term() {
    let v = factor();
    for (;;) {
      const c = peek();
      if (c === "*") { i++; v *= factor(); }
      else if (c === "/") { i++; const d = factor(); if (d === 0) throw new Error("division by zero"); v /= d; }
      else return v;
    }
  }
  function expr() {
    let v = term();
    for (;;) {
      const c = peek();
      if (c === "+") { i++; v += term(); }
      else if (c === "-") { i++; v -= term(); }
      else return v;
    }
  }
  const v = expr();
  skip();
  if (i < s.length) throw new Error(`unexpected "${s[i]}" at position ${i} in "${s}"`);
  if (!Number.isFinite(v)) throw new Error("not a finite number");
  return v;
}

export const calcTool = {
  name: "calc",
  description: "Evaluate one arithmetic expression exactly — integers and decimals with + - * / and parentheses. Returns { expression, result }. Use it for every calculation instead of arithmetic in your head.",
  parameters: { type: "object", properties: { expression: { type: "string", description: "e.g. (120 + 35) * 4 - 18" } }, required: ["expression"] },
  impl: async ({ expression }) => ({ expression: String(expression ?? ""), result: calc(expression) }),
};
