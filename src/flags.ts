// Single source of truth for option names the CLI claims before operation
// parsing. The contract compiler validates override flag aliases against
// these, so an alias can never be shadowed at runtime.
//
// Only genuinely global options belong here. Options that exist solely inside a
// connection subcommand (`--target`, `--secret-key-stdin`, `--no-verify`) are
// parsed by that subcommand, so they never reserve a name an API operation
// might legitimately want.
export const GLOBAL_VALUE_FLAG_NAMES = [
  "public-key",
  "host",
  "profile",
  "config-file",
  "env",
  "api-version",
  "timeout",
  "out-file",
  "output",
] as const;

export const GLOBAL_BOOLEAN_FLAG_NAMES = [
  "json",
  "raw",
  "curl",
  "show-secrets",
] as const;

export const BODY_CHANNEL_FLAG_NAMES = ["body-json", "body-file"] as const;

export const PAGINATION_FLAG_NAMES = ["all", "max-items"] as const;

/**
 * Options that were removed and must fail loudly instead of being silently
 * reinterpreted as an operation argument.
 *
 * `--secret-key` is gone on purpose: a secret passed as an argument is recorded
 * in shell history and is readable from the process list while the command runs.
 */
export const REMOVED_FLAGS: ReadonlyMap<string, string> = new Map([
  [
    "secret-key",
    "--secret-key was removed: an argument-borne secret leaks into shell history and the process list. Use `langfuse-cli auth login` (masked prompt, or --secret-key-stdin), or set LANGFUSE_SECRET_KEY.",
  ],
]);

export const RESERVED_OPTION_NAMES: ReadonlySet<string> = new Set<string>([
  ...GLOBAL_VALUE_FLAG_NAMES,
  ...GLOBAL_BOOLEAN_FLAG_NAMES,
  ...BODY_CHANNEL_FLAG_NAMES,
  ...PAGINATION_FLAG_NAMES,
  // A removed name is still claimed: argument parsing intercepts it to report
  // the replacement, so an operation flag that spelled it would be unreachable.
  ...REMOVED_FLAGS.keys(),
]);
