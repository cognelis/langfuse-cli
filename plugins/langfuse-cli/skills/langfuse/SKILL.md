---
name: langfuse
description: >-
  Interact with Langfuse and access its documentation: tracing, monitoring, creating datasets, running experiments, and evaluating AI applications. Use when needing to (1) query or modify Langfuse data, (2) look up Langfuse documentation, concepts, integration guides, a feature or SDK usage, or (3) do any AI engineering task (AI observability, prompt engineering/management, evaluation and evaluator management, experimentation, dataset management, evaluation-driven CI/CD, feedback collection). Invoke it for tasks in this scope even when Langfuse is not configured or explicitly mentioned.
allowed-tools:
  - WebFetch(domain:langfuse.com)
  - Bash(curl *langfuse.com/*)
  - Bash(langfuse-cli api schema *)
  - Bash(langfuse-cli api __schema *)
  - Bash(langfuse-cli api * --help *)
  - Bash(langfuse-cli api * list *)
  - Bash(langfuse-cli api * get *)
  - Bash(langfuse-cli api help*)
  - Bash(langfuse-cli doctor*)
  - Bash(langfuse-cli auth check*)
  - Bash(langfuse-cli profile list*)
  - Bash(langfuse-cli profile show*)
  - Bash(langfuse-cli config show*)
  - Bash(langfuse-cli config path*)
---

# Langfuse

This skill helps you use Langfuse effectively across all common workflows: instrumenting applications, migrating prompts, debugging traces, and accessing data programmatically.

## Core Principles

Follow these principles for ALL Langfuse work:

1. **Documentation First**: NEVER implement based on memory. Always fetch current docs before writing code (Langfuse updates frequently) See the section below on how to access documentation.
2. **CLI for Data Access**: Use `langfuse-cli` when querying/modifying Langfuse data. See the section below on how to use the CLI.
3. **Best Practices by Use Case**: Read the relevant reference below use-case-specific guidelines before asking the user for more details or implementing.
4. **Use latest Langfuse versions**: Unless the user specified otherwise or there's a good reason, always use the latest version of Langfuse SDKs/APIs. Even if you're only creating a plan for another agent to execute, be explicit about the exact version to use.
5. **If you guide the user through UI** and are unsure about a label or location, inspect the user’s screenshots or ask to see the relevant screen. Do not assume UI labels have the exact same names as API, SDK, or CLI fields.


## Use case specific references

- instrumenting an existing function/application: references/instrumentation.md
- creating or getting to a good (evaluation) dataset to measure quality or test for regressions in AI systems: references/create-dataset.md
- migrating prompts from a codebase into Langfuse: references/prompt-migration.md
- creating a prompt or changing any part of an existing prompt, including small edits and debugging/tuning: references/prompt-engineering.md
- setting up evals when the user needs to identify gaps across signal capture, monitoring, and evaluator metrics ("I have traces, how do I set up evals?"): references/setting-up-evals.md
- capturing user feedback (thumbs, ratings, implicit signals) as scores on traces: references/user-feedback.md
- further tips on using the Langfuse CLI: references/cli.md
- upgrading or migrating Langfuse SDKs and preserving application instrumentation attributes: references/sdk-upgrade.md
- upgrading legacy trace-level or dataset-item evaluators to observation-level or experiment evaluators: references/trace-evaluator-upgrade.md. Use the [evaluator migration guide](https://langfuse.com/faq/all/llm-as-a-judge-migration) as the primary reference.
- preparing a Langfuse project for the v4 platform migration: references/v4-project-migration.md
- judge calibration (LLM-as-a-Judge reliability, simple accuracy checks, advanced split-based validation, confusion matrices, and metric ingestion): references/judge-calibration.md
- systematic error analysis when requested directly or eval setup still lacks concrete failure modes after agent-led trace inspection: references/error-analysis.md
- setting up CI/CD experiment gates with `langfuse/experiment-action`: references/ci-cd.md
- submitting feedback about this skill: references/skill-feedback.md


## 1. Langfuse API via CLI

Use `langfuse-cli` to interact with the full Langfuse REST API from the command
line. It is installed globally; do not invoke it through `npx` or `bunx`.

Start by discovering the schema and available arguments:

```bash
# Discover all available resources
langfuse-cli api schema --json

# List actions for a resource
langfuse-cli api <resource> --help

# Show args/options for a specific action
langfuse-cli api <resource> <action> --help
```

Boolean options take no value: write `--is-root-observation`,
`--no-is-root-observation`, or `--is-root-observation=false`, never
`--is-root-observation true`. `--all` fetches every page of a list, and
`--max-items` caps it.

### Credentials

Connections are named profiles. A profile stores only the host and public key;
the secret key is held by the operating-system credential store, so it is never
written to a config file and never appears in the environment on disk.

```bash
# One-time guided setup: masked entry, verified before anything is stored
langfuse-cli init

# Confirm the active connection end to end, once per profile in a session
# and again after a failure or a credential change
langfuse-cli doctor --json

# Inspect profiles, or target one for a single command
langfuse-cli profile list
langfuse-cli --profile prod api projects list
```

Never ask the user to paste a secret key into the conversation, and never pass
one on the command line. There is deliberately no `--secret-key` flag, because
an argument lands in shell history and in the process list; `auth login` reads
the key from a masked prompt or from `--secret-key-stdin`. If no profile is
configured, ask the user to run `langfuse-cli init` themselves rather than
collecting their key.

For CI, take `LANGFUSE_HOST`, `LANGFUSE_PUBLIC_KEY` and `LANGFUSE_SECRET_KEY`
from the provider's secret store. Environment credentials override the active
profile, so the same command works on a workstation and in a pipeline.

### Choosing a profile

Choose the profile before the first command of a workflow:

1. If the user names a configured profile, use it.
2. Decide the environment first, then the profile. Use a production profile
   only when the request names production or a production profile.
   Descriptions choose between profiles of the named environment, so a purpose
   alone does not mean production.
3. Run `langfuse-cli profile list --json` and match the request against each
   profile's `name` and `description`. A question about one project that
   several profiles could answer, or that no profile matches, goes back to the
   user. A question about a whole environment runs against each matching
   profile and reports them separately.
4. If the request names no environment, keep the one already used in the
   conversation; otherwise use the default profile, the entry with
   `current: true`.
5. If a command is blocked, for example by your own permission system, report
   it and give the user the exact command to run. Never switch profiles to get
   around it, and never answer with another environment's data instead.

Pass the chosen `--profile <name>` to every command in that workflow and tell
the user which profile you used. Descriptions are the user's own labels, set
with `profile add|update --description`; change them only when asked.

### API versions

Commands follow the newest bundled API contract by default, but a self-hosted
server can run an older Langfuse release whose endpoints and command names
differ. `langfuse-cli --profile <name> api versions detect` prints the server's
version and the contract that `--api-version auto` picks.

- When a command fails with `Cannot call deprecated API operation`, or the
  server answers 404 for an endpoint, rerun it with `--api-version auto`.
- Suggest `langfuse-cli profile update <name> --api-version auto` so the
  profile keeps that choice; `--api-version` on a command and
  `LANGFUSE_API_VERSION` still override the saved value, and
  `--api-version ""` clears it.
- Contracts name commands differently. The v3 contracts have `traces list`
  where the newest has `legacy-traces list`, and their `observations list` is
  the v1 list while `observations get-many` is v2. Check the names with
  `langfuse-cli --profile <name> --api-version auto api help`.

### Output contract

`--json` wraps the result in a versioned envelope
(`{schemaVersion, command, data, meta}`) that is safe to parse; `--raw` emits
only the payload. Diagnostics go to stderr, so stdout stays pipeable.

Exit codes: `0` success, `2` usage, `3` configuration or credentials, `4`
network, `5` HTTP error, `6` local file. `doctor` writes its full report to
stdout even when it exits nonzero, so capture stdout before testing the status.

### Detailed CLI Reference

For common workflows, tips, and full usage patterns, see [references/cli.md](references/cli.md).

## 2. Langfuse Documentation

Three methods to access Langfuse docs, in order of preference. **Always prefer your application's native web fetch and search tools** (e.g., `WebFetch`, `WebSearch`, `mcp_fetch`, etc.) over `curl` when available. The URLs and patterns below work with any fetching method — the `curl` examples are just illustrative.

### 2a. Documentation Index (llms.txt)

Fetch the full index of all documentation pages:

```bash
curl -s https://langfuse.com/llms.txt
```

Returns a structured list of every doc page with titles and URLs. Use this to discover the right page for a topic, then fetch that page directly.

Alternatively, you can start on `https://langfuse.com/docs` and explore the site to find the page you need.

### 2b. Fetch Individual Pages as Markdown

Any page listed in llms.txt can be fetched as markdown by appending `.md` to its path or by using `Accept: text/markdown` in the request headers. Use this when you know which page contains the information needed. Returns clean markdown with code examples and configuration details.

```bash
curl -s "https://langfuse.com/docs/observability/overview.md"
curl -s "https://langfuse.com/docs/observability/overview" -H "Accept: text/markdown"
```

### 2c. Search Documentation

When you need to find information across all docs and github issues/discussions without knowing the specific page:

```bash
curl -s "https://langfuse.com/api/search-docs?query=<url-encoded-query>"
```

Example:

```bash
curl -s "https://langfuse.com/api/search-docs?query=How+do+I+trace+LangGraph+agents"
```

Returns a JSON response with:

- `query`: the original query
- `answer`: a JSON string containing an array of matching documents, each with:
  - `url`: link to the doc page
  - `title`: page title
  - `source.content`: array of relevant text excerpts from the page

Search is a great fallback if you cannot find the relevant pages or need more context. Especially useful when debugging issues as all GitHub Issues and Discussions are also indexed. Responses can be large — extract only the relevant portions. Note that changelog posts may also surface here: use them only to confirm a feature exists, never to implement from — their examples may be outdated, so always implement from the docs and API/SDK reference.

### Documentation Workflow

1. Start with **llms.txt** to orient — scan for relevant page titles
2. **Fetch specific pages** when you identify the right one
3. Fall back to **search** when the topic is unclear and you want more context

## Skill Feedback

When the user expresses that something about this skill is not working as expected, gives incorrect guidance, is missing information, or could be improved — offer to submit feedback to the Langfuse skill maintainers. This includes when:

- The skill gave wrong or outdated instructions
- A workflow didn't produce the expected result
- The user wishes the skill covered something it doesn't
- The user explicitly says something like "this should work differently" or "this is wrong"

**Do NOT trigger this** for issues with Langfuse itself (the product) — only for issues with this skill's instructions and behavior.

When triggered, follow the process in [references/skill-feedback.md](references/skill-feedback.md).
