// Guided setup.
//
// Creates or repairs one profile end to end: address, public key, masked secret
// key, verification, credential storage, activation, and the agent skill. It is
// terminal-only and never starts implicitly — if input or output is redirected
// it prints the equivalent non-interactive commands and changes nothing, so a
// script that pipes into the CLI can never be silently reconfigured.
import { DEFAULT_HOST, normalizeHost } from "../config";
import { CliError, EXIT_CONFIG } from "../errors";
import { renderSuccess, writeWarnings } from "../output";
import {
  assertInteractive,
  promptLine,
  promptSecret,
  promptYesNo,
} from "../prompt";
import { checkAuth, checkHealth } from "../verify";
import type { CommandContext } from "./connection";
import { installSkills, type InstallResult } from "./skills";

const DEFAULT_PROFILE = "default";

export async function init(context: CommandContext): Promise<void> {
  const name = context.profileFlag ?? DEFAULT_PROFILE;
  assertInteractive([
    `langfuse-cli profile add ${name} --host <url> --public-key <pk>`,
    `printf '%s' "$LANGFUSE_SECRET_KEY" | langfuse-cli auth login --profile ${name} --secret-key-stdin`,
    "langfuse-cli skills install",
  ]);

  const existing = context.config.profile(name);
  process.stdout.write(
    existing
      ? `Updating profile '${name}'.\n`
      : `Creating profile '${name}'.\n`,
  );

  const host = normalizeHost(
    await promptLine("Langfuse host", existing?.host ?? DEFAULT_HOST),
  );

  // Reachability is checked before any key is requested: a typo in the address
  // should not be discovered after the user has typed a secret.
  const health = await checkHealth(host, context.timeoutMs);
  if (!health.ok) {
    throw new CliError(
      `${health.message}\nNothing was changed. Check the address and run \`langfuse-cli init\` again.`,
      EXIT_CONFIG,
    );
  }
  process.stdout.write(`  ${health.message}\n`);

  const publicKey = await promptLine("Public key", existing?.publicKey);
  if (!publicKey) {
    throw new CliError("A public key is required", EXIT_CONFIG);
  }
  const secretKey = await promptSecret("Secret key");
  if (!secretKey) {
    throw new CliError("A secret key is required", EXIT_CONFIG);
  }

  const auth = await checkAuth(host, publicKey, secretKey, context.timeoutMs);
  if (!auth.ok) {
    throw new CliError(
      `${auth.message}\nNothing was changed.`,
      EXIT_CONFIG,
    );
  }
  process.stdout.write(`  ${auth.message}\n`);

  if (existing) {
    context.config.updateProfile(name, { host, publicKey });
  } else {
    context.config.addProfile(name, host, publicKey);
  }
  await context.store.set(name, secretKey);
  context.config.useProfile(name);
  await context.config.save();

  const warnings: string[] = [];
  if (!context.store.systemBacked) {
    warnings.push(
      `no system credential store was available; the secret key is in ${context.store.description}`,
    );
  }

  let skills: InstallResult[] = [];
  if (await promptYesNo("Install the Langfuse agent skill?", true)) {
    skills = await installSkills("all");
  }

  if (context.outputMode === "table") {
    process.stdout.write(
      `\nProfile '${name}' is active. Try: langfuse-cli doctor\n`,
    );
    writeWarnings(warnings);
  } else {
    process.stdout.write(
      renderSuccess(
        context.outputMode,
        "init",
        {
          profile: name,
          host,
          store: context.store.id,
          verified: true,
          skills,
        },
        { profile: name, host, warnings },
      ),
    );
  }
}
