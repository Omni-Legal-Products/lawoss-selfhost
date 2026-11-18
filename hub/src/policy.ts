import type { ToolPolicy } from './manifest.js';

export const DENY_TEXT = 'Tento nástroj je dostupný len v lokálnom plugine.';
export const SAVE_REFUSAL_TEXT = 'Ukladanie súborov na server nie je dostupné; výsledok dostanete v odpovedi.';

type Effective = { kind: 'allow'; without: readonly string[] } | { kind: 'deny' };

/** Default deny: only an own `allow` entry or a well-formed `allow-without` entry lets a tool through. */
function effective(policies: Readonly<Record<string, ToolPolicy>>, name: string): Effective {
  if (!Object.hasOwn(policies, name)) return { kind: 'deny' };
  const policy: unknown = policies[name];
  if (policy === 'allow') return { kind: 'allow', without: [] };
  if (policy !== null && typeof policy === 'object' && Object.hasOwn(policy, 'allow-without')) {
    const without: unknown = (policy as Record<string, unknown>)['allow-without'];
    if (Array.isArray(without) && without.every(arg => typeof arg === 'string')) return { kind: 'allow', without };
  }
  return { kind: 'deny' };
}

export interface ListedTool {
  name: string;
  inputSchema: { properties?: Record<string, unknown>; required?: string[]; [key: string]: unknown };
}

/** The arguments an `allow-without` policy removes; empty for any other policy. */
export function withoutArgumentsOf(policies: Readonly<Record<string, ToolPolicy>>, name: string): readonly string[] {
  const policy = effective(policies, name);
  return policy.kind === 'allow' ? policy.without : [];
}

/**
 * Fail closed on a manifest that does not match the runtime: every argument an `allow-without`
 * policy names must be a property of the runtime's input schema, or the tool is not offered.
 */
export function schemaCovers(tool: ListedTool, names: readonly string[]): boolean {
  const properties = tool.inputSchema.properties;
  return names.every(name => properties !== null && typeof properties === 'object' && Object.hasOwn(properties, name));
}

function withoutArguments<T extends ListedTool>(tool: T, names: readonly string[]): T {
  if (names.length === 0) return tool;
  const schema = { ...tool.inputSchema };
  if (schema.properties) schema.properties = Object.fromEntries(
    Object.entries(schema.properties).filter(([key]) => !names.includes(key)));
  if (Array.isArray(schema.required)) schema.required = schema.required.filter(key => !names.includes(key));
  return { ...tool, inputSchema: schema };
}

/**
 * The tools a remote client may see: denied and unreviewed tools are hidden; `allow-without`
 * tools lose those properties and are hidden when the runtime schema lacks one of them.
 * Returns new objects and never mutates the runtime's list.
 */
export function listedTools<T extends ListedTool>(policies: Readonly<Record<string, ToolPolicy>>, tools: readonly T[]): T[] {
  const result: T[] = [];
  for (const tool of tools) {
    const policy = effective(policies, tool.name);
    if (policy.kind === 'allow' && schemaCovers(tool, policy.without)) result.push(withoutArguments(tool, policy.without));
  }
  return result;
}

export type CallDecision = { allowed: true } | { allowed: false; text: string };

/** Decides a tools/call before any runtime is involved. A listed argument refuses the call whatever its value. */
export function checkCall(policies: Readonly<Record<string, ToolPolicy>>, name: string, args: unknown): CallDecision {
  const policy = effective(policies, name);
  if (policy.kind === 'deny') return { allowed: false, text: DENY_TEXT };
  if (args !== null && typeof args === 'object' && policy.without.some(key => Object.hasOwn(args, key)))
    return { allowed: false, text: SAVE_REFUSAL_TEXT };
  return { allowed: true };
}
