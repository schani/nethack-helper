// Shared helpers for the assistant tools (ported from voice-proto/server/tools.ts).

/** An error whose message is safe and useful to show the model as the tool result. */
export class ToolError extends Error {}


export function str(v: unknown, name: string, required = true): string | undefined {
  if (v === undefined || v === null || v === "") {
    if (required) throw new ToolError(`missing required argument '${name}'`);
    return undefined;
  }
  if (typeof v !== "string") throw new ToolError(`argument '${name}' must be a string`);
  return v.trim();
}

export function clip(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 20).trimEnd() + " …[truncated]";
}

export function withTimeout(ms: number, outer?: AbortSignal): AbortSignal {
  const t = AbortSignal.timeout(ms);
  return outer ? AbortSignal.any([t, outer]) : t;
}

