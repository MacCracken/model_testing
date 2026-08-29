// Minimal JSON-Schema subset validator (type / properties / required / items / enum).
//
// The harness's whole premise is "tools + output schema + structured prompts". Without an
// actual check, `schemaValid` is a constant and tells you nothing. This is deliberately small:
// enough to distinguish "returned the requested shape" from "returned something else".

export function validateSchema(value, schema, path = "$") {
  const errors = [];
  if (!schema || typeof schema !== "object") return { valid: true, errors };

  if (schema.type && !matchesType(value, schema.type)) {
    errors.push(`${path}: expected ${schema.type}, got ${describe(value)}`);
    return { valid: false, errors };
  }

  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    errors.push(`${path}: ${JSON.stringify(value)} not in ${JSON.stringify(schema.enum)}`);
  }

  if (schema.type === "object" || (!schema.type && isPlainObject(value))) {
    if (!isPlainObject(value)) return { valid: errors.length === 0, errors };
    for (const key of schema.required ?? []) {
      if (value[key] === undefined) errors.push(`${path}.${key}: required field missing`);
    }
    for (const [key, sub] of Object.entries(schema.properties ?? {})) {
      if (value[key] === undefined) continue;
      errors.push(...validateSchema(value[key], sub, `${path}.${key}`).errors);
    }
  }

  if (schema.type === "array" && Array.isArray(value)) {
    if (typeof schema.minItems === "number" && value.length < schema.minItems) {
      errors.push(`${path}: expected at least ${schema.minItems} items, got ${value.length}`);
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
