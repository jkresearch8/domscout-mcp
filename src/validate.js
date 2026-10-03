/** Validate arguments before an API request can be billed.
 * The MCP SDK validates the request envelope; tool constraints need their own check.
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

/** Reject unsupported schema keywords before the server advertises a tool. */
export function assertKnownKeywords(schema, path = 'inputSchema') {
  if (!schema || typeof schema !== 'object') return;
  for (const keyword of Object.keys(schema)) {
    if (!ENFORCED.has(keyword) && !ANNOTATIONS.has(keyword)) {
      throw new Error(
        `${path}.${keyword} is not a keyword the tool argument validator supports.`,
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
      // Inherited Object.prototype members are not declared schema properties.
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
