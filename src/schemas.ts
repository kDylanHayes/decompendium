import { readFileSync } from "node:fs";
import { repoFile } from "./paths.ts";
import { Ajv2020, type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";
import addFormatsModule from "ajv-formats";

// ajv-formats is CommonJS; under Node ESM its default export can arrive wrapped.
const addFormats = ((addFormatsModule as unknown as { default?: typeof addFormatsModule }).default ??
  addFormatsModule) as unknown as (ajv: Ajv2020) => Ajv2020;

function loadSchema(name: string): object {
  return JSON.parse(readFileSync(repoFile(`schema/${name}`), "utf8"));
}

const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormats(ajv);
ajv.addSchema(loadSchema("defs.schema.json"));

export type SchemaName = "game" | "project" | "progress" | "config";

const validators = new Map<SchemaName, ValidateFunction>();

export function validator(name: SchemaName): ValidateFunction {
  let fn = validators.get(name);
  if (!fn) {
    fn = ajv.compile(loadSchema(`${name}.schema.json`));
    validators.set(name, fn);
  }
  return fn;
}

/** Validate `value` against a schema; returns readable messages, empty when valid. */
export function schemaErrors(name: SchemaName, value: unknown): string[] {
  const fn = validator(name);
  if (fn(value)) return [];
  return formatErrors(fn.errors ?? []);
}

function formatErrors(errors: ErrorObject[]): string[] {
  // oneOf failures report every branch. Drop the generic wrapper and the
  // const mismatches that only say "this was the other branch", keeping the
  // errors that explain what is actually wrong.
  const specific = errors.filter(
    (e) => e.keyword !== "oneOf" && !(e.keyword === "const" && e.schemaPath.includes("/oneOf/")),
  );
  const chosen = specific.length > 0 ? specific : errors;
  const messages = chosen.map((e) => {
    const where = e.instancePath === "" ? "(root)" : e.instancePath;
    if (e.keyword === "additionalProperties") {
      return `${where}: unknown field "${(e.params as { additionalProperty: string }).additionalProperty}"`;
    }
    if (e.keyword === "enum") {
      return `${where}: must be one of ${(e.params as { allowedValues: unknown[] }).allowedValues.join(", ")}`;
    }
    return `${where}: ${e.message}`;
  });
  return [...new Set(messages)];
}
