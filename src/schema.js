// Minimal JSON-Schema subset validator.
//
// The harness's whole premise is "tools + output schema + structured prompts". Without an
// actual check, `schemaValid` is a constant and tells you nothing. This is deliberately small:
// enough to distinguish "returned the requested shape" from "returned something else".
//
// Supported: type, enum, const, properties, required, additionalProperties (false or a schema),
// items, minItems, maxItems, uniqueItems, minLength, maxLength, pattern, format (date-time, date,
// uuid, email, uri), minimum, maximum, exclusiveMinimum, exclusiveMaximum, multipleOf.

export function validateSchema(value, schema, path = "$") {
  const errors = [];
  if (!schema || typeof schema !== "object") return { valid: true, errors };

  if (schema.type && !matchesType(value, schema.type)) {
    errors.push(`${path}: expected ${schema.type}, got ${describe(value)}`);
    return { valid: false, errors };
  }

  if (Array.isArray(schema.enum) && !schema.enum.some((e) => deepEqual(e, value))) {
    errors.push(`${path}: ${JSON.stringify(value)} not in ${JSON.stringify(schema.enum)}`);
  }
  if ("const" in schema && !deepEqual(schema.const, value)) {
    errors.push(`${path}: expected the constant ${JSON.stringify(schema.const)}, got ${JSON.stringify(value)}`);
  }

  if (typeof value === "string") {
    if (typeof schema.minLength === "number" && value.length < schema.minLength) errors.push(`${path}: shorter than ${schema.minLength} characters`);
    if (typeof schema.maxLength === "number" && value.length > schema.maxLength) errors.push(`${path}: longer than ${schema.maxLength} characters`);
    if (typeof schema.pattern === "string" && !safeRegex(schema.pattern).test(value)) errors.push(`${path}: does not match /${schema.pattern}/`);
    if (typeof schema.format === "string" && !matchesFormat(value, schema.format)) errors.push(`${path}: not a valid ${schema.format}`);
  }

  if (typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum) errors.push(`${path}: ${value} is below the minimum ${schema.minimum}`);
    if (typeof schema.maximum === "number" && value > schema.maximum) errors.push(`${path}: ${value} is above the maximum ${schema.maximum}`);
    if (typeof schema.exclusiveMinimum === "number" && value <= schema.exclusiveMinimum) errors.push(`${path}: ${value} must be greater than ${schema.exclusiveMinimum}`);
    if (typeof schema.exclusiveMaximum === "number" && value >= schema.exclusiveMaximum) errors.push(`${path}: ${value} must be less than ${schema.exclusiveMaximum}`);
    if (typeof schema.multipleOf === "number" && schema.multipleOf > 0 && Math.abs(value / schema.multipleOf - Math.round(value / schema.multipleOf)) > 1e-9) {
      errors.push(`${path}: ${value} is not a multiple of ${schema.multipleOf}`);
    }
  }

  if (schema.type === "object" || (!schema.type && isPlainObject(value))) {
    if (!isPlainObject(value)) return { valid: errors.length === 0, errors };
    for (const key of schema.required ?? []) {
      if (value[key] === undefined) errors.push(`${path}.${key}: required field missing`);
    }
    const props = schema.properties ?? {};
    for (const [key, sub] of Object.entries(props)) {
      if (value[key] === undefined) continue;
      errors.push(...validateSchema(value[key], sub, `${path}.${key}`).errors);
    }
    if (schema.additionalProperties !== undefined && schema.additionalProperties !== true) {
      for (const key of Object.keys(value)) {
        if (key in props) continue;
        if (schema.additionalProperties === false) errors.push(`${path}.${key}: unexpected property`);
        else errors.push(...validateSchema(value[key], schema.additionalProperties, `${path}.${key}`).errors);
      }
    }
  }

  if (schema.type === "array" && Array.isArray(value)) {
    if (typeof schema.minItems === "number" && value.length < schema.minItems) {
      errors.push(`${path}: expected at least ${schema.minItems} items, got ${value.length}`);
    }
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems) {
      errors.push(`${path}: expected at most ${schema.maxItems} items, got ${value.length}`);
    }
    if (schema.uniqueItems === true) {
      const seen = new Set();
      for (const item of value) {
        const key = JSON.stringify(item);
        if (seen.has(key)) { errors.push(`${path}: items are not unique (${key})`); break; }
        seen.add(key);
      }
    }
    if (schema.items) {
      value.forEach((item, i) => {
        errors.push(...validateSchema(item, schema.items, `${path}[${i}]`).errors);
      });
    }
  }

  return { valid: errors.length === 0, errors };
}

function matchesType(value, type) {
  if (Array.isArray(type)) return type.some((t) => matchesType(value, t));
  switch (type) {
    case "object": return isPlainObject(value);
    case "array": return Array.isArray(value);
    case "string": return typeof value === "string";
    case "number": return typeof value === "number" && Number.isFinite(value);
    case "integer": return Number.isInteger(value);
    case "boolean": return typeof value === "boolean";
    case "null": return value === null;
    default: return true;
  }
}

const FORMATS = {
  "date-time": (s) => /^\d{4}-\d{2}-\d{2}[Tt ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?([Zz]|[+-]\d{2}:?\d{2})?$/.test(s) && !Number.isNaN(Date.parse(s)),
  date: (s) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s)),
  uuid: (s) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s),
  email: (s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s),
  uri: (s) => { try { new URL(s); return true; } catch { return false; } },
};

// Unknown formats are not validated (JSON Schema treats format as an annotation by default).
function matchesFormat(value, format) {
  const check = FORMATS[format];
  return check ? check(value) : true;
}

function safeRegex(pattern) {
  try { return new RegExp(pattern); } catch { return /(?:)/; }
}

function deepEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function isPlainObject(v) {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function describe(v) {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
}

// Render a schema as a compact hint for the system prompt. Giving the model the shape is part
// of the harness under test, so it belongs in the prompt, not just in the scorer.
export function schemaHint(schema) {
  return JSON.stringify(schema, null, 2);
}
