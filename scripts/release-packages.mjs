import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, timingSafeEqual } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE = {
  directory: "agent-access",
  name: "@pegma/agent-access",
};
const REPOSITORY_URL = "git+https://github.com/pegma-dev/agent-access.git";
const RUNTIME_DEPENDENCIES = {
  "@pegma/audit": "0.2.0",
  "@pegma/authorization-core": "0.4.0",
  "@pegma/spine": "0.1.2",
  "@pegma/storage-core": "0.4.0",
};
const REVIEWED_PNPM_VERSION = "10.34.5";
const STABLE_SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;

export const RELEASE_PACKAGES = [PACKAGE];

function fail(message) {
  throw new Error(message);
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

function safeEqual(left, right) {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return (
    leftBytes.length === rightBytes.length &&
    timingSafeEqual(leftBytes, rightBytes)
  );
}

function run(command, arguments_, options = {}) {
  const result = spawnSync(command, arguments_, {
    cwd: options.cwd,
    encoding: "utf8",
    env: options.env ?? process.env,
    shell: options.shell ?? false,
    stdio: options.capture ? "pipe" : "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0 && !options.allowFailure) {
    const detail = [result.stdout, result.stderr].filter(Boolean).join("\n");
    fail(
      `${command} ${arguments_.join(" ")} failed with exit code ${String(result.status)}${detail ? `:\n${detail}` : ""}`,
    );
  }
  return result;
}

function runNpm(arguments_, options = {}) {
  // Invoke npm's JavaScript entrypoint directly, including on Windows. Never
  // interpret arguments through a shell or mistake pnpm's npm_execpath for npm.
  const directories = [
    dirname(process.execPath),
    ...(process.env.PATH ?? "").split(delimiter).filter(Boolean),
  ];
  const candidates = directories.map((directory) =>
    join(directory, "node_modules", "npm", "bin", "npm-cli.js"),
  );
  if (basename(process.env.npm_execpath ?? "") === "npm-cli.js") {
    candidates.unshift(process.env.npm_execpath);
  }
  for (const directory of directories) {
    const executable = join(directory, "npm");
    if (existsSync(executable)) {
      const target = realpathSync(executable);
      if (basename(target) === "npm-cli.js") candidates.push(target);
    }
  }
  const npm = candidates.find((candidate) => existsSync(candidate));
  if (npm === undefined)
    fail("Cannot locate npm-cli.js beside Node.js or on PATH.");
  return run(process.execPath, [npm, ...arguments_], options);
}

function gitCommand() {
  return process.platform === "win32" ? "git.exe" : "git";
}

function hashTarball(bytes) {
  return {
    shasum: createHash("sha1").update(bytes).digest("hex"),
    integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
  };
}

function pnpmLockfileHasImporter(lockfile, importer) {
  let inImporters = false;
  for (const line of lockfile.split("\n")) {
    if (!inImporters) {
      if (line === "importers:") inImporters = true;
      continue;
    }
    if (line.length > 0 && !line.startsWith(" ") && !line.startsWith("\t")) {
      return false;
    }
    if (
      line.startsWith(`  ${importer}:`) ||
      line.startsWith(`  "${importer}":`)
    ) {
      return true;
    }
  }
  return false;
}

function exportTargets(value) {
  if (typeof value === "string") return [value];
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return Object.values(value).flatMap(exportTargets);
  }
  return [];
}

export function validateReleaseTag(options = {}) {
  const root = resolve(options.root ?? defaultRoot());
  const releaseTag = options.releaseTag ?? process.env.RELEASE_TAG;
  const expectedReleaseCommit =
    options.expectedReleaseCommit ?? process.env.RELEASE_COMMIT;
  if (releaseTag === undefined || !/^v\d+\.\d+\.\d+$/u.test(releaseTag)) {
    fail("a stable release tag is required");
  }
  if (
    expectedReleaseCommit === undefined ||
    !/^[0-9a-f]{40,64}$/u.test(expectedReleaseCommit)
  ) {
    fail("an exact release event commit is required");
  }

  const tagRef = `refs/tags/${releaseTag}`;
  const type = run(gitCommand(), ["cat-file", "-t", tagRef], {
    cwd: root,
    capture: true,
    allowFailure: true,
  });
  if (type.status !== 0 || type.stdout.trim() !== "tag") {
    fail("the release ref must be an annotated tag object");
  }
  const headCommit = run(gitCommand(), ["rev-parse", "HEAD"], {
    cwd: root,
    capture: true,
  }).stdout.trim();
  const tagCommit = run(gitCommand(), ["rev-parse", `${tagRef}^{commit}`], {
    cwd: root,
    capture: true,
  }).stdout.trim();
  if (
    !safeEqual(headCommit, tagCommit) ||
    !safeEqual(headCommit, expectedReleaseCommit)
  ) {
    fail(
      "the release checkout, signed tag target, and release event commit must match",
    );
  }
  const signature = run(gitCommand(), ["verify-tag", "--raw", tagRef], {
    cwd: root,
    capture: true,
    allowFailure: true,
  });
  if (signature.status !== 0) {
    fail("the release tag signature is not valid for an approved signer");
  }
  const onMain = run(
    gitCommand(),
    ["merge-base", "--is-ancestor", tagCommit, "refs/remotes/origin/main"],
    { cwd: root, capture: true, allowFailure: true },
  );
  if (onMain.status !== 0) {
    fail("the release tag commit must be contained in origin/main");
  }
  return { headCommit, releaseTag };
}

export async function validateRepository(options = {}) {
  const root = resolve(options.root ?? defaultRoot());
  const rootManifest = await readJson(join(root, "package.json"));
  const packageDirectory = join(root, "packages", PACKAGE.directory);
  const manifest = await readJson(join(packageDirectory, "package.json"));
  const lockfile = await readFile(join(root, "pnpm-lock.yaml"), "utf8");
  const lockImporter = `packages/${PACKAGE.directory}`;

  if (
    rootManifest.private !== true ||
    rootManifest.packageManager !== `pnpm@${REVIEWED_PNPM_VERSION}` ||
    rootManifest.engines?.node !== ">=22.6.0"
  ) {
    fail(`the private root must pin pnpm@${REVIEWED_PNPM_VERSION}`);
  }
  if (
    manifest.name !== PACKAGE.name ||
    !STABLE_SEMVER.test(manifest.version) ||
    manifest.private === true ||
    manifest.license !== "MIT" ||
    manifest.type !== "module" ||
    manifest.publishConfig?.access !== "public" ||
    manifest.engines?.node !== ">=22" ||
    manifest.repository?.type !== "git" ||
    manifest.repository?.url !== REPOSITORY_URL ||
    manifest.repository?.directory !== `packages/${PACKAGE.directory}`
  ) {
    fail(`${PACKAGE.name} has invalid public package metadata`);
  }
  assert.deepEqual(manifest.dependencies, RUNTIME_DEPENDENCIES);
  for (const kind of [
    "peerDependencies",
    "optionalDependencies",
    "bundledDependencies",
  ]) {
    assert.equal(
      manifest[kind],
      undefined,
      `${PACKAGE.name} must use only the reviewed runtime dependencies.`,
    );
  }
  if (
    !Array.isArray(manifest.files) ||
    manifest.files.length === 0 ||
    manifest.files.some((entry) => !entry.startsWith("dist/")) ||
    typeof manifest.scripts?.prepack !== "string" ||
    !manifest.scripts.prepack.includes("build")
  ) {
    fail(`${PACKAGE.name} has an unsafe package allowlist or prepack`);
  }
  assert.deepEqual(manifest.exports, {
    ".": { types: "./dist/index.d.ts", import: "./dist/index.js" },
  });
  const targets = exportTargets(manifest.exports);
  if (
    targets.length === 0 ||
    targets.some(
      (target) =>
        typeof target !== "string" ||
        !target.startsWith("./dist/") ||
        target.includes(".."),
    )
  ) {
    fail(`${PACKAGE.name} exports must point into dist`);
  }
  for (const document of ["README.md", "LICENSE"]) {
    const content = await readFile(join(packageDirectory, document), "utf8");
    assert.ok(
      content.trim().length > 0,
      `${PACKAGE.name} requires its own ${document}.`,
    );
    if (document === "LICENSE") assert.match(content, /MIT License/u);
  }
  const configuration = await readJson(join(packageDirectory, "tsconfig.json"));
  assert.ok(
    configuration.exclude?.includes("src/**/*.test.ts"),
    "Compiled tests must be excluded.",
  );
  if (!pnpmLockfileHasImporter(lockfile, lockImporter)) {
    fail(`${PACKAGE.name} is not synchronized with pnpm-lock.yaml`);
  }

  const publicWorkspaces = [];
  for (const entry of await readdir(join(root, "packages"), {
    withFileTypes: true,
  })) {
    if (!entry.isDirectory()) continue;
    try {
      const workspace = await readJson(
        join(root, "packages", entry.name, "package.json"),
      );
      if (workspace.private !== true) publicWorkspaces.push(workspace.name);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  if (publicWorkspaces.length !== 1 || publicWorkspaces[0] !== PACKAGE.name) {
    fail("public workspace inventory does not match the reviewed release list");
  }

  if (options.requireClean) {
    const status = run(gitCommand(), ["status", "--porcelain"], {
      cwd: root,
      capture: true,
    }).stdout;
    if (status.trim() !== "")
      fail("release preparation requires a clean checkout");
  }
  if (options.requireMainAncestor) {
    const head = run(gitCommand(), ["rev-parse", "HEAD"], {
      cwd: root,
      capture: true,
    }).stdout.trim();
    const onMain = run(
      gitCommand(),
      ["merge-base", "--is-ancestor", head, "refs/remotes/origin/main"],
      { cwd: root, capture: true, allowFailure: true },
    );
    if (onMain.status !== 0) {
      fail("release commit must be contained in origin/main");
    }
  }

  const releaseTag = options.releaseTag ?? process.env.RELEASE_TAG;
  if (releaseTag !== undefined && releaseTag !== `v${manifest.version}`) {
    fail(`release tag must be v${manifest.version}`);
  }
  const prerelease =
    options.releasePrerelease ?? process.env.RELEASE_PRERELEASE ?? false;
  if (prerelease === true || prerelease === "true") {
    fail("prereleases cannot publish packages");
  }
  if (options.requireReleaseTag) {
    validateReleaseTag({
      root,
      releaseTag,
      expectedReleaseCommit: options.expectedReleaseCommit,
    });
  }
  return { root, manifest, packageDirectory, releaseTag };
}

function verifyPackedFiles(manifest, files) {
  const paths = files.map(({ path }) => path);
  for (const required of ["package.json", "README.md", "LICENSE"]) {
    if (!paths.includes(required))
      fail(`${manifest.name} is missing ${required}`);
  }
  if (
    paths.some(
      (path) =>
        !["package.json", "README.md", "LICENSE"].includes(path) &&
        (!/^dist\/[A-Za-z0-9_./-]+\.(?:js|js\.map|d\.ts|d\.ts\.map)$/u.test(
          path,
        ) ||
          path.split("/").some((part) => part === "." || part === "..") ||
          /\.(?:test|spec)\./u.test(path)),
    )
  ) {
    fail(`${manifest.name} tarball contains an unreviewed file`);
  }
  for (const target of exportTargets(manifest.exports)) {
    const path = target.replace(/^\.\//u, "");
    if (!paths.includes(path)) fail(`${manifest.name} is missing ${path}`);
  }
}

async function smokeTestTarball(tarball, manifest) {
  const temporaryParent = realpathSync(tmpdir());
  const directory = await mkdtemp(
    join(temporaryParent, "agent-access-release-smoke-"),
  );
  try {
    await writeFile(
      join(directory, "package.json"),
      '{"name":"agent-access-release-smoke","private":true,"type":"module"}\n',
    );
    const npmrc = join(directory, "npmrc");
    await writeFile(npmrc, "registry=https://registry.npmjs.org/\n");
    const env = {
      ...process.env,
      npm_config_userconfig: npmrc,
      npm_config_registry: "https://registry.npmjs.org/",
    };
    runNpm(
      [
        "install",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "--package-lock=false",
        tarball,
      ],
      { cwd: directory, capture: true, env },
    );
    const consumerSource = join(directory, "consumer.mts");
    await writeFile(
      consumerSource,
      `
import {
  createAgentAccess,
  type AgentAccessOptions,
  type AgentAccessServicePort,
  type ApprovalResult,
  type BrowserApprovalContext,
} from "@pegma/agent-access";
declare const options: AgentAccessOptions;
declare const browser: BrowserApprovalContext;
const service: AgentAccessServicePort = createAgentAccess(options);
const decision: Promise<ApprovalResult> = service.approve(browser, {
  requestId: "fictional-artifact-request",
  decision: "deny",
});
void decision;
`,
    );
    run(
      process.execPath,
      [
        join(defaultRoot(), "node_modules", "typescript", "bin", "tsc"),
        "--strict",
        "--exactOptionalPropertyTypes",
        "--noUncheckedIndexedAccess",
        "--noEmit",
        "--target",
        "ES2022",
        "--module",
        "NodeNext",
        "--moduleResolution",
        "NodeNext",
        "--skipLibCheck",
        consumerSource,
      ],
      { cwd: directory, capture: true, env },
    );
    for (const key of Object.keys(manifest.exports)) {
      const specifier =
        key === "." ? manifest.name : `${manifest.name}${key.slice(1)}`;
      run(
        process.execPath,
        [
          "--input-type=module",
          "--eval",
          `
import assert from "node:assert/strict";
import { createMemoryStore } from "@pegma/storage-core";
const api = await import(${JSON.stringify(specifier)});
assert.deepEqual(Object.keys(api).sort(), [
  "DEFAULT_APPROVAL_PERMISSION", "DEFAULT_LIMITS", "OAuthError",
  "createAgentAccess", "createAgentAccessHttp", "createProtectedResourceAuthenticator",
].sort());
for (const name of ["createAgentAccess", "createAgentAccessHttp", "createProtectedResourceAuthenticator", "OAuthError"]) {
  assert.equal(typeof api[name], "function");
}
assert.equal(api.DEFAULT_APPROVAL_PERMISSION, "agent.access.link");
assert.ok(Object.isFrozen(api.DEFAULT_LIMITS));
await assert.rejects(import("@pegma/agent-access/dist/service.js"), {
  code: "ERR_PACKAGE_PATH_NOT_EXPORTED",
});
const service = api.createAgentAccess({
  store: createMemoryStore(),
  clock: { now: () => "2026-11-01T00:00:00.000Z" },
  resolvePrincipal: async () => null,
  configuration: {
    issuer: "https://agent-access.example.test",
    resource: "https://resource.example.test/mcp",
    approvalPermission: api.DEFAULT_APPROVAL_PERMISSION,
    endpoints: {
      authorize: "https://agent-access.example.test/oauth/authorize",
      deviceAuthorization: "https://agent-access.example.test/oauth/device",
      token: "https://agent-access.example.test/oauth/token",
      revocation: "https://agent-access.example.test/oauth/revoke",
      verification: "https://agent-access.example.test/oauth/verify",
      approval: "https://agent-access.example.test/oauth/approve",
      resourceMetadata: "https://agent-access.example.test/.well-known/oauth-protected-resource",
    },
    clients: [{
      clientId: "artifact-smoke", name: "Fictional artifact client",
      redirectUris: [], allowedScopes: ["knowledge.read"], grantTypes: ["device_code"],
    }],
    scopes: [{ name: "knowledge.read", description: "Read fictional public knowledge", version: "1", permissions: ["knowledge.read"] }],
  },
});
const pending = await service.beginDeviceAuthorization({
  clientId: "artifact-smoke", resource: "https://resource.example.test/mcp", scopes: ["knowledge.read"],
});
assert.equal(typeof pending.device_code, "string");
assert.equal(typeof pending.user_code, "string");
assert.ok(pending.expires_in > 0);
await assert.rejects(service.pollDeviceToken({
  clientId: "artifact-smoke", resource: "https://resource.example.test/mcp", deviceCode: pending.device_code,
}), (error) => error instanceof api.OAuthError && error.code === "authorization_pending");
await assert.rejects(service.authenticate({
  token: "fictional-invalid-bearer", resource: "https://resource.example.test/mcp",
}), (error) => error instanceof api.OAuthError && error.code === "invalid_token");
`,
        ],
        { cwd: directory, capture: true, env },
      );
    }
  } finally {
    const cleanup = realpathSync(directory);
    assert.equal(dirname(cleanup), temporaryParent);
    assert.ok(basename(cleanup).startsWith("agent-access-release-smoke-"));
    await rm(cleanup, { recursive: true, force: true });
  }
}

export async function prepareRelease(options = {}) {
  const { root, manifest, packageDirectory, releaseTag } =
    await validateRepository(options);
  const gitCommit = run(gitCommand(), ["rev-parse", "HEAD"], {
    cwd: root,
    capture: true,
  }).stdout.trim();
  const output = resolve(root, options.output ?? ".release");
  await mkdir(output, { recursive: true });
  if ((await readdir(output)).length !== 0) {
    fail(`release output directory must be empty: ${output}`);
  }

  runNpm(["run", "build"], { cwd: root });
  const result = runNpm(
    ["pack", packageDirectory, "--json", "--pack-destination", output],
    { cwd: root, capture: true },
  );
  const [packed] = JSON.parse(result.stdout);
  if (
    packed?.name !== manifest.name ||
    packed?.version !== manifest.version ||
    typeof packed.filename !== "string" ||
    !Array.isArray(packed.files)
  ) {
    fail("npm pack returned invalid metadata");
  }
  verifyPackedFiles(manifest, packed.files);
  const tarballPath = join(output, basename(packed.filename));
  const hashes = hashTarball(await readFile(tarballPath));
  if (
    !safeEqual(hashes.integrity, packed.integrity) ||
    !safeEqual(hashes.shasum, packed.shasum)
  ) {
    fail("tarball hashes do not match npm pack metadata");
  }
  await smokeTestTarball(tarballPath, manifest);

  const prepared = {
    schemaVersion: 1,
    gitCommit,
    releaseTag: releaseTag ?? null,
    package: {
      name: manifest.name,
      version: manifest.version,
      tarball: basename(tarballPath),
      integrity: hashes.integrity,
      shasum: hashes.shasum,
      files: packed.files
        .map(({ path, size }) => ({ path, size }))
        .sort((left, right) => left.path.localeCompare(right.path)),
    },
  };
  const manifestPath = join(output, "package-manifest.json");
  await writeFile(manifestPath, `${JSON.stringify(prepared, null, 2)}\n`);
  return { manifestPath, manifest: prepared };
}

function queryRegistryIntegrity(name, version) {
  const spec = `${name}@${version}`;
  const result = runNpm(["view", spec, "dist.integrity", "--json"], {
    capture: true,
    allowFailure: true,
  });
  if (result.status === 0) {
    const integrity = JSON.parse(result.stdout);
    if (typeof integrity !== "string" || integrity.length === 0) {
      fail(`${spec} exists without dist.integrity`);
    }
    return integrity;
  }
  const output = `${result.stdout}\n${result.stderr}`;
  if (/\bE404\b/u.test(output)) return null;
  fail(`npm registry lookup failed for ${spec}:\n${output.trim()}`);
}

export function decidePublication(localIntegrity, registryIntegrity) {
  if (registryIntegrity === null) return "publish";
  if (safeEqual(localIntegrity, registryIntegrity)) return "skip";
  fail("the registry version exists with different tarball integrity");
}

function requireTrustedPublishingNpm() {
  const version = runNpm(["--version"], { capture: true }).stdout.trim();
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-.+)?$/u.exec(version);
  if (match === null) fail(`could not parse npm version ${version}`);
  const [major, minor, patch] = match.slice(1).map(Number);
  if (
    major < 11 ||
    (major === 11 && minor < 5) ||
    (major === 11 && minor === 5 && patch < 1)
  ) {
    fail("trusted publishing requires npm 11.5.1 or newer");
  }
}

function wait(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function confirmRegistryIntegrity(record) {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const integrity = queryRegistryIntegrity(record.name, record.version);
    if (integrity !== null && safeEqual(record.integrity, integrity)) return;
    if (attempt < 5) wait(2 ** attempt * 1000);
  }
  fail(
    `${record.name}@${record.version} did not expose the prepared integrity`,
  );
}

async function verifyPreparedManifest(path) {
  const prepared = await readJson(path);
  const record = prepared.package;
  if (
    prepared.schemaVersion !== 1 ||
    !/^[0-9a-f]{40,64}$/u.test(prepared.gitCommit) ||
    prepared.releaseTag !== `v${record?.version}` ||
    record?.name !== PACKAGE.name ||
    !STABLE_SEMVER.test(record.version) ||
    typeof record.integrity !== "string" ||
    typeof record.shasum !== "string" ||
    !Array.isArray(record.files)
  ) {
    fail("prepared package manifest is invalid");
  }
  const currentCommit = run(gitCommand(), ["rev-parse", "HEAD"], {
    cwd: defaultRoot(),
    capture: true,
  }).stdout.trim();
  if (!safeEqual(currentCommit, prepared.gitCommit)) {
    fail("prepared package manifest commit does not match the checkout");
  }
  const expectedTarball = `${PACKAGE.name
    .slice(1)
    .replace("/", "-")}-${record.version}.tgz`;
  if (record.tarball !== expectedTarball)
    fail("prepared tarball name is invalid");
  const tarball = resolve(dirname(path), record.tarball);
  if (dirname(tarball) !== resolve(dirname(path))) {
    fail("prepared tarball must be beside the package manifest");
  }
  const hashes = hashTarball(await readFile(tarball));
  if (
    !safeEqual(hashes.integrity, record.integrity) ||
    !safeEqual(hashes.shasum, record.shasum)
  ) {
    fail("prepared tarball has changed");
  }
  return prepared;
}

export async function publishPreparedRelease(options = {}) {
  if (
    process.env.GITHUB_ACTIONS !== "true" ||
    process.env.GITHUB_EVENT_NAME !== "release"
  ) {
    fail("release:publish is restricted to a GitHub release workflow");
  }
  requireTrustedPublishingNpm();
  const path = resolve(options.manifest ?? ".release/package-manifest.json");
  const prepared = await verifyPreparedManifest(path);
  const releaseTag = options.releaseTag ?? process.env.RELEASE_TAG;
  const expectedCommit =
    options.expectedReleaseCommit ?? process.env.RELEASE_COMMIT;
  if (releaseTag !== prepared.releaseTag) {
    fail("prepared manifest must match the release tag");
  }
  if (
    expectedCommit === undefined ||
    !/^[0-9a-f]{40,64}$/u.test(expectedCommit) ||
    !safeEqual(expectedCommit, prepared.gitCommit)
  ) {
    fail("prepared package manifest must match the release event commit");
  }

  const record = prepared.package;
  const decision = decidePublication(
    record.integrity,
    queryRegistryIntegrity(record.name, record.version),
  );
  if (decision === "skip") {
    process.stdout.write(
      `Verified existing ${record.name}@${record.version}; skipping.\n`,
    );
    return;
  }
  runNpm(
    [
      "publish",
      resolve(dirname(path), record.tarball),
      "--access",
      "public",
      "--provenance",
    ],
    { cwd: dirname(path) },
  );
  confirmRegistryIntegrity(record);
}

export function parseArguments(arguments_) {
  const options = {};
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--") continue;
    if (argument === "--require-main-ancestor") {
      options.requireMainAncestor = true;
      continue;
    }
    if (argument === "--require-clean") {
      options.requireClean = true;
      continue;
    }
    if (argument === "--require-release-tag") {
      options.requireReleaseTag = true;
      continue;
    }
    const key =
      argument === "--root"
        ? "root"
        : argument === "--output"
          ? "output"
          : argument === "--manifest"
            ? "manifest"
            : argument === "--expected-release-commit"
              ? "expectedReleaseCommit"
              : null;
    if (key === null || arguments_[index + 1] === undefined) {
      fail(`unknown or incomplete argument: ${argument}`);
    }
    options[key] = arguments_[index + 1];
    index += 1;
  }
  return options;
}

function defaultRoot() {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..");
}

async function main() {
  const [command, ...arguments_] = process.argv.slice(2);
  const options = parseArguments(arguments_);
  if (command === "check") {
    const temporaryParent = realpathSync(tmpdir());
    const output = await mkdtemp(
      join(temporaryParent, "agent-access-release-check-"),
    );
    try {
      await prepareRelease({ ...options, output });
    } finally {
      const cleanup = realpathSync(output);
      assert.equal(dirname(cleanup), temporaryParent);
      assert.ok(basename(cleanup).startsWith("agent-access-release-check-"));
      await rm(cleanup, { recursive: true, force: true });
    }
    process.stdout.write(
      "Verified package metadata, tarball inventory, and clean-consumer behavior.\n",
    );
    return;
  }
  if (command === "pack") {
    const { manifestPath } = await prepareRelease(options);
    process.stdout.write(`Prepared release package at ${manifestPath}.\n`);
    return;
  }
  if (command === "publish") {
    await publishPreparedRelease(options);
    return;
  }
  fail("usage: release-packages.mjs <check|pack|publish> [options]");
}

const isMain =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) await main();
