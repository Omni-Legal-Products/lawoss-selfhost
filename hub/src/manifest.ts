import { readFileSync } from 'node:fs';

/** Lowercase DNS label; the service id is also the hostname prefix. */
export type ServiceId = string;

/** `allow-without` lists argument names that are removed from the schema and refused in calls. */
export type ToolPolicy = 'allow' | 'deny-remote' | { 'allow-without': string[] };

export interface ServiceEntry {
  plugin: string;
  server?: string;
  tools: Record<string, ToolPolicy>;
  env: string[];
  stateEnv?: string;
}

export interface Manifest {
  catalogCommit: string;
  services: Record<ServiceId, ServiceEntry>;
}

const DNS_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const ENV_NAME = /^[A-Z][A-Z0-9_]*$/;
const COMMIT = /^[0-9a-f]{40}$/;

/**
 * Parses JSON like JSON.parse but throws on a duplicate object key, which JSON.parse would
 * silently resolve to the last value (a policy line could then be shadowed unnoticed).
 */
export function parseStrictJson(text: string): unknown {
  let index = 0;
  const fail = (message: string): never => {
    throw new Error(`Invalid manifest JSON at offset ${index}: ${message}`);
  };
  const skip = (): void => {
    while (index < text.length && ' \t\n\r'.includes(text[index])) index++;
  };
  const string = (): string => {
    const start = index;
    if (text[index] !== '"') fail('expected a string');
    index++;
    while (index < text.length && text[index] !== '"') index += text[index] === '\\' ? 2 : 1;
    if (index >= text.length) fail('unterminated string');
    index++;
    return JSON.parse(text.slice(start, index)) as string;
  };
  const value = (): unknown => {
    skip();
    const char = text[index];
    if (char === '{') {
      index++;
      const result: Record<string, unknown> = {};
      skip();
      if (text[index] === '}') { index++; return result; }
      for (;;) {
        skip();
        const key = string();
        if (Object.hasOwn(result, key)) fail(`duplicate key "${key}"`);
        skip();
        if (text[index++] !== ':') fail('expected ":"');
        Object.defineProperty(result, key, { value: value(), enumerable: true, writable: true, configurable: true });
        skip();
        const next = text[index++];
        if (next === '}') return result;
        if (next !== ',') fail('expected "," or "}"');
      }
    }
    if (char === '[') {
      index++;
      const result: unknown[] = [];
      skip();
      if (text[index] === ']') { index++; return result; }
      for (;;) {
        result.push(value());
        skip();
        const next = text[index++];
        if (next === ']') return result;
        if (next !== ',') fail('expected "," or "]"');
      }
    }
    if (char === '"') return string();
    const literal = /^(?:true|false|null|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(text.slice(index));
    if (!literal) return fail('unexpected token');
    index += literal[0].length;
    return JSON.parse(literal[0]);
  };
  const result = value();
  skip();
  if (index !== text.length) fail('trailing content');
  return result;
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

function validatePolicy(where: string, policy: unknown): ToolPolicy {
  if (policy === 'allow' || policy === 'deny-remote') return policy;
  if (isObject(policy) && Object.keys(policy).length === 1 && Array.isArray(policy['allow-without'])) {
    const args = policy['allow-without'];
    if (args.length === 0 || args.some(a => typeof a !== 'string' || !a) || new Set(args).size !== args.length)
      throw new Error(`${where}: allow-without must be a non-empty list of distinct argument names`);
    return { 'allow-without': [...args] as string[] };
  }
  throw new Error(`${where}: policy must be "allow", "deny-remote" or {"allow-without": [...]}`);
}

function validateService(id: string, entry: unknown): ServiceEntry {
  if (!DNS_LABEL.test(id)) throw new Error(`Invalid service id "${id}": must be a lowercase DNS label`);
  if (!isObject(entry)) throw new Error(`Service ${id}: must be an object`);
  const known = new Set(['plugin', 'server', 'tools', 'env', 'stateEnv']);
  const unknown = Object.keys(entry).find(key => !known.has(key));
  if (unknown) throw new Error(`Service ${id}: unknown field ${unknown}`);
  if (typeof entry.plugin !== 'string' || !SLUG.test(entry.plugin))
    throw new Error(`Service ${id}: plugin must be a lowercase plugin slug`);
  if (entry.server !== undefined && (typeof entry.server !== 'string' || !SLUG.test(entry.server)))
    throw new Error(`Service ${id}: server must be a lowercase server slug`);
  if (!isObject(entry.tools) || Object.keys(entry.tools).length === 0)
    throw new Error(`Service ${id}: tools must be a non-empty object`);
  const tools: Record<string, ToolPolicy> = {};
  for (const [name, policy] of Object.entries(entry.tools))
    tools[name] = validatePolicy(`Service ${id}, tool ${name}`, policy);
  if (!Array.isArray(entry.env) || entry.env.some(n => typeof n !== 'string' || !ENV_NAME.test(n)) ||
      new Set(entry.env).size !== entry.env.length)
    throw new Error(`Service ${id}: env must be a list of distinct upper-case variable names`);
  if (entry.stateEnv !== undefined && (typeof entry.stateEnv !== 'string' || !ENV_NAME.test(entry.stateEnv)))
    throw new Error(`Service ${id}: stateEnv must be an upper-case variable name`);
  const result: ServiceEntry = { plugin: entry.plugin, tools, env: [...entry.env as string[]] };
  if (entry.server !== undefined) result.server = entry.server as string;
  if (entry.stateEnv !== undefined) result.stateEnv = entry.stateEnv as string;
  return result;
}

export function parseManifest(text: string): Manifest {
  const raw = parseStrictJson(text);
  if (!isObject(raw)) throw new Error('Manifest must be an object');
  if (typeof raw.catalogCommit !== 'string' || !COMMIT.test(raw.catalogCommit))
    throw new Error('Manifest catalogCommit must be a 40-character lowercase hex commit');
  if (!isObject(raw.services) || Object.keys(raw.services).length === 0)
    throw new Error('Manifest services must be a non-empty object');
  const services: Record<ServiceId, ServiceEntry> = {};
  for (const [id, entry] of Object.entries(raw.services)) services[id] = validateService(id, entry);
  return { catalogCommit: raw.catalogCommit, services };
}

export function loadManifest(path: string): Manifest {
  return parseManifest(readFileSync(path, 'utf8'));
}
