import { AxiError } from "axi-sdk-js";
import { cliInvocation } from "./invocation.js";

export interface Parsed {
  positionals: string[];
  flags: Record<string, string | boolean>;
}

/**
 * Parse `--flag value` and bare `--flag` arguments, rejecting any flag the
 * command does not declare (exit 2) with its valid flags listed, so a dropped
 * flag never yields plausible output.
 */
export function parseArgs(
  args: string[],
  spec: { bool?: string[]; value?: string[]; maxPositionals?: number },
  usage: string,
): Parsed {
  const bool = spec.bool ?? [];
  const value = spec.value ?? [];
  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      const name = eq > 0 ? a.slice(2, eq) : a.slice(2);
      if (bool.includes(name)) {
        if (eq > 0) throw usageError(`--${name} takes no value`, usage);
        flags[name] = true;
      } else if (value.includes(name)) {
        const v = eq > 0 ? a.slice(eq + 1) : args[++i];
        if (v === undefined || (eq < 0 && v.startsWith("--"))) throw usageError(`--${name} needs a value`, usage);
        flags[name] = v;
      } else {
        const valid = [...value, ...bool].map((f) => `--${f}`).join(", ");
        throw usageError(`unknown flag --${name}`, usage, valid ? `valid flags here: ${valid}` : "this command takes no flags");
      }
    } else {
      positionals.push(a);
    }
  }
  if (positionals.length > (spec.maxPositionals ?? 0)) {
    throw usageError(`unexpected argument ${JSON.stringify(positionals[spec.maxPositionals ?? 0])}`, usage);
  }
  return { positionals, flags };
}

export function usageError(message: string, usage: string, extra?: string): AxiError {
  const help = [`${cliInvocation()} ${usage}`];
  if (extra) help.unshift(extra);
  return new AxiError(message, "VALIDATION_ERROR", help);
}

export function intFlag(flags: Parsed["flags"], name: string, usage: string, opts: { min?: number; max?: number } = {}): number | undefined {
  const v = flags[name];
  if (v === undefined) return undefined;
  if (typeof v !== "string" || !/^\d+$/.test(v)) throw usageError(`--${name} must be a whole number`, usage);
  const n = Number(v);
  if (opts.min !== undefined && n < opts.min) throw usageError(`--${name} must be at least ${opts.min}`, usage);
  if (opts.max !== undefined && n > opts.max) throw usageError(`--${name} must be at most ${opts.max}`, usage);
  return n;
}

/** Exit code for the current process; the SDK writes output first and then exits with it. */
export function setExit(code: number): void {
  process.exitCode = code;
}
