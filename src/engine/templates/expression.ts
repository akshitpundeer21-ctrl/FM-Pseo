/**
 * Tiny, safe expression evaluator for template block conditions.
 *
 * Deliberately NOT `eval` / `new Function`: template conditions are operator-
 * editable data, so they must never be able to execute arbitrary code.
 *
 * Grammar (sufficient for conditional rendering, intentionally small):
 *   expr    := or
 *   or      := and ( "||" and )*
 *   and     := unary ( "&&" unary )*
 *   unary   := "!" unary | primary
 *   primary := "(" expr ")" | comparison | path | literal
 *   comparison := path op operand      op := == != > >= < <=
 *   operand := number | 'string' | "string" | true | false | null | path
 *
 * Unknown paths evaluate to undefined, and undefined is falsy - a condition
 * referring to data that did not resolve simply hides the block.
 */
import { lookup } from "@/engine/data/types";

type Value = unknown;

export function evaluateCondition(expression: string | null | undefined, values: Record<string, unknown>): boolean {
  if (!expression || !expression.trim()) return true;
  try {
    const parser = new Parser(expression, values);
    const result = parser.parseExpression();
    parser.expectEnd();
    return truthy(result);
  } catch {
    // A malformed condition must not take a page down; it hides the block and
    // the renderer records the reason.
    return false;
  }
}

export function truthy(v: Value): boolean {
  if (v === undefined || v === null) return false;
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0 && !Number.isNaN(v);
  if (typeof v === "string") return v.trim().length > 0;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === "object") return Object.keys(v as object).length > 0;
  return Boolean(v);
}

const TOKEN_RE = /\s*(\|\||&&|==|!=|>=|<=|[()!<>]|'[^']*'|"[^"]*"|[A-Za-z_][\w.]*|-?\d+(?:\.\d+)?)/y;

class Parser {
  private tokens: string[] = [];
  private pos = 0;

  constructor(
    input: string,
    private readonly values: Record<string, unknown>,
  ) {
    TOKEN_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    let index = 0;
    while (index < input.length) {
      TOKEN_RE.lastIndex = index;
      m = TOKEN_RE.exec(input);
      if (!m) {
        if (input.slice(index).trim() === "") break;
        throw new Error(`Unexpected token at ${index}`);
      }
      this.tokens.push(m[1]);
      index = TOKEN_RE.lastIndex;
    }
  }

  private peek(): string | undefined {
    return this.tokens[this.pos];
  }
  private next(): string | undefined {
    return this.tokens[this.pos++];
  }

  expectEnd() {
    if (this.pos !== this.tokens.length) throw new Error("Trailing tokens in expression");
  }

  parseExpression(): Value {
    let left = this.parseAnd();
    while (this.peek() === "||") {
      this.next();
      const right = this.parseAnd();
      left = truthy(left) || truthy(right);
    }
    return left;
  }

  private parseAnd(): Value {
    let left = this.parseUnary();
    while (this.peek() === "&&") {
      this.next();
      const right = this.parseUnary();
      left = truthy(left) && truthy(right);
    }
    return left;
  }

  private parseUnary(): Value {
    if (this.peek() === "!") {
      this.next();
      return !truthy(this.parseUnary());
    }
    return this.parseComparison();
  }

  private parseComparison(): Value {
    const left = this.parsePrimary();
    const op = this.peek();
    if (op && ["==", "!=", ">", ">=", "<", "<="].includes(op)) {
      this.next();
      const right = this.parsePrimary();
      return compare(left, op, right);
    }
    return left;
  }

  private parsePrimary(): Value {
    const token = this.next();
    if (token === undefined) throw new Error("Unexpected end of expression");

    if (token === "(") {
      const inner = this.parseExpression();
      if (this.next() !== ")") throw new Error("Missing closing parenthesis");
      return inner;
    }
    if (token.startsWith("'") || token.startsWith('"')) return token.slice(1, -1);
    if (/^-?\d+(\.\d+)?$/.test(token)) return Number(token);
    if (token === "true") return true;
    if (token === "false") return false;
    if (token === "null") return null;
    return lookup(this.values, token);
  }
}

function compare(a: Value, op: string, b: Value): boolean {
  switch (op) {
    case "==":
      return looseEqual(a, b);
    case "!=":
      return !looseEqual(a, b);
    case ">":
      return numeric(a) > numeric(b);
    case ">=":
      return numeric(a) >= numeric(b);
    case "<":
      return numeric(a) < numeric(b);
    case "<=":
      return numeric(a) <= numeric(b);
    default:
      return false;
  }
}

function looseEqual(a: Value, b: Value): boolean {
  if (a === null || a === undefined || b === null || b === undefined) return a === b;
  if (typeof a === "number" || typeof b === "number") return numeric(a) === numeric(b);
  return String(a) === String(b);
}

function numeric(v: Value): number {
  if (typeof v === "number") return v;
  if (Array.isArray(v)) return v.length;
  const n = Number(v);
  return Number.isNaN(n) ? 0 : n;
}

/**
 * Interpolate {{path}} placeholders. Missing paths render as an empty string
 * and are reported so the renderer can flag an incomplete block.
 */
export function interpolate(
  template: string,
  values: Record<string, unknown>,
): { text: string; missing: string[] } {
  const missing: string[] = [];
  const text = template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, path: string) => {
    const v = lookup(values, path);
    if (v === undefined || v === null || v === "") {
      missing.push(path);
      return "";
    }
    if (Array.isArray(v)) return v.map((x) => (typeof x === "object" ? JSON.stringify(x) : String(x))).join(", ");
    return String(v);
  });
  return { text: text.replace(/\s{2,}/g, " ").trim(), missing };
}
