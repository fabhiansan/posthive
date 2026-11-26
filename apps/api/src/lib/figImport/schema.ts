import { ByteBuffer, compileSchemaJS, decodeBinarySchema, type Definition, type Field, type Schema } from "kiwi-schema";
import { FIG_LIMITS, fail } from "./limits.js";

const NATIVE_TYPES = new Set(["bool", "byte", "int", "uint", "float", "string", "int64", "uint64"]);
const KINDS = new Set(["ENUM", "STRUCT", "MESSAGE"]);
const FORBIDDEN_NAMES = new Set(["__proto__", "constructor", "prototype", "ByteBuffer", "exports", "Array", "require"]);
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

function name(value: string): void {
  if (value.length > FIG_LIMITS.schemaName || !IDENTIFIER.test(value) || FORBIDDEN_NAMES.has(value)) fail("FIG_INVALID");
}

/** Counts are checked before kiwi allocates definition/field objects from attacker-supplied varints. */
function preflight(bytes: Uint8Array): void {
  const bb = new ByteBuffer(bytes);
  const definitions = bb.readVarUint();
  if (definitions === 0 || definitions > FIG_LIMITS.schemaDefinitions) fail("FIG_LIMIT");
  const definitionNames = new Set<string>();
  let totalFields = 0;
  for (let i = 0; i < definitions; i++) {
    const definitionName = bb.readString();
    name(definitionName);
    if (definitionNames.has(definitionName)) fail("FIG_INVALID");
    definitionNames.add(definitionName);
    const kind = bb.readByte();
    if (kind < 0 || kind > 2) fail("FIG_INVALID");
    const fields = bb.readVarUint();
    if (fields > FIG_LIMITS.schemaFieldsPerDefinition || totalFields + fields > FIG_LIMITS.schemaFields) fail("FIG_LIMIT");
    totalFields += fields;
    const fieldNames = new Set<string>();
    for (let j = 0; j < fields; j++) {
      const fieldName = bb.readString();
      name(fieldName);
      if (fieldNames.has(fieldName)) fail("FIG_INVALID");
      fieldNames.add(fieldName);
      bb.readVarInt(); // native type index (negative) or definition index
      bb.readByte(); // array flag
      bb.readVarUint(); // field number
    }
  }
  let trailing = false;
  try {
    bb.readByte();
    trailing = true;
  } catch {
    // ByteBuffer's only failure here is EOF: exactly the bytes consumed above.
  }
  if (trailing) fail("FIG_INVALID");
}

function validate(decoded: Schema): Schema {
  if (!decoded || decoded.package !== null || !Array.isArray(decoded.definitions)) fail("FIG_INVALID");
  const own = new Map<string, Definition>();
  for (const definition of decoded.definitions) {
    name(definition.name);
    if (own.has(definition.name) || !KINDS.has(definition.kind) || !Array.isArray(definition.fields)) fail("FIG_INVALID");
    if (definition.fields.length > FIG_LIMITS.schemaFieldsPerDefinition) fail("FIG_LIMIT");
    own.set(definition.name, definition);
  }
  let totalFields = 0;
  for (const definition of decoded.definitions) {
    const fields = new Set<string>();
    for (const field of definition.fields) {
      name(field.name);
      if (fields.has(field.name)) fail("FIG_INVALID");
      fields.add(field.name);
      if (definition.kind === "ENUM") {
        if (field.type !== null) fail("FIG_INVALID");
      } else if (typeof field.type !== "string" || (!NATIVE_TYPES.has(field.type) && !own.has(field.type))) {
        fail("FIG_INVALID"); // includes inherited names such as toString on a plain object
      }
      if (typeof field.isArray !== "boolean" || !Number.isSafeInteger(field.value) || field.value < 0) fail("FIG_INVALID");
      totalFields++;
    }
  }
  if (totalFields > FIG_LIMITS.schemaFields) fail("FIG_LIMIT");
  // A fresh own-property copy: no prototype, package or extra property from the decoded object reaches codegen.
  return {
    package: null,
    definitions: decoded.definitions.map((definition) => ({
      name: definition.name,
      line: 0,
      column: 0,
      kind: definition.kind,
      fields: definition.fields.map((field): Field => ({
        name: field.name,
        line: 0,
        column: 0,
        type: field.type,
        isArray: field.isArray,
        isDeprecated: false,
        value: field.value,
      })),
    })),
  };
}

export interface CompiledSchemaSource {
  schema: Schema;
  source: string;
}

export function compileSchemaSource(bytes: Uint8Array): CompiledSchemaSource {
  if (bytes.length > FIG_LIMITS.schemaBytes) fail("FIG_LIMIT");
  preflight(bytes);
  const schema = validate(decodeBinarySchema(bytes));
  const source = compileSchemaJS(schema);
  if (source.length > FIG_LIMITS.generatedJs || !source.startsWith("var exports = exports || {};")) fail("FIG_INVALID");
  if (/\["(?:__proto__|constructor|prototype)"\]|"(?:__proto__|constructor|prototype)":/.test(source)) fail("FIG_INVALID");
  return { schema, source };
}
