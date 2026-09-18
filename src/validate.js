/**
 * Runtime validation of tool arguments against the tool's own declared schema.
 *
 * ── WHY THIS FILE EXISTS ────────────────────────────────────────────────────
 *
 * Every tool in tools.js declares an `inputSchema`, and until this file was
 * written NOTHING EVER CHECKED ARGUMENTS AGAINST IT. `CallToolRequestSchema`
 * validates the JSON-RPC envelope — that `params.name` is a string and
 * `params.arguments` is an object — and then hands `arguments` straight to
 * `tool.run`. The schemas were documentation the model read and nothing
 * enforced.
 *
 * That is worse than having no schema. A model that emits `delay: -5000`,
 * `width: 99999`, `devicePreset: "iphone99"` or `maxPages: "twenty"` gets a
 * network round trip, a 400 from the API, and — for anything the API accepts
 * but did not mean — a capture it paid a credit for. The constraints were
 * already written down; they simply were not applied on the near side of the
 * wire, which is the only side that can refuse for free.
 *
 * ── WHY NOT ajv ─────────────────────────────────────────────────────────────
 *
 * ajv is present in node_modules as a transitive dependency of the MCP SDK, not
 * as one of ours. This package declares exactly one dependency, and tools.js is
 * deliberately "SDK-free ... so it can be tested without one"; taking a direct
 * dependency on a code-generating validator to check ten hand-written schemas
 * would be a poor trade for a package this small.
 *
 * ── WHY AN UNKNOWN KEYWORD IS AN ERROR ──────────────────────────────────────
 *
 * `assertKnownKeywords` refuses a schema containing a keyword this file does
 * not implement. The alternative — ignore what we do not understand — recreates
 * the exact failure this file exists to fix, silently and one keyword at a
 * time: someone adds `pattern` to a schema, the tool description promises it,
 * and nothing enforces it. Failing here is loud, happens on the developer's
 * machine, and is fixed by implementing the keyword.
 */

/** Keywords that constrain a value, and are enforced below. */
const ENFORCED = new Set([
  'type', 'enum', 'required', 'properties', 'additionalProperties',
  'propertyNames', 'maxProperties', 'minProperties',
  'items', 'minItems', 'maxItems',
  'minimum', 'maximum', 'minLength', 'maxLength',
]);

/** Keywords that describe rather than constrain. Accepted and ignored. */
const ANNOTATIONS = new Set(['description', 'title', 'default', 'examples', '$comment', '$schema']);

class ToolArgumentError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ToolArgumentError';
    this.code = 'INVALID_TOOL_ARGUMENTS';
  }
}

function fail(path, detail) {
  throw new ToolArgumentError(`${path} ${detail}`);
}

function typeMatches(value, type) {
  if (Array.isArray(type)) return type.some((candidate) => typeMatches(value, candidate));
  if (type === 'object') return value !== null && typeof value === 'object' && !Array.isArray(value);
  if (type === 'array') return Array.isArray(value);
  if (type === 'integer') return Number.isInteger(value);
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value);
  if (type === 'boolean') return typeof value === 'boolean';
  if (type === 'string') return typeof value === 'string';
  return true;
}

/**
 * Walk a schema at load time and refuse anything unimplemented.
 *
 * Called once per tool from index.js rather than per request: a schema is a
 * constant, so this is a startup assertion about OUR code, not a check on the
 * caller's input.
 */
export function assertKnownKeywords(schema, path = 'inputSchema') {
  if (!schema || typeof schema !== 'object') return;
  for (const keyword of Object.keys(schema)) {
    if (!ENFORCED.has(keyword) && !ANNOTATIONS.has(keyword)) {
      throw new Error(
        `${path}.${keyword} is not a keyword mcp/src/validate.js implements, so declaring it would `
        + 'promise a constraint nothing enforces. Implement it in validate.js or remove it.',
      );
    }
  }
  for (const [name, child] of Object.entries(schema.properties || {})) {
    assertKnownKeywords(child, `${path}.properties.${name}`);
  }
  if (schema.items) assertKnownKeywords(schema.items, `${path}.items`);
  if (schema.propertyNames) assertKnownKeywords(schema.propertyNames, `${path}.propertyNames`);
  if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
    assertKnownKeywords(schema.additionalProperties, `${path}.additionalProperties`);
  }
}

function validate(value, schema, path) {
  if (!schema || typeof schema !== 'object') return;

  if (schema.type !== undefined && !typeMatches(value, schema.type)) {
    const expected = Array.isArray(schema.type) ? schema.type.join(' or ') : schema.type;
    fail(path, `must be ${expected}.`);
  }
  if (schema.enum !== undefined && !schema.enum.some((candidate) => candidate === value)) {
    fail(path, `must be one of: ${schema.enum.join(', ')}.`);
  }

  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      fail(path, `is shorter than the ${schema.minLength}-character minimum.`);
    }
    if (schema.maxLength !== undefined && value.length > schema.maxLength) {
      fail(path, `is ${value.length} characters; the maximum is ${schema.maxLength}.`);
    }
  }

  // `typeMatches` above has already refused a non-finite number wherever `type`
  // says number/integer, so this only ever compares real numbers.
  if (typeof value === 'number' && Number.isFinite(value)) {
    if (schema.minimum !== undefined && value < schema.minimum) {
      fail(path, `is below the minimum of ${schema.minimum}.`);
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      fail(path, `is above the maximum of ${schema.maximum}.`);
    }
  }

  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      fail(path, `needs at least ${schema.minItems} item(s).`);
    }
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      fail(path, `has ${value.length} items; the maximum is ${schema.maxItems}.`);
    }
    if (schema.items) value.forEach((item, i) => validate(item, schema.items, `${path}[${i}]`));
  }

  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const keys = Object.keys(value);
    if (schema.minProperties !== undefined && keys.length < schema.minProperties) {
      fail(path, `needs at least ${schema.minProperties} propert(y/ies).`);
    }
    if (schema.maxProperties !== undefined && keys.length > schema.maxProperties) {
      fail(path, `has ${keys.length} properties; the maximum is ${schema.maxProperties}.`);
    }
    for (const name of schema.required || []) {
      // `undefined` counts as absent as well as missing: a model that emits
      // `{"url": undefined}` through a lax serializer means "I did not supply
      // this", and treating it as present sends the API a required field it
      // will reject anyway.
      if (value[name] === undefined) fail(`${path}.${name}`, 'is required.');
    }
    for (const key of keys) {
      if (value[key] === undefined) continue;
      // `Object.hasOwn`, NOT `schema.properties?.[key]`.
      //
      // A plain object inherits from Object.prototype, so `properties.toString`
      // resolved to the INHERITED function for any argument named `toString`,
      // `constructor`, `valueOf`, `hasOwnProperty` … `child` was then truthy,
      // this branch was taken, and `validate` returned immediately at its
      // `typeof schema !== 'object'` guard because a function is not an object.
      // The `continue` below meant the key never reached the
      // `additionalProperties: false` check — so `{"toString": …}` was accepted
      // by a schema that accepts nothing but its declared properties, and was
      // forwarded to the API unvalidated.
      const child = Object.hasOwn(schema.properties || {}, key) ? schema.properties[key] : undefined;
      if (child) {
        validate(value[key], child, `${path}.${key}`);
        continue;
      }
      if (schema.additionalProperties === false) {
        const known = Object.keys(schema.properties || {});
        fail(
          `${path}.${key}`,
          `is not a parameter of this tool.${known.length ? ` Accepted: ${known.join(', ')}.` : ''}`,
        );
      }
      if (schema.propertyNames) validate(key, schema.propertyNames, `${path}.${key} (property name)`);
      if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
        validate(value[key], schema.additionalProperties, `${path}.${key}`);
      }
    }
  }
}

/**
 * Check one call's arguments, or throw a message written for the model.
 *
 * The message names the parameter and the bound it broke, because the reader is
 * an agent deciding whether to retry — "delay is above the maximum of 5000" is
 * actionable and "invalid arguments" is not.
 */
export function assertValidToolArguments(toolName, schema, args) {
  validate(args ?? {}, schema, toolName);
}

export { ToolArgumentError };
