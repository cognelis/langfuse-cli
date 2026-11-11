# Maintenance

## OpenAPI contracts

Builds compile committed OpenAPI snapshots into compact versioned contracts
under ignored `dist/contracts/`. Catalog entries record the exact committed
hash; snapshots with explicit local annotations also record the upstream hash
and modification name. Generated contracts are packaged on npm but are not
committed.

```sh
# Build the Bun CLI and all versioned contracts
bun run build

# Add or refresh an immutable upstream snapshot
bun run conformance:sync -- --version <version>

# Add a stable release snapshot, update metadata, and verify it
bun run conformance:add-version -- v4.11.0
```

## RSI：有界的工具自改进

每轮由编码 Agent 使用 CLI、发现失败、修改工具，再将验证结果作为下一轮的输入。
当前采用人工发起的单轮流程，复用现有测试，不运行后台自修改或自动发布任务。

1. 从脱敏的失败记录或可复现的边界场景提出一个假设，记录版本、输入和预期结果。
2. 在现有测试中加入用例，先确认原实现失败。预期结果来自 CLI 契约，不能为迁就修复而降低断言。
3. 检查共用函数的调用方及同一契约的其他入口（例如 API 请求与版本探测），只修改根因；候选修复还需通过已有用例，不能只通过新增用例。
4. 执行下方测试、类型检查、全部 conformance 和 `release:check`；记录实际跳过的测试和环境限制。
5. 保留通过验证的修复及回归用例，按版本规则收尾。失败时只撤销本轮候选改动；提交和发布仍遵守授权范围。

首轮（2026-11-11）：响应头已收到、响应体随后断流或超时，必须仍属于网络错误（退出码 4）。
`src/client.test.ts` 的两个新增用例在修复前失败、修复后通过；共用客户端将响应体读取纳入同一错误处理。
这些用例验证工具契约，不代表已经测得 Agent 端到端任务成功率的提升。
验证记录：2.4.1 的 195 项测试、6 个 API 版本的 593 项 conformance、类型检查和版本检查全部通过。
HTTP 测试需要本机临时监听端口；沙箱拒绝监听时，应记录环境失败，在允许监听的环境重跑，不能改成跳过。

第二轮（2026-11-11）：把首轮的网络错误契约扩展检查到自动版本探测。
`loader.test.ts` 新增无效 JSON、JSON null、断流、超时四个先失败后通过的用例。
响应体按 unknown 校验，解析和传输失败均返回现有的版本探测退出码 4。
验证记录：2.4.2 的 199 项测试、593 项 conformance、类型检查和版本检查全部通过。

第三轮（2026-11-11）：检查多页结果的完整性。后续页缺少 data 数组时，原实现会
返回已有条目并标记 truncated=false；页码与游标两种反例均先失败后通过。
现在以退出码 4 中止，不将部分条目输出为完整结果；合法分页及原有数量上限保持不变。
同时补齐系统元数据的 gitignore。按用户要求，每轮验证完成后提交代码，推送和发布仍需单独授权。
验证记录：2.4.3 的 201 项测试、593 项 conformance、类型检查和版本检查全部通过。
本机 CLI 已更新为 2.4.3，Codex 与 Claude 的独立 Skills 已核对与源码一致。

第四轮（2026-11-11）：构造相邻重复游标、跨页循环和初始 cursor 被重返三个反例。
原实现均请求到 100 页上限并累积重复数据；现在在再次请求已访问游标前以退出码 4 失败。
复用分页函数，保留 max-items 与 100 页上限；既有终止游标、合法分页和数量截断用例继续验证。
2.4.4 验收：204 项测试、593 项 conformance、类型检查和版本检查全部通过。
本机 CLI 与 Codex/Claude 独立 Skills 已刷新并核验。

方法参考：[Darwin Gödel Machine](https://arxiv.org/abs/2505.22954) 的候选修改与实测验证，
以及 [Agent evals](https://www.anthropic.com/research/demystifying-evals-for-ai-agents) 的失败样本积累与回归检查。

## Testing

The version-pinned black-box suite lives in [`conformance/`](conformance/README.md).
It invokes every operation through the real CLI across historical Langfuse
specs. Active operations make one minimally valid mocked API call; operations
marked `deprecated: true` must fail before any network request.

```sh
bun test
bun run conformance:all
```

`bun test` verifies the generator, schemas, serialization, capture oracle,
deprecation policy, and legacy CLI compatibility. `bun run conformance:all`
builds the package and checks every operation through the native CLI using its
lossless JSON input path. CI runs both.

## Command goldens and overrides

The user-facing command surface (resource, action, aliases, deprecation) of
every snapshot is pinned in reviewed goldens under `conformance/goldens/`.
Tests and the build fail when compiled names differ from the goldens, so a
change to the naming heuristics cannot silently rename commands. After an
intentional naming change, regenerate and review the diff:

```sh
bun run goldens:update
```

All option flags are derived mechanically: query/header parameters and
request-body fields kebab-case their wire names (`objectId` -> `--object-id`),
so new spec versions get flags without per-parameter maintenance. The
compiler validates each operation's full flag namespace (parameters, aliases,
body fields, reserved and global flags) and fails the build when a new
snapshot introduces a collision, instead of silently shipping a dead or
hijacked flag.

Hand-written naming exceptions live in `src/contracts/overrides.json` and are
applied by the contract compiler, never hardcoded in the runtime: extra
parameter flag spellings (`parameterFlagAliases`, e.g. `--prompt-version`),
body-field flag renames for collisions (`bodyFieldFlags`, e.g.
`llmConnections_upsert.secretKey` -> `--provider-secret-key` because
`--secret-key` is a removed name that argument parsing intercepts to report its
replacement), and per-version command overrides.
A snapshot that lacks the referenced parameter or field skips the entry, but
an entry applied in no snapshot at all fails the build, tests, and
`goldens:update`, so stale overrides cannot rot silently.

## Version policy

`package.json`'s `version` is the canonical product version. The three plugin
manifests — `.claude-plugin/marketplace.json` (as `metadata.version`) and both
`plugins/langfuse-cli/.*-plugin/plugin.json` — must carry the same version.

Use plain `MAJOR.MINOR.PATCH`:

| Change | Version increment |
| --- | --- |
| Compatible bug fix, security fix, or bundled Skill correction | Patch |
| New user-visible capability | Minor |
| Incompatible CLI, config, or JSON output change | Major, with migration notes |
| New bundled API snapshot that only adds commands | Minor |
| Internal refactor, tests, or documentation with no shipped behavior change | Record under Unreleased when useful; no standalone release is required |

Choose the highest required increment in a batch, and bump once for the
completed batch rather than for each intermediate edit.

The JSON envelope's `schemaVersion` is a **separate compatibility contract**.
Do not change it just because the product version changes; describe breaking
behavior and the required caller changes in the changelog instead.

## Record changes as you work

Add concise, user-facing entries under `CHANGELOG.md`'s `Unreleased` section
using `Added`, `Changed`, `Fixed`, `Removed`, or `Security`. Include migration
notes whenever commands, authentication, defaults, or output contracts change.
Do not rewrite a published entry to hide a later change.

Keep CLI behavior, README examples, and the bundled Skill at
`plugins/langfuse-cli/skills/langfuse/SKILL.md` in sync. The Skill is copied
into `dist/` at build time and embedded in the compiled executable, so rebuild
before updating installed copies with `skills install`.

## Cutting a version

```sh
bun run release:check
```

It verifies that the version is a plain semver triple, that `private` is
absent, that the name stays under `@cognelis/` with `publishConfig.access` set
to `public`, that all four manifests agree, and that `CHANGELOG.md` records the
version with a date and lists releases newest-first. It rejects duplicates and
out-of-order entries. **It does not commit, tag, push, publish, or install
anything** — that decision stays with a human.

Run the full gates before finalizing:

```sh
bun run typecheck
bun test
bun run conformance:all

# optional: the release build path, exactly as CI runs it for one platform
bun scripts/build-release.ts build --target bun-darwin-arm64
```

## Publishing

The fork publishes as **`@cognelis/langfuse-cli`**. The bare `langfuse-cli` name
belongs to upstream, and `release:check` fails closed if the name ever drifts
back to it, if `private` reappears, or if the scope's default restricted access
is left in place. The binary is `langfuse-cli` either way; the scope only
namespaces the package.

### Releasing

Pushing a `vX.Y.Z` tag releases. Nothing else does.

```sh
# CHANGELOG.md: move Unreleased into a dated section for the new version
# bump the version in all four manifests

bun run release:check
bun run typecheck && bun test && bun run conformance:all

git commit -m "chore: release X.Y.Z"
git push origin main
git tag -a vX.Y.Z -m "vX.Y.Z" && git push origin vX.Y.Z
```

[`release.yml`](.github/workflows/release.yml) then runs four stages, each
gating the next:

| Stage | What it does |
| --- | --- |
| `validate` | Re-runs every gate, and fails unless the tag matches `package.json` and `repository.url` names the repository the workflow is running in |
| `binaries` | Six parallel jobs, one per platform, each building **and starting** its own standalone executable |
| `release` | Re-hashes every artifact, then publishes the GitHub release with the binaries, `checksums.txt`, `LICENSE` and the changelog section |
| `npm` | Verifies the packed tarball and publishes through **npm trusted publishing (OIDC)** |

The tarball check confirms the package carries the CLI, the API contracts and
the Skill — and that it carries none of the standalone executables. No npm
token exists anywhere.

### The standalone executables

[`scripts/build-release.ts`](scripts/build-release.ts) owns both halves of the
binary release.

```sh
# on a runner whose platform matches the target
bun scripts/build-release.ts build --target bun-linux-x64

# on one runner, once all six platform artifacts have been collected
bun scripts/build-release.ts assemble
```

`build` refuses a target the host cannot execute. That is the whole point of the
six-way matrix: after compiling, it starts the binary and checks the reported
version, the `api` command surface, the `_langfuse-cli` completion function
name, the completion callback, and the exit code and empty stdout of a usage
error. It then writes a manifest recording the version, target, size and
SHA-256 beside the executable.

`assemble` re-hashes every binary against the manifest its own runner wrote, so
an artifact left over from a different run or a different version cannot reach
a release. It writes `checksums.txt`, copies `LICENSE`, and renders `notes.md`
from the changelog section for the current version plus install instructions.

Assets are named `langfuse-cli-<os>-<arch>`, using `amd64` rather than `x64`
because that is the spelling people type when downloading. Bun bundles its
runtime, so each is 60–90 MB.

### Re-running a release

If a platform build flakes after the tag is pushed, re-run the workflow from the
Actions tab with **Run workflow**, giving the existing tag. `publish_npm`
defaults to off, because a version can only be published to the registry once;
leave it off unless the `npm` stage is the part that failed. A GitHub release
that is already published keeps its assets — only a draft is filled in and
flipped to published.

### Why publishing is not done locally

The npm account uses passkey 2FA. `npm publish` only falls back to the browser
WebAuthn challenge when it detects a real terminal; from any non-interactive
shell it fails with `EOTP` instead. Automating the release therefore requires
CI, which authenticates with a short-lived OIDC credential rather than a
password or a token.

A local `npm publish` still works from an interactive terminal if CI is
unavailable, but it is the exception, not the path.

### One-time setup on npmjs.com

Trusted publishing has to be configured once per package:

**Package → Settings → Trusted Publisher → GitHub Actions**, with organization
`cognelis`, repository `langfuse-cli`, and workflow filename `release.yml`.
Leave the environment field empty unless a matching environment is added to the
workflow.

### Verifying a release

```sh
npm view @cognelis/langfuse-cli
npm i -g @cognelis/langfuse-cli && langfuse-cli doctor

gh release view vX.Y.Z --repo cognelis/langfuse-cli
```

The standalone executables are release assets, never npm contents: the package
would otherwise carry ~450 MB of binaries that no `npm i -g` install can use.

## 第五轮：doctor 包与 Skill 版本诊断

参考 `/Users/caspian/git/jenkins-cli/internal/app/doctor.go` 的诊断规则：更新查询最多 5 秒，
可显式跳过；加载版本与安装版本分开判断，升级信息不参与连接健康或退出码计算。
新检查追加到原报告末尾，保留原有列与输出 envelope；版本信息来自公开发布元数据和本地 Skill 文件，
不复用业务认证。Skill frontmatter 版本随产品版本更新，并由发布检查防止漂移。

发布时除四个 JSON manifests 外，必须同步 `plugins/langfuse-cli/skills/langfuse/SKILL.md` 的 `version`；build 与 release:check 均校验一致性。

## 提交与贡献者

提交正文、验证记录和 AI 署名遵循 [提交规范](docs/commit-conventions.md)。项目维护者及 AI 协作工具见 [CONTRIBUTORS.md](CONTRIBUTORS.md)。

## 第五轮验收

2.5.0：209 项测试、593 项 API conformance、类型检查及发布检查通过。
包版本查询使用模拟发布响应覆盖更新、离线/错误、超时与响应大小边界；Skill 覆盖缺失、旧版、未知、当前、需重载、项目安装及不可读状态。
贡献者和提交规范一同进入本版本，后续 Author 为 `dnvyrn <dnvyrn@gamil.com>`，AI trailer 只记录实际参与者。

本轮本地安装和 Skill 内容已核验；Rust 两个包的 npm tarball 安装冒烟通过。三个 doctor 的实际表格输出保持原样，维护检查只追加行。

## 第六轮 RSI：请求与结果的相邻边界

原实现接受并保存含 userinfo/query/fragment 的 Host，读取旧配置也绕过校验；无效 URL 异常还回显原文。八个原始失败反例被固定为回归用例，统一校验创建、更新、环境、显式参数及保存的 URL。错误保留配置路径，不显示凭据、不自动修改原文件；记录手动修复旧配置的迁移要求。

第六轮验收：2.5.1：220 项测试、593 项 conformance、类型与发布检查通过；合法反向代理路径和编码分隔符保持可用。 未实测生产服务及其他操作系统。

本轮本地 CLI/Skills 已刷新，124 个安装文件与源码核对一致；两个 Rust 包的安装冒烟通过。按新提交规范记录动机、变更、验证与实际 Codex 署名，不推送或发布。

## 第七轮 RSI：异常结果与诊断恢复

配置加载发生在 doctor 分发之前，导致坏 JSON 或危险 Host 直接退出且不产生报告，config path 也无法使用。限定 doctor 的恢复路径保存配置错误，所有依赖检查跳过，维护检查继续；config path 不读取配置。正常业务命令仍拒绝坏配置，JSON 解析错误不回显原文。验证目标后才进行健康探测，防止无效环境 Host 泄露或触发错误目标探测。

第七轮验收：2.5.2：223 项测试、593 项 conformance、类型与发布检查通过。坏配置恢复测试验证报告在 stdout、exit 3、无服务请求、不回显内容且文件保持原样；config path 可用，普通 config show 仍拒绝坏配置。 未实测生产服务及其他操作系统。

本轮 CLI 与 Skills 已更新，124 个安装文件与源码逐一核对，两个 Rust npm tarball 冒烟通过。Langfuse 安装后的坏配置诊断和路径定位也通过隔离配置验证。按新规范提交，不推送或发布。

## 第八轮 RSI：新能力与 Skill 工作流优化

现有 doctor 能报告版本概览，installer 能比较文件但会执行写入；缺少升级后、刷新前的只读内容检查。
新增 skills status，复用安装目标、文件清单与版本解析，输出文件级差异，不增加依赖。
接受场景包括未安装、相同版本但被修改、引用丢失、不可读路径，以及损坏业务配置下的离线执行。
只检查 CLI 托管的全局 Codex/Claude 安装位置；不扩展任意目录或项目扫描参数。

Skill 增加任务分流：本地维护直接使用离线命令，数据任务继续选环境并运行 doctor；刷新前审阅自定义内容，
刷新后核对并重载上下文。CLI 测试证明工作流可执行，不把这些通过率当作 Agent 任务成功率。

独立二进制原先只注入契约，Skill 路径仍依赖外部文件；本轮同步嵌入 Skill 文本并将安装/状态检查加入发布二进制 smoke，验证离开源码树后仍可使用。

第八轮验收：2.6.0：226 项测试、593 项 API conformance、类型和发布检查通过；macOS arm64 独立二进制在临时工作目录执行 Skill 安装与状态检查通过。 当前未做模型级 Skill 效果评测或其他平台运行验证。

本机验证：刷新前，三个 CLI 的托管安装都被新命令识别为 different；确认没有本地自定义修改后显式刷新，结果全部转为 current。独立校验 124 个文件与源码一致。两个 Rust npm 包的安装冒烟也验证了只读 skills status 入口。

## RSI 与发布批次

按用户确认，日常 RSI 轮次作为 Unreleased 草稿积累：每轮验证、提交，不再逐轮递增版本。
只有用户要求准备正式发布时，再统一整理待发布变更和版本；已发布的标签、版本与历史不改写。
本轮不调用版本 prepare，也不刷新版本化插件缓存。

## 第九轮 RSI：可审阅的业务请求草稿

本轮作为 Unreleased 草稿，不递增版本、不发布。围绕“离线构造/预览 → 审阅 → 选择环境并诊断 → 授权后执行”完善能力，
分别复用现有查询构造器、契约解析/请求序列化器和文档操作解析器，避免另外维护一套执行语义。
预览不读取业务凭据、不发请求，不表示服务端验证或权限已通过；Skill 将计划步骤和实际执行的前置条件分开。

第九轮验收：228 项测试、593 项 API conformance、类型与发布检查通过；最终定向回归 60 项通过。macOS arm64 独立二进制已构建并验证离线 api.plan 与嵌入 Skill 工作流。
本轮未执行全局重装或插件刷新；草稿使用工作区构建试用。未验证生产服务、其他操作系统或模型级 Skill 效果。

## 第十轮 RSI：请求复用与命令发现

新增 api search，直接搜索选定的本地契约，按多个关键词匹配命令、别名、HTTP 路由/方法和描述，返回规范命令及版本/弃用信息。跳过业务配置和凭据，拒绝 auto 探测；Skill 改为先搜索候选、再看命令帮助，按需读取完整 schema，避免默认加载整份清单。

验收：229 项测试、593 项 API conformance、类型和发布检查通过；macOS arm64 独立二进制的新增搜索冒烟通过。覆盖别名去重、跨版本可用性、坏配置、零匹配及不发送网络请求。

本轮新增能力的用例均先在原实现确认失败，再完成实现与验证。保持 Unreleased，不递增版本，不刷新全局安装或插件。通用 Skill 校验器不接受项目既有的 version frontmatter 字段；保留 doctor 需要的字段，并使用仓库的 Skill/发布校验。未验证生产服务、其他操作系统及模型级 Skill 效果。

## 第十一轮 RSI：聚合草稿、按需契约与写入过滤文件

新增 api schema 的资源/操作范围，沿用原 schema 输出结构，保留完整字段、认证、版本和弃用信息；别名返回规范名称，未知参数不再被忽略。补全和 table 帮助按范围显示。Skill 将 search → scoped schema/help → dry-run 串联，按需加载契约。

验收：231 项测试、593 项 API conformance、类型与发布检查通过；macOS arm64 独立二进制的 scoped schema 冒烟通过。覆盖原全量输出、资源与别名操作、参数元数据保留、无效范围及补全。
实测固定 4.16.0 契约、JSON envelope 输出：完整 schema 177417 字节，prompts create 3054 字节，减少 98.3%；这是该操作的输出量对比，不是模型效果评测。

新增行为的回归用例先在原实现确认失败，再通过实现和全量验证。保持 Unreleased，不递增版本、不推送发布、不刷新全局安装或插件。未验证生产服务、其他平台和模型级 Skill 效果。

## 第十二轮 RSI：可靠保存审阅结果与聚合预览（2026-11-12）

新增 dry-run --out-file 保存原始计划对象，并让普通响应文件共用原子替换路径。回归先复现旧实现沿符号链接覆盖目标文件的问题，再验证替换链接自身、私有权限和失败清理。HTTP 失败响应正文仍按既有行为写入文件并返回失败退出码。Skill 明确计划不是请求正文，实际执行应保留原输入并改用其他响应路径，不能覆盖已审阅计划。

验收：233 项测试、593 项 API conformance、类型与发布检查通过；macOS arm64 独立二进制保存计划冒烟通过。覆盖零网络请求、认证省略、无效输入保留原文件、目录目标拒绝及 0600 权限。符号链接和权限迁移说明已写入 README/Unreleased。

新增用例均先在原实现确认失败，再完成实现与验证。保持 Unreleased，不递增版本、不推送发布、不刷新全局安装或插件。未验证生产服务、其他操作系统或模型级 Skill 效果。
