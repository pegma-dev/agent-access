import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  access,
  appendFile,
  copyFile,
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  basename,
  delimiter,
  dirname,
  isAbsolute,
  join,
  resolve,
} from "node:path";
import { fileURLToPath } from "node:url";
import {
  RELEASE_PACKAGES,
  STABLE_VERSION,
  releaseDependencies,
  verifyReleaseIdentity,
} from "./release-contract.mjs";
import {
  verifyPreparedManifest,
  writePreparedManifest,
} from "./release-manifest.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const packages = RELEASE_PACKAGES;
export { RELEASE_PACKAGES, releaseDependencies };

function run(command, arguments_, cwd, env = process.env) {
  const result = spawnSync(command, arguments_, {
    cwd,
    env,
    encoding: "utf8",
    shell: false,
    maxBuffer: 8 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    throw new Error("Release build, pack, or consumer command failed.");
  }
  return result.stdout.trim();
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export async function resolveReleaseNpmCli(env = process.env) {
  const candidate = env.RELEASE_NPM_CLI;
  assert.ok(
    typeof candidate === "string" &&
      isAbsolute(candidate) &&
      basename(candidate) === "npm-cli.js",
    "The reviewed release npm CLI must be an explicit absolute npm-cli.js path.",
  );
  assert.equal(
    env.RELEASE_NPM_VERSION,
    "11.18.0",
    "Release preparation requires the reviewed npm version.",
  );
  const path = resolve(candidate);
  const metadata = await lstat(path);
  assert.ok(
    metadata.isFile() && !metadata.isSymbolicLink(),
    "The release npm CLI must be a regular file.",
  );
  const canonical = await realpath(path);
  assert.equal(
    canonical,
    path,
    "The release npm CLI must use its canonical path.",
  );
  return canonical;
}

async function npmCliPath(preparedRelease = false) {
  if (preparedRelease) {
    const candidate = await resolveReleaseNpmCli();
    const [major, minor] = process.versions.node.split(".").map(Number);
    assert.ok(
      major > 22 || (major === 22 && minor >= 14),
      "Release preparation requires Node 22.14 or newer.",
    );
    const versionEnvironment = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (
        /^(?:PATH|PATHEXT|SystemRoot|WINDIR|COMSPEC|TEMP|TMP|HOME|USERPROFILE|LOCALAPPDATA|APPDATA)$/iu.test(
          key,
        )
      ) {
        versionEnvironment[key] = value;
      }
    }
    assert.equal(
      run(
        process.execPath,
        [candidate, "--version"],
        tmpdir(),
        versionEnvironment,
      ),
      "11.18.0",
      "Release preparation npm CLI differs from the reviewed version.",
    );
    return candidate;
  }
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
    if (await exists(executable)) {
      const target = await realpath(executable);
      if (basename(target) === "npm-cli.js") candidates.push(target);
    }
  }
  for (const candidate of candidates) {
    if (await exists(candidate)) return candidate;
  }
  throw new Error("Cannot locate npm-cli.js beside Node.js or on PATH.");
}

async function json(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

const rootDirectory = root;
const PACKAGE = RELEASE_PACKAGES[0];
const REPOSITORY_URL = "git+https://github.com/pegma-dev/agent-access.git";
const RUNTIME_DEPENDENCIES = releaseDependencies(PACKAGE.directory, "0.1.0");
const REVIEWED_PNPM_VERSION = "10.34.5";
const STABLE_SEMVER = STABLE_VERSION;

function fail(message) {
  throw new Error(message);
}

async function readJson(path) {
  return json(path);
}

function pnpmLockfileHasImporter(lockfile, importer) {
  let inImporters = false;
  for (const line of lockfile.split(/\r?\n/u)) {
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

export async function validateRepository(options = {}) {
  const root = resolve(options.root ?? rootDirectory);
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
    Object.keys(manifest.publishConfig).length !== 1 ||
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
    "bundleDependencies",
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
    !["pnpm run build", "pnpm run --silent build"].includes(
      manifest.scripts?.prepack,
    )
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

  return { root, manifest, packageDirectory };
}

async function validatePackages() {
  const { manifest } = await validateRepository();
  return [manifest];
}

function validateInventory(metadata) {
  const paths = metadata.files.map(({ path }) => path);
  for (const required of [
    "package.json",
    "README.md",
    "LICENSE",
    "dist/index.js",
    "dist/index.d.ts",
  ]) {
    assert.ok(paths.includes(required), `Tarball is missing ${required}.`);
  }
  for (const path of paths) {
    const parts = path.split("/");
    assert.ok(!parts.some((part) => part === "." || part === ".."));
    assert.ok(
      ["package.json", "README.md", "LICENSE"].includes(path) ||
        (/^dist\/[A-Za-z0-9_./-]+\.(?:js|js\.map|d\.ts|d\.ts\.map)$/u.test(
          path,
        ) &&
          !/\.(?:test|spec)\./u.test(path)),
      `Unexpected packaged file: ${path}`,
    );
  }
}

function sourceEnvironment(directory) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (
      /^(?:PATH|PATHEXT|SystemRoot|WINDIR|COMSPEC|TEMP|TMP|HOME|USERPROFILE|LOCALAPPDATA|APPDATA)$/iu.test(
        key,
      )
    ) {
      env[key] = value;
    }
  }
  return {
    ...env,
    CI: "true",
    npm_config_userconfig: join(directory, "user.npmrc"),
    npm_config_globalconfig: join(directory, "global.npmrc"),
    npm_config_cache: join(directory, "cache"),
    npm_config_registry: "https://registry.npmjs.org/",
    npm_config_ignore_scripts: "true",
    npm_config_audit: "false",
    npm_config_fund: "false",
  };
}

async function smokeTestTarball(tarball, manifest, npm, env) {
  const temporaryParent = await realpath(tmpdir());
  const directory = await mkdtemp(
    join(temporaryParent, "agent-access-release-smoke-"),
  );
  try {
    await writeFile(
      join(directory, "package.json"),
      '{"name":"agent-access-release-smoke","private":true,"type":"module"}\n',
    );
    run(
      process.execPath,
      [
        npm,
        "install",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "--package-lock=false",
        tarball,
      ],
      directory,
      env,
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
        join(root, "node_modules", "typescript", "bin", "tsc"),
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
      directory,
      env,
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
        directory,
        env,
      );
    }
  } finally {
    const cleanup = await realpath(directory);
    assert.equal(dirname(cleanup), temporaryParent);
    assert.ok(basename(cleanup).startsWith("agent-access-release-smoke-"));
    await rm(cleanup, { recursive: true, force: true });
  }
}

async function prepareArtifacts(mode, options = {}) {
  const manifests = await validatePackages();
  const identity =
    mode === "prepare"
      ? verifyReleaseIdentity({
          root,
          tag: options.tag,
          expectedCommit: options.expectedCommit,
          version: manifests[0].version,
        })
      : undefined;
  const npm = await npmCliPath(mode === "prepare");
  const temporaryParent = await realpath(tmpdir());
  const temporary = await mkdtemp(
    join(temporaryParent, "pegma-agent-access-release-"),
  );
  try {
    await writeFile(join(temporary, "user.npmrc"), "");
    await writeFile(join(temporary, "global.npmrc"), "");
    const env = sourceEnvironment(temporary);
    await cleanBuildOutputs();
    // Emit every output from this checkout. Packing below disables scripts so
    // an incremental prepack cannot replace this fresh artifact.
    run(
      process.execPath,
      [
        join(root, "node_modules", "typescript", "bin", "tsc"),
        "-b",
        "--force",
        ...packages.map(({ directory }) =>
          join(root, "packages", directory, "tsconfig.json"),
        ),
      ],
      root,
      env,
    );
    const artifacts = [];
    for (const [index, specification] of packages.entries()) {
      const output = run(
        process.execPath,
        [
          npm,
          "pack",
          "--json",
          "--ignore-scripts",
          "--registry",
          "https://registry.npmjs.org/",
          "--pack-destination",
          temporary,
        ],
        join(root, "packages", specification.directory),
        env,
      );
      const packed = JSON.parse(output);
      assert.equal(packed.length, 1);
      const metadata = packed[0];
      assert.equal(metadata.name, specification.name);
      assert.equal(metadata.version, manifests[index].version);
      assert.equal(basename(metadata.filename), metadata.filename);
      assert.equal(
        metadata.filename,
        `${specification.name.slice(1).replace("/", "-")}-${manifests[index].version}.tgz`,
      );
      validateInventory(metadata);
      const bytes = await readFile(join(temporary, metadata.filename));
      assert.equal(bytes.length, metadata.size);
      assert.equal(
        createHash("sha1").update(bytes).digest("hex"),
        metadata.shasum,
      );
      assert.equal(
        `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
        metadata.integrity,
      );
      artifacts.push(metadata);
    }
    await smokeTestTarball(
      join(temporary, artifacts[0].filename),
      manifests[0],
      npm,
      env,
    );
    if (mode === "pack") {
      const releases = join(root, ".release");
      await mkdir(releases, { recursive: true });
      const destination = await mkdtemp(join(releases, "agent-access-"));
      for (const { filename } of artifacts) {
        await copyFile(join(temporary, filename), join(destination, filename));
      }
      await writeFile(
        join(destination, "manifest.json"),
        `${JSON.stringify({ schemaVersion: 1, artifacts }, null, 2)}\n`,
      );
      console.log(`Prepared verified artifacts in ${destination}`);
    }
    if (mode === "prepare") {
      // Check the reviewed source again after build and consumer execution,
      // before creating any output directory that could dirty the checkout.
      assert.deepEqual(
        verifyReleaseIdentity({
          root,
          tag: options.tag,
          expectedCommit: options.expectedCommit,
          version: identity.version,
        }),
        identity,
      );
      const preparedDir = await preparedDirectory(options.output);
      for (const { filename } of artifacts) {
        await copyFile(
          join(temporary, filename),
          join(preparedDir, filename),
          constants.COPYFILE_EXCL,
        );
      }
      const prepared = await writePreparedManifest({
        preparedDir,
        identity,
        artifacts: artifacts.map((artifact, index) => ({
          name: artifact.name,
          version: artifact.version,
          filename: artifact.filename,
          size: artifact.size,
          shasum: artifact.shasum,
          integrity: artifact.integrity,
          dependencies: manifests[index].dependencies,
          files: artifact.files
            .map(({ path, size }) => ({ path, size }))
            .sort((left, right) => left.path.localeCompare(right.path)),
        })),
      });
      return { preparedDir, ...prepared };
    }
    console.log(
      `Verified packaging and clean-consumer imports for ${artifacts.length} packages, including public types and OAuth API behavior.`,
    );
  } finally {
    const cleanup = await realpath(temporary);
    assert.equal(dirname(cleanup), temporaryParent);
    assert.ok(basename(cleanup).startsWith("pegma-agent-access-release-"));
    await rm(cleanup, { recursive: true, force: true });
  }
}

async function optionalMetadata(path) {
  try {
    return await lstat(path);
  } catch (error) {
    if (error.code === "ENOENT") return undefined;
    throw error;
  }
}

async function canonicalNode(path, kind) {
  const metadata = await lstat(path);
  assert.ok(
    !metadata.isSymbolicLink() &&
      (kind === "directory" ? metadata.isDirectory() : metadata.isFile()),
    "Release build output paths must not contain symlinks or special files.",
  );
  assert.equal(
    await realpath(path),
    path,
    "Release build output paths must stay inside their canonical package.",
  );
}

async function validateOutputTree(path) {
  await canonicalNode(path, "directory");
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    assert.equal(dirname(child), path);
    if (entry.isDirectory()) {
      await validateOutputTree(child);
    } else {
      await canonicalNode(child, "file");
    }
  }
}

export async function cleanBuildOutputs(checkoutRoot = root) {
  const checkout = resolve(checkoutRoot);
  await canonicalNode(checkout, "directory");
  const packageRoot = join(checkout, "packages");
  await canonicalNode(packageRoot, "directory");
  const outputs = [];
  // Preflight every target before removing any file. Output names are fixed by
  // this reviewed producer; never turn tsconfig values into deletion targets.
  for (const specification of packages) {
    const packageDirectory = join(packageRoot, specification.directory);
    assert.equal(dirname(packageDirectory), packageRoot);
    await canonicalNode(packageDirectory, "directory");
    const configurationPath = join(packageDirectory, "tsconfig.json");
    await canonicalNode(configurationPath, "file");
    const configuration = await json(configurationPath);
    assert.equal(configuration.compilerOptions?.outDir, "dist");
    assert.equal(configuration.compilerOptions?.rootDir, "src");
    assert.equal(
      configuration.compilerOptions?.tsBuildInfoFile,
      "tsconfig.tsbuildinfo",
    );
    const directory = join(packageDirectory, "dist");
    const buildInfo = join(packageDirectory, "tsconfig.tsbuildinfo");
    assert.equal(dirname(directory), packageDirectory);
    assert.equal(dirname(buildInfo), packageDirectory);
    if (await optionalMetadata(directory)) await validateOutputTree(directory);
    if (await optionalMetadata(buildInfo))
      await canonicalNode(buildInfo, "file");
    outputs.push({ directory, buildInfo });
  }
  for (const { directory, buildInfo } of outputs) {
    // Recheck the exact targets immediately before deletion as well. Do not
    // follow junctions/symlinks even when they point back inside the checkout.
    if (await optionalMetadata(directory)) {
      await validateOutputTree(directory);
      await rm(directory, { recursive: true, force: true });
    }
    if (await optionalMetadata(buildInfo)) {
      await canonicalNode(buildInfo, "file");
      await rm(buildInfo);
    }
  }
}

async function preparedDirectory(output) {
  if (output === undefined) {
    const releases = join(root, ".release");
    await mkdir(releases, { recursive: true });
    return realpath(await mkdtemp(join(releases, "agent-access-")));
  }
  assert.equal(typeof output, "string", "Release output must be a directory.");
  assert.ok(output.length > 0, "Release output must be a directory.");
  const destination = resolve(root, output);
  await mkdir(destination, { recursive: true });
  const metadata = await lstat(destination);
  assert.ok(
    metadata.isDirectory() && !metadata.isSymbolicLink(),
    "Release output must be a regular directory.",
  );
  assert.equal(
    (await readdir(destination)).length,
    0,
    "Release output directory must be empty.",
  );
  return realpath(destination);
}

export async function prepareRelease(options = {}) {
  return prepareArtifacts("prepare", options);
}

export async function preflightRelease(options = {}) {
  const verified = await verifyPreparedManifest(options);
  const { preflightRegistry } = await import("./release-registry.mjs");
  return preflightRegistry(verified);
}

export async function publishPreparedRelease(options = {}) {
  await verifyPreparedManifest(options);
  const { publishPreparedRelease: publish } =
    await import("./release-registry.mjs");
  return publish(options);
}

export async function verifyRelease(options = {}) {
  await verifyPreparedManifest(options);
  const { verifyRegistryRelease } = await import("./release-registry.mjs");
  return verifyRegistryRelease(options);
}

const usage =
  "Usage: release-packages.mjs check|pack|prepare|preflight|publish|verify [options]";

export function parseArguments(arguments_) {
  const [command, ...flags] = arguments_;
  assert.ok(
    ["check", "pack", "prepare", "preflight", "publish", "verify"].includes(
      command,
    ),
    usage,
  );
  if (command === "check" || command === "pack") {
    assert.equal(flags.length, 0, "No additional arguments are supported.");
    return { command, options: {} };
  }
  const keys =
    command === "prepare"
      ? {
          "--tag": "tag",
          "--expected-commit": "expectedCommit",
          "--out": "output",
        }
      : {
          "--prepared-dir": "preparedDir",
          "--manifest-sha256": "expectedManifestSha256",
          "--tag": "expectedTag",
          "--expected-commit": "expectedCommit",
        };
  const options = {};
  for (let index = 0; index < flags.length; index += 2) {
    const key = Object.hasOwn(keys, flags[index])
      ? keys[flags[index]]
      : undefined;
    const value = flags[index + 1];
    assert.ok(
      key !== undefined &&
        !Object.hasOwn(options, key) &&
        typeof value === "string" &&
        value.length > 0 &&
        !value.startsWith("--") &&
        !/[\u0000-\u001f\u007f]/u.test(value),
      "Unknown, repeated, or incomplete release argument.",
    );
    options[key] = value;
  }
  const tag = command === "prepare" ? options.tag : options.expectedTag;
  assert.ok(
    typeof tag === "string" &&
      tag.startsWith("v") &&
      STABLE_VERSION.test(tag.slice(1)),
    "An exact stable release tag is required.",
  );
  assert.ok(
    typeof options.expectedCommit === "string" &&
      /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(options.expectedCommit),
    "An exact release event commit is required.",
  );
  if (command !== "prepare") {
    assert.equal(
      typeof options.preparedDir,
      "string",
      "A prepared release directory is required.",
    );
    assert.ok(
      typeof options.expectedManifestSha256 === "string" &&
        /^[0-9a-f]{64}$/u.test(options.expectedManifestSha256),
      "An independent prepared manifest SHA-256 is required.",
    );
  }
  return { command, options };
}

async function reportPrepared(prepared) {
  const values = {
    "prepared-dir": prepared.preparedDir,
    "manifest-path": prepared.manifestPath,
    "manifest-sha256": prepared.manifestSha256,
  };
  const output = Object.entries(values)
    .map(([key, value]) => {
      assert.ok(
        !/[\u0000-\u001f\u007f]/u.test(value),
        "Release output must be single-line.",
      );
      return `${key}=${value}\n`;
    })
    .join("");
  process.stdout.write(output);
  if (process.env.GITHUB_ACTIONS === "true" && process.env.GITHUB_OUTPUT) {
    await appendFile(process.env.GITHUB_OUTPUT, output);
  }
}

async function main() {
  const { command, options } = parseArguments(process.argv.slice(2));
  if (command === "check" || command === "pack") {
    await prepareArtifacts(command);
  } else if (command === "prepare") {
    await reportPrepared(await prepareRelease(options));
  } else if (command === "preflight") {
    const plan = await preflightRelease(options);
    for (const record of plan) {
      console.log(`${record.name}@${record.version}: ${record.action}`);
    }
  } else if (command === "publish") {
    const result = await publishPreparedRelease(options);
    console.log(
      `Verified publication of ${result.published.length} packages; ${result.skipped.length} already identical.`,
    );
  } else {
    const result = await verifyRelease(options);
    console.log(
      `Verified registry release and clean consumer for ${result.packages.length} packages.`,
    );
  }
}

if (
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
