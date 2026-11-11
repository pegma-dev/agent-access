import assert from "node:assert/strict";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import test from "node:test";
import {
  assertTrustedPublishingEnvironment,
  preflightRegistry,
  publishPreparedRelease,
  RELEASE_WORKFLOW,
  verifyProvenanceAudit,
  verifyRegistryRelease,
} from "../../scripts/release-registry.mjs";
import {
  verifyPreparedManifest,
  writePreparedManifest,
} from "../../scripts/release-manifest.mjs";
import {
  identity,
  preparedFixture,
  syntheticCertificate,
} from "./fixtures.mjs";

const registry = "https://registry.npmjs.org/";

function tarballUrl(record) {
  return `${registry}${record.name}/-/${record.name.split("/")[1]}-${record.version}.tgz`;
}

function metadata(record) {
  return {
    name: record.name,
    version: record.version,
    dependencies: structuredClone(record.dependencies),
    dist: {
      shasum: record.shasum,
      integrity: record.integrity,
      tarball: tarballUrl(record),
    },
  };
}

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function fixture(t) {
  const prepared = await preparedFixture(t);
  const written = await writePreparedManifest(prepared);
  const npmCli = join(prepared.directory, "npm-cli.js");
  await writeFile(npmCli, "// Synthetic seam: never executed.\n");
  const options = {
    preparedDir: prepared.preparedDir,
    expectedManifestSha256: written.manifestSha256,
    expectedTag: identity.tag,
    expectedCommit: identity.commit,
    npmCli,
  };
  const verified = await verifyPreparedManifest(options);
  const blobs = new Map();
  for (const record of verified.artifacts) {
    blobs.set(record.name, await readFile(record.path));
  }
  return { ...prepared, options, verified, blobs };
}

function fakeRegistry(
  fixture,
  present = fixture.verified.artifacts.map(({ name }) => name),
) {
  const state = {
    present: new Set(present),
    requests: [],
    metadata: undefined,
    blob: undefined,
    beforeRequest: undefined,
  };
  state.fetch = async (input, options) => {
    const url = String(input);
    assert.equal(options.redirect, "error");
    assert.ok(options.method === undefined || options.method === "GET");
    assert.ok(options.signal instanceof AbortSignal);
    const record = fixture.verified.artifacts.find(
      (record) =>
        url ===
          `${registry}${encodeURIComponent(record.name)}/${record.version}` ||
        url === tarballUrl(record),
    );
    assert.ok(record, `Unexpected registry URL: ${url}`);
    const kind = url === tarballUrl(record) ? "tarball" : "metadata";
    state.requests.push({ kind, name: record.name });
    await state.beforeRequest?.(kind, record);
    if (kind === "metadata") {
      const overridden = await state.metadata?.(record);
      if (overridden !== undefined) return overridden;
      return state.present.has(record.name)
        ? jsonResponse(metadata(record))
        : jsonResponse({ error: "Not found" }, 404);
    }
    const overridden = await state.blob?.(record);
    return overridden ?? new Response(fixture.blobs.get(record.name));
  };
  return state;
}

function trustedEnvironment() {
  return {
    GITHUB_ACTIONS: "true",
    GITHUB_EVENT_NAME: "release",
    GITHUB_REPOSITORY: "pegma-dev/agent-access",
    GITHUB_REPOSITORY_ID: "123456789",
    GITHUB_REPOSITORY_OWNER_ID: "987654321",
    GITHUB_RUN_ID: "1234567890",
    GITHUB_RUN_ATTEMPT: "1",
    GITHUB_SERVER_URL: "https://github.com",
    GITHUB_REF: `refs/tags/${identity.tag}`,
    GITHUB_SHA: identity.commit,
    GITHUB_WORKFLOW_REF: `pegma-dev/agent-access/${RELEASE_WORKFLOW}@refs/tags/${identity.tag}`,
    GITHUB_WORKFLOW_SHA: identity.commit,
    RUNNER_ENVIRONMENT: "github-hosted",
    ACTIONS_ID_TOKEN_REQUEST_URL:
      "https://pipelines.actions.githubusercontent.com/synthetic",
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: "synthetic-oidc-request-token",
    SYNTHETIC_SOURCE_SECRET: "must-not-reach-npm",
    GITHUB_TOKEN: "synthetic-github-token",
    GH_TOKEN: "synthetic-gh-token",
    GITHUB_CUSTOM_SECRET: "synthetic-github-secret",
    GITHUB_APP_PRIVATE_KEY: "synthetic-github-app-key",
    RUNNER_CUSTOM_SECRET: "synthetic-runner-secret",
    ACTIONS_ID_TOKEN_REQUEST_CUSTOM_SECRET: "synthetic-oidc-extra-secret",
    PATH: "synthetic-os-path",
    TEMP: "synthetic-os-temp",
    NODE_OPTIONS: "--require=synthetic-untrusted-hook.cjs",
  };
}

function publisher(fixture, state) {
  const calls = [];
  const sleeps = [];
  let elapsed = 0;
  const seams = {
    now: () => elapsed,
    env: trustedEnvironment(),
    fetch: state.fetch,
    sleep: async (milliseconds) => {
      sleeps.push(milliseconds);
      elapsed += milliseconds;
    },
    run: async (command, arguments_, context) => {
      calls.push({ command, arguments_, context });
      assert.equal(command, process.execPath);
      assert.equal(arguments_[0], fixture.options.npmCli);
      assert.equal(context.env.SYNTHETIC_SOURCE_SECRET, undefined);
      assert.equal(context.env.NODE_OPTIONS, undefined);
      assert.equal(context.env.npm_config_ignore_scripts, "true");
      assert.equal(context.env.npm_config_registry, registry);
      assert.notEqual(context.cwd, fixture.preparedDir);
      for (const key of ["npm_config_userconfig", "npm_config_globalconfig"]) {
        assert.equal(dirname(context.env[key]), context.cwd);
        assert.equal(await readFile(context.env[key], "utf8"), "");
      }
      assert.equal(dirname(context.env.npm_config_cache), context.cwd);
      assert.equal(
        await readFile(join(context.cwd, ".npmrc"), "utf8"),
        `registry=${registry}\n`,
      );
      if (arguments_[1] === "--version") {
        return { status: 0, stdout: "11.18.0\n", stderr: "" };
      }
      assert.equal(arguments_[1], "publish");
      const record = fixture.verified.artifacts.find(
        ({ filename }) => filename === basename(arguments_[2]),
      );
      assert.ok(record);
      assert.equal(dirname(arguments_[2]), context.cwd);
      assert.deepEqual(
        await readFile(arguments_[2]),
        fixture.blobs.get(record.name),
      );
      assert.deepEqual(arguments_.slice(3), [
        "--ignore-scripts",
        "--access",
        "public",
        "--provenance",
        "--registry",
        registry,
      ]);
      const initialLookups = new Set(
        state.requests
          .filter(({ kind }) => kind === "metadata")
          .map(({ name }) => name),
      );
      assert.equal(
        initialLookups.size,
        1,
        "the exact version must be checked before npm publish",
      );
      state.present.add(record.name);
      return { status: 0, stdout: "synthetic publication\n", stderr: "" };
    },
  };
  return { seams, calls, sleeps };
}

test("only explicit version 404s produce a publication plan for the exact package", async (t) => {
  const prepared = await fixture(t);
  const state = fakeRegistry(prepared, []);
  const plan = await preflightRegistry(prepared.verified, {
    fetch: state.fetch,
  });
  assert.deepEqual(
    plan,
    prepared.artifacts.map(({ name, version }) => ({
      name,
      version,
      action: "publish",
    })),
  );
  assert.ok(Object.isFrozen(plan));
  assert.ok(plan.every(Object.isFrozen));
  assert.equal(state.requests.length, 1);
  assert.ok(state.requests.every(({ kind }) => kind === "metadata"));
});

test("existing versions require exact metadata plus downloaded tarball bytes before recovery can skip them", async (t) => {
  const prepared = await fixture(t);
  const state = fakeRegistry(prepared);
  const plan = await preflightRegistry(prepared.verified, {
    fetch: state.fetch,
  });
  assert.deepEqual(
    plan.map(({ action }) => action),
    ["skip"],
  );
  assert.equal(
    state.requests.filter(({ kind }) => kind === "tarball").length,
    1,
  );
});

test("unknown metadata responses and network errors never establish absence", async (t) => {
  for (const status of [
    204,
    301,
    400,
    401,
    403,
    409,
    429,
    500,
    503,
    "network",
    "malformed",
    "failed response containing E404",
  ]) {
    await t.test(String(status), async (t) => {
      const prepared = await fixture(t);
      const state = fakeRegistry(prepared, []);
      state.metadata = (record) => {
        if (record.name !== prepared.artifacts[0].name) return undefined;
        if (status === "network")
          throw new Error("synthetic-credential-do-not-echo");
        if (status === "malformed")
          return new Response("synthetic-credential-do-not-echo", {
            status: 200,
          });
        if (status === "failed response containing E404")
          return new Response("E404 synthetic-credential-do-not-echo", {
            status: 503,
          });
        return new Response(null, { status });
      };
      const publishing = publisher(prepared, state);
      await assert.rejects(
        publishPreparedRelease(prepared.options, publishing.seams),
        (error) => !error.message.includes("synthetic-credential-do-not-echo"),
      );
      assert.equal(publishing.calls.length, 0);
    });
  }
});

test("a conflicting exact version prevents publication before npm execution", async (t) => {
  const prepared = await fixture(t);
  const state = fakeRegistry(prepared, [prepared.artifacts[0].name]);
  state.metadata = (record) => {
    if (record.name !== prepared.artifacts[0].name) return undefined;
    const value = metadata(record);
    value.dependencies.zod = "99.0.0";
    return jsonResponse(value);
  };
  const publishing = publisher(prepared, state);
  await assert.rejects(
    publishPreparedRelease(prepared.options, publishing.seams),
    /conflicts/u,
  );
  assert.equal(publishing.calls.length, 0);
});

test("matching integrity alone cannot authorize wrong metadata or a foreign tarball URL", async (t) => {
  const changes = [
    [
      "name",
      (value) => {
        value.name = "@other/agent-access";
      },
    ],
    [
      "version",
      (value) => {
        value.version = "0.3.0";
      },
    ],
    [
      "dependency",
      (value) => {
        value.dependencies["@pegma/spine"] = "^0.1.2";
      },
    ],
    [
      "extra dependency",
      (value) => {
        value.dependencies.extra = "1.0.0";
      },
    ],
    [
      "SHA-1",
      (value) => {
        value.dist.shasum = "0".repeat(40);
      },
    ],
    [
      "SHA-512",
      (value) => {
        value.dist.integrity = "sha512-unreviewed";
      },
    ],
    [
      "foreign host",
      (value) => {
        value.dist.tarball = "https://example.invalid/package.tgz";
      },
    ],
    [
      "foreign registry path",
      (value) => {
        value.dist.tarball = `${registry}other/-/other-0.2.0.tgz`;
      },
    ],
    [
      "optional dependency",
      (value) => {
        value.optionalDependencies = { extra: "1.0.0" };
      },
    ],
    [
      "peer dependency",
      (value) => {
        value.peerDependencies = { extra: "1.0.0" };
      },
    ],
  ];
  for (const [name, change] of changes) {
    await t.test(name, async (t) => {
      const prepared = await fixture(t);
      const state = fakeRegistry(prepared);
      state.metadata = (record) => {
        const value = metadata(record);
        change(value);
        return jsonResponse(value);
      };
      await assert.rejects(
        preflightRegistry(prepared.verified, { fetch: state.fetch }),
        /conflicts/u,
      );
      assert.equal(
        state.requests.some(({ kind }) => kind === "tarball"),
        false,
      );
    });
  }
});

test("registry tarball bytes, length, and response status are independently verified", async (t) => {
  for (const problem of [
    "changed bytes",
    "too short",
    "too large",
    "404",
    "redirect",
    "declared too large",
  ]) {
    await t.test(problem, async (t) => {
      const prepared = await fixture(t);
      const state = fakeRegistry(prepared);
      state.blob = (record) => {
        const bytes = Buffer.from(prepared.blobs.get(record.name));
        if (problem === "404") return new Response(null, { status: 404 });
        if (problem === "redirect") return new Response(null, { status: 302 });
        if (problem === "too short") return new Response(bytes.subarray(1));
        if (problem === "too large")
          return new Response(Buffer.concat([bytes, Buffer.from("extra")]));
        if (problem === "declared too large")
          return new Response(bytes, {
            headers: { "content-length": String(bytes.length + 1) },
          });
        bytes[0] ^= 1;
        return new Response(bytes);
      };
      await assert.rejects(
        preflightRegistry(prepared.verified, { fetch: state.fetch }),
        /tarball/u,
      );
    });
  }
});

test("publishing inherits approved provenance and OIDC variables without GitHub credentials", async (t) => {
  const prepared = await fixture(t);
  const state = fakeRegistry(prepared, []);
  const publishing = publisher(prepared, state);
  await publishPreparedRelease(prepared.options, publishing.seams);
  assert.ok(publishing.calls.length > 0);
  for (const { context } of publishing.calls) {
    for (const key of [
      "GITHUB_TOKEN",
      "GH_TOKEN",
      "GITHUB_CUSTOM_SECRET",
      "GITHUB_APP_PRIVATE_KEY",
      "RUNNER_CUSTOM_SECRET",
      "ACTIONS_ID_TOKEN_REQUEST_CUSTOM_SECRET",
    ]) {
      assert.equal(context.env[key], undefined, key);
    }
    for (const key of [
      "GITHUB_ACTIONS",
      "GITHUB_EVENT_NAME",
      "GITHUB_REPOSITORY",
      "GITHUB_REPOSITORY_ID",
      "GITHUB_REPOSITORY_OWNER_ID",
      "GITHUB_SERVER_URL",
      "GITHUB_REF",
      "GITHUB_SHA",
      "GITHUB_WORKFLOW_REF",
      "GITHUB_WORKFLOW_SHA",
      "GITHUB_RUN_ID",
      "GITHUB_RUN_ATTEMPT",
      "RUNNER_ENVIRONMENT",
      "ACTIONS_ID_TOKEN_REQUEST_URL",
      "ACTIONS_ID_TOKEN_REQUEST_TOKEN",
      "PATH",
      "TEMP",
    ]) {
      assert.equal(context.env[key], publishing.seams.env[key], key);
    }
  }
});

test("a first publication checks the complete artifact then publishes only its prepared blob", async (t) => {
  const prepared = await fixture(t);
  const state = fakeRegistry(prepared, []);
  const publishing = publisher(prepared, state);
  const result = await publishPreparedRelease(
    prepared.options,
    publishing.seams,
  );
  assert.deepEqual(result, {
    published: prepared.artifacts.map(({ name }) => name),
    skipped: [],
    verified: true,
  });
  assert.deepEqual(
    publishing.calls
      .filter(({ arguments_ }) => arguments_[1] === "publish")
      .map(({ arguments_ }) => basename(arguments_[2])),
    prepared.artifacts.map(({ filename }) => filename),
  );
  assert.equal(publishing.sleeps.length, 0);
  assert.ok(Object.isFrozen(result.published));
});

test("an existing verified version and its rerun perform no publication or installation", async (t) => {
  const prepared = await fixture(t);
  const names = prepared.artifacts.map(({ name }) => name);
  const state = fakeRegistry(prepared, names);
  const publishing = publisher(prepared, state);
  const result = await publishPreparedRelease(
    prepared.options,
    publishing.seams,
  );
  assert.deepEqual(result.published, []);
  assert.deepEqual(result.skipped, names);
  const rerun = publisher(prepared, state);
  const recovered = await publishPreparedRelease(prepared.options, rerun.seams);
  assert.deepEqual(recovered.published, []);
  assert.deepEqual(recovered.skipped, names);
  assert.equal(
    rerun.calls.some(({ arguments_ }) => arguments_[1] === "publish"),
    false,
  );
  assert.ok(
    [...publishing.calls, ...rerun.calls].every(
      ({ arguments_ }) => arguments_[1] === "--version",
    ),
  );
});

test("a matching version published concurrently is reverified and skipped immediately before publication", async (t) => {
  const prepared = await fixture(t);
  const names = prepared.artifacts.map(({ name }) => name);
  const state = fakeRegistry(prepared, names.slice(1));
  let lookups = 0;
  state.beforeRequest = (kind, record) => {
    if (kind === "metadata" && record.name === names[0] && ++lookups === 2)
      state.present.add(names[0]);
  };
  const publishing = publisher(prepared, state);
  const result = await publishPreparedRelease(
    prepared.options,
    publishing.seams,
  );
  assert.deepEqual(result.published, []);
  assert.deepEqual(result.skipped, names);
  assert.equal(
    publishing.calls.some(({ arguments_ }) => arguments_[1] === "publish"),
    false,
  );
});

test("publication waits through npm scanning and verifies bytes without publishing twice", async (t) => {
  const prepared = await fixture(t);
  const state = fakeRegistry(prepared, []);
  const publishing = publisher(prepared, state);
  state.metadata = () =>
    publishing.calls.some(({ arguments_ }) => arguments_[1] === "publish") &&
    publishing.seams.now() < 16 * 60_000
      ? jsonResponse({ error: "Not found" }, 404)
      : undefined;
  const result = await publishPreparedRelease(
    prepared.options,
    publishing.seams,
  );
  assert.deepEqual(
    result.published,
    prepared.artifacts.map(({ name }) => name),
  );
  assert.equal(publishing.sleeps.length, 32);
  assert.equal(
    publishing.calls.filter(({ arguments_ }) => arguments_[1] === "publish")
      .length,
    1,
  );
  assert.ok(state.requests.some(({ kind }) => kind === "tarball"));
});

test("post-publication absence and transient failures share a bounded budget while authentication fails immediately", async (t) => {
  for (const problem of ["404", "network", 401, 403, 429, 503]) {
    await t.test(String(problem), async (t) => {
      const prepared = await fixture(t);
      const state = fakeRegistry(prepared, []);
      let published = false;
      const publishing = publisher(prepared, state);
      const originalRun = publishing.seams.run;
      publishing.seams.run = async (...arguments_) => {
        const result = await originalRun(...arguments_);
        if (arguments_[1][1] === "publish") published = true;
        return result;
      };
      state.metadata = () => {
        if (!published) return undefined;
        if (problem === "network")
          throw new Error("synthetic unknown network state");
        if (typeof problem === "number") return jsonResponse({}, problem);
        return jsonResponse({ error: "Not found" }, 404);
      };
      await assert.rejects(
        publishPreparedRelease(prepared.options, publishing.seams),
        problem === 401 || problem === 403
          ? /package availability is unknown/
          : /could not be confirmed/,
      );
      assert.equal(
        publishing.calls.filter(({ arguments_ }) => arguments_[1] === "publish")
          .length,
        1,
      );
      assert.deepEqual(
        publishing.sleeps,
        problem === 401 || problem === 403 ? [] : Array(40).fill(30_000),
      );
      assert.equal(
        state.requests.filter(({ kind }) => kind === "metadata").length,
        problem === 401 || problem === 403 ? 3 : 43,
      );
    });
  }
});

test("accepted-upload confirmation survives a late transient registry failure without another upload", async (t) => {
  for (const problem of ["network", 429, 503]) {
    await t.test(String(problem), async (t) => {
      const prepared = await fixture(t);
      const state = fakeRegistry(prepared, []);
      const publishing = publisher(prepared, state);
      let transient = false;
      state.metadata = () => {
        if (
          !publishing.calls.some(
            ({ arguments_ }) => arguments_[1] === "publish",
          )
        )
          return undefined;
        if (publishing.seams.now() < 19 * 60_000) return jsonResponse({}, 404);
        if (!transient) {
          transient = true;
          if (problem === "network")
            throw new Error("synthetic transport failure");
          return jsonResponse({}, problem);
        }
        return undefined;
      };
      const result = await publishPreparedRelease(
        prepared.options,
        publishing.seams,
      );
      assert.equal(transient, true);
      assert.equal(result.verified, true);
      assert.equal(publishing.seams.now(), 19 * 60_000 + 30_000);
      assert.equal(publishing.sleeps.length, 39);
      assert.equal(
        publishing.calls.filter(({ arguments_ }) => arguments_[1] === "publish")
          .length,
        1,
      );
      assert.equal(
        state.requests.filter(({ kind }) => kind === "tarball").length,
        2,
      );
    });
  }
});

test("accepted-upload confirmation retries only designated transient responses and interrupted bodies", async (t) => {
  const prepared = await fixture(t);
  const state = fakeRegistry(prepared, []);
  const publishing = publisher(prepared, state);
  const failures = [408, 500, 502, 504, "metadata body"];
  state.metadata = () => {
    if (!publishing.calls.some(({ arguments_ }) => arguments_[1] === "publish"))
      return undefined;
    const problem = failures.shift();
    if (problem === undefined) return undefined;
    if (problem === "metadata body")
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.error(new Error("synthetic transport failure"));
          },
        }),
      );
    return jsonResponse({}, problem);
  };
  const result = await publishPreparedRelease(
    prepared.options,
    publishing.seams,
  );
  assert.equal(result.verified, true);
  assert.deepEqual(failures, []);
  assert.deepEqual(publishing.sleeps, Array(5).fill(30_000));
  assert.equal(
    publishing.calls.filter(({ arguments_ }) => arguments_[1] === "publish")
      .length,
    1,
  );
});

test("accepted-upload tarball confirmation retries transport and transient status without accepting unverified bytes", async (t) => {
  const prepared = await fixture(t);
  const state = fakeRegistry(prepared, []);
  const publishing = publisher(prepared, state);
  const failures = ["network", 429, 503, "body"];
  state.blob = () => {
    const problem = failures.shift();
    if (problem === undefined) return undefined;
    if (problem === "network") throw new Error("synthetic transport failure");
    if (problem === "body")
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.error(new Error("synthetic transport failure"));
          },
        }),
      );
    return new Response(null, { status: problem });
  };
  const result = await publishPreparedRelease(
    prepared.options,
    publishing.seams,
  );
  assert.equal(result.verified, true);
  assert.deepEqual(failures, []);
  assert.deepEqual(publishing.sleeps, Array(4).fill(30_000));
  assert.equal(
    publishing.calls.filter(({ arguments_ }) => arguments_[1] === "publish")
      .length,
    1,
  );
  assert.equal(
    state.requests.filter(({ kind }) => kind === "tarball").length,
    6,
  );
});

test("accepted-upload confirmation honors bounded Retry-After without extending its deadline", async (t) => {
  for (const [name, headers, expectedDelay] of [
    ["seconds", { "retry-after": "90" }, 90_000],
    [
      "HTTP date",
      {
        date: "Wed, 11 Nov 2026 00:00:00 GMT",
        "retry-after": "Wed, 11 Nov 2026 00:01:30 GMT",
      },
      90_000,
    ],
    ["shorter than cadence", { "retry-after": "5" }, 30_000],
    ["invalid", { "retry-after": "invalid" }, 30_000],
    ["beyond budget", { "retry-after": "1201" }, null],
    ["overflow", { "retry-after": "9".repeat(400) }, null],
  ]) {
    await t.test(name, async (t) => {
      const prepared = await fixture(t);
      const state = fakeRegistry(prepared, []);
      const publishing = publisher(prepared, state);
      let transient = false;
      state.metadata = () => {
        if (
          !publishing.calls.some(
            ({ arguments_ }) => arguments_[1] === "publish",
          ) ||
          transient
        )
          return undefined;
        transient = true;
        return new Response(null, { status: 429, headers });
      };
      if (expectedDelay === null) {
        await assert.rejects(
          publishPreparedRelease(prepared.options, publishing.seams),
          /could not be confirmed/,
        );
        assert.deepEqual(publishing.sleeps, []);
      } else {
        const result = await publishPreparedRelease(
          prepared.options,
          publishing.seams,
        );
        assert.equal(result.verified, true);
        assert.deepEqual(publishing.sleeps, [expectedDelay]);
        assert.equal(publishing.seams.now(), expectedDelay);
      }
      assert.equal(
        publishing.calls.filter(({ arguments_ }) => arguments_[1] === "publish")
          .length,
        1,
      );
    });
  }
});

test("accepted-upload confirmation still rejects authentication, malformed metadata and byte conflicts immediately", async (t) => {
  for (const problem of [
    401,
    403,
    "malformed",
    "dependency",
    "tarball bytes",
  ]) {
    await t.test(String(problem), async (t) => {
      const prepared = await fixture(t);
      const state = fakeRegistry(prepared, []);
      const publishing = publisher(prepared, state);
      state.metadata = (record) => {
        if (
          !publishing.calls.some(
            ({ arguments_ }) => arguments_[1] === "publish",
          )
        )
          return undefined;
        if (typeof problem === "number") return jsonResponse({}, problem);
        if (problem === "malformed") return new Response("not JSON");
        if (problem === "dependency") {
          const value = metadata(record);
          value.dependencies.extra = "1.0.0";
          return jsonResponse(value);
        }
        return undefined;
      };
      if (problem === "tarball bytes")
        state.blob = (record) => {
          const bytes = Buffer.from(prepared.blobs.get(record.name));
          bytes[0] ^= 1;
          return new Response(bytes);
        };
      await assert.rejects(
        publishPreparedRelease(prepared.options, publishing.seams),
      );
      assert.deepEqual(publishing.sleeps, []);
      assert.equal(
        publishing.calls.filter(({ arguments_ }) => arguments_[1] === "publish")
          .length,
        1,
      );
    });
  }
});

test("the last pre-write lookup remains strict before any upload", async (t) => {
  for (const problem of [401, 429, 503, "network"]) {
    await t.test(String(problem), async (t) => {
      const prepared = await fixture(t);
      const state = fakeRegistry(prepared, []);
      const publishing = publisher(prepared, state);
      let lookups = 0;
      state.metadata = () => {
        if (++lookups === 1) return undefined;
        if (problem === "network")
          throw new Error("synthetic transport failure");
        return jsonResponse({}, problem);
      };
      await assert.rejects(
        publishPreparedRelease(prepared.options, publishing.seams),
      );
      assert.equal(lookups, 2);
      assert.deepEqual(publishing.sleeps, []);
      assert.equal(
        publishing.calls.filter(({ arguments_ }) => arguments_[1] === "publish")
          .length,
        0,
      );
    });
  }
});

test("publication polling is bounded even when the clock does not advance", async (t) => {
  const prepared = await fixture(t);
  const state = fakeRegistry(prepared, []);
  const publishing = publisher(prepared, state);
  publishing.seams.now = () => 0;
  state.metadata = () => jsonResponse({}, 404);
  await assert.rejects(
    publishPreparedRelease(prepared.options, publishing.seams),
    /check npm scanning or review status/,
  );
  // Two pre-upload lookups, then at most 41 post-upload lookups.
  assert.equal(state.requests.length, 43);
  assert.equal(publishing.sleeps.length, 40);
});

test("publication checks visibility after the final scheduled sleep", async (t) => {
  for (const [name, lookupLatency, timerOvershoot] of [
    ["instant lookups", 0, 0],
    ["lookup latency", 30_000, 0],
    ["final timer overshoot", 0, 1],
  ]) {
    await t.test(name, async (t) => {
      const prepared = await fixture(t);
      const state = fakeRegistry(prepared, []);
      const publishing = publisher(prepared, state);
      const originalNow = publishing.seams.now;
      const originalSleep = publishing.seams.sleep;
      let lookupTime = 0;
      let overshoot = 0;
      const postUploadLookups = [];
      publishing.seams.now = () => originalNow() + lookupTime + overshoot;
      publishing.seams.sleep = async (milliseconds) => {
        await originalSleep(milliseconds);
        if (publishing.seams.now() === 20 * 60_000) overshoot += timerOvershoot;
      };
      state.metadata = () => {
        if (
          !publishing.calls.some(
            ({ arguments_ }) => arguments_[1] === "publish",
          )
        )
          return undefined;
        postUploadLookups.push(publishing.seams.now());
        lookupTime += lookupLatency;
        return publishing.seams.now() < 19 * 60_000 + 45_000
          ? jsonResponse({ error: "Not found" }, 404)
          : undefined;
      };
      const result = await publishPreparedRelease(
        prepared.options,
        publishing.seams,
      );
      const polls = lookupLatency === 0 ? 41 : 21;
      assert.deepEqual(
        postUploadLookups.slice(0, -1),
        Array.from(
          { length: polls },
          (_, index) =>
            index * (30_000 + lookupLatency) +
            (index === polls - 1 ? timerOvershoot : 0),
        ),
      );
      // The extra lookup is the unchanged independent post-poll byte check.
      assert.equal(postUploadLookups.length, polls + 1);
      assert.equal(publishing.sleeps.length, polls - 1);
      assert.equal(
        publishing.calls.filter(({ arguments_ }) => arguments_[1] === "publish")
          .length,
        1,
      );
      assert.equal(result.verified, true);
      assert.deepEqual(result.skipped, []);
      assert.deepEqual(
        result.published,
        prepared.artifacts.map(({ name }) => name),
      );
    });
  }
});

test("production polling deadline ignores forward and backward wall-clock adjustments", async (t) => {
  for (const direction of [1, -1]) {
    await t.test(direction === 1 ? "forward" : "backward", async (t) => {
      const prepared = await fixture(t);
      const state = fakeRegistry(prepared, []);
      const publishing = publisher(prepared, state);
      const originalSleep = publishing.seams.sleep;
      let elapsed = 0;
      let wall = Date.now();
      let lookups = 0;
      delete publishing.seams.now;
      t.mock.method(performance, "now", () => elapsed);
      t.mock.method(Date, "now", () => wall);
      publishing.seams.sleep = async (milliseconds) => {
        await originalSleep(milliseconds);
        elapsed += milliseconds;
        wall += milliseconds + direction * 60 * 60_000;
      };
      state.metadata = () => {
        if (
          publishing.calls.some(({ arguments_ }) => arguments_[1] === "publish")
        ) {
          elapsed += 30_000;
          wall += 30_000;
          lookups += 1;
        }
        return jsonResponse({}, 404);
      };
      await assert.rejects(
        publishPreparedRelease(prepared.options, publishing.seams),
        /check npm scanning or review status/,
      );
      assert.equal(elapsed, 20 * 60_000 + 30_000);
      assert.equal(lookups, 21);
      assert.equal(publishing.sleeps.length, 20);
      assert.equal(
        publishing.calls.filter(({ arguments_ }) => arguments_[1] === "publish")
          .length,
        1,
      );
    });
  }
});

test("publication polling counts lookup time toward its deadline", async (t) => {
  const prepared = await fixture(t);
  const state = fakeRegistry(prepared, []);
  const publishing = publisher(prepared, state);
  const originalNow = publishing.seams.now;
  let lookupTime = 0;
  let lookups = 0;
  publishing.seams.now = () => originalNow() + lookupTime;
  state.metadata = () => {
    if (
      publishing.calls.some(({ arguments_ }) => arguments_[1] === "publish")
    ) {
      lookupTime += 30_000;
      lookups += 1;
    }
    return jsonResponse({}, 404);
  };
  await assert.rejects(
    publishPreparedRelease(prepared.options, publishing.seams),
    /check npm scanning or review status/,
  );
  assert.equal(publishing.seams.now(), 20 * 60_000 + 30_000);
  assert.equal(lookups, 21);
  assert.equal(publishing.sleeps.length, 20);
});

test("privileged publication requires the exact hosted release workflow identity and rejects inherited npm authority", () => {
  assert.doesNotThrow(() =>
    assertTrustedPublishingEnvironment(trustedEnvironment(), identity),
  );
  for (const [key, value] of Object.entries({
    GITHUB_ACTIONS: "false",
    GITHUB_EVENT_NAME: "workflow_dispatch",
    GITHUB_REPOSITORY: "other/agent-access",
    GITHUB_SERVER_URL: "https://example.invalid",
    GITHUB_REF: "refs/heads/main",
    GITHUB_SHA: "b".repeat(40),
    GITHUB_WORKFLOW_REF: "other/workflow@refs/heads/main",
    GITHUB_WORKFLOW_SHA: "b".repeat(40),
    RUNNER_ENVIRONMENT: "self-hosted",
    ACTIONS_ID_TOKEN_REQUEST_URL: "https://example.invalid/oidc",
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: "",
    NPM_TOKEN: "synthetic-token",
    NODE_AUTH_TOKEN: "synthetic-token",
    NPM_AUTH_TOKEN: "synthetic-token",
    YARN_NPM_AUTH_TOKEN: "synthetic-token",
    npm_config_registry: "https://example.invalid/",
    NPM_CONFIG_USERCONFIG: "synthetic-npmrc",
  })) {
    assert.throws(() =>
      assertTrustedPublishingEnvironment(
        { ...trustedEnvironment(), [key]: value },
        identity,
      ),
    );
  }
});

// This report is a unit seam for successful `npm audit signatures`, never a
// Sigstore trust proof. The synthetic certificate only exercises identity
// parsing; the real readonly verifier must run npm's cryptographic audit first.
function provenanceAudit(manifest) {
  return {
    invalid: [],
    missing: [],
    verified: manifest.artifacts.map((record) => {
      const statement = {
        _type: "https://in-toto.io/Statement/v1",
        predicateType: "https://slsa.dev/provenance/v1",
        subject: [
          {
            name: `pkg:npm/${record.name.split("/").map(encodeURIComponent).join("/")}@${record.version}`,
            digest: {
              sha512: Buffer.from(record.integrity.slice(7), "base64").toString(
                "hex",
              ),
            },
          },
        ],
        predicate: {
          buildDefinition: {
            buildType:
              "https://slsa-framework.github.io/github-actions-buildtypes/workflow/v1",
            externalParameters: {
              workflow: {
                repository: "https://github.com/pegma-dev/agent-access",
                path: RELEASE_WORKFLOW,
                ref: `refs/tags/${identity.tag}`,
              },
            },
            internalParameters: { github: { event_name: "release" } },
            resolvedDependencies: [
              {
                uri: `git+https://github.com/pegma-dev/agent-access@refs/tags/${identity.tag}`,
                digest: { gitCommit: identity.commit },
              },
            ],
          },
          runDetails: {
            builder: { id: "https://github.com/actions/runner/github-hosted" },
          },
        },
      };
      return {
        name: record.name,
        version: record.version,
        location: `node_modules/${record.name}`,
        registry,
        attestationBundles: [
          {
            predicateType: "https://slsa.dev/provenance/v1",
            bundle: {
              verificationMaterial: {
                certificate: { rawBytes: syntheticCertificate() },
              },
              dsseEnvelope: {
                payloadType: "application/vnd.in-toto+json",
                payload: Buffer.from(JSON.stringify(statement)).toString(
                  "base64",
                ),
              },
            },
          },
        ],
      };
    }),
  };
}

test("cryptographically verified provenance must still bind every prepared package to the exact source workflow", async (t) => {
  const prepared = await fixture(t);
  assert.doesNotThrow(() =>
    verifyProvenanceAudit(
      provenanceAudit(prepared.verified.manifest),
      prepared.verified.manifest,
    ),
  );
  const changes = [
    [
      "missing package",
      (audit) => {
        audit.verified.pop();
      },
    ],
    [
      "invalid signature",
      (audit) => {
        audit.invalid.push({ name: "synthetic" });
      },
    ],
    [
      "missing attestation",
      (audit) => {
        audit.missing.push({ name: "synthetic" });
      },
    ],
    [
      "duplicate package",
      (audit) => {
        audit.verified.push(audit.verified[0]);
      },
    ],
    [
      "foreign registry",
      (audit) => {
        audit.verified[0].registry = "https://example.invalid/";
      },
    ],
    [
      "absent source bundle",
      (audit) => {
        audit.verified[0].attestationBundles = [];
      },
    ],
    [
      "missing certificate",
      (audit) => {
        delete audit.verified[0].attestationBundles[0].bundle
          .verificationMaterial;
      },
    ],
    [
      "wrong certificate workflow",
      (audit) => {
        audit.verified[0].attestationBundles[0].bundle.verificationMaterial.certificate.rawBytes =
          syntheticCertificate({ workflow: ".github/workflows/other.yml" });
      },
    ],
    [
      "wrong certificate repository",
      (audit) => {
        audit.verified[0].attestationBundles[0].bundle.verificationMaterial.certificate.rawBytes =
          syntheticCertificate({ repository: "other/agent-access" });
      },
    ],
    [
      "wrong certificate tag",
      (audit) => {
        audit.verified[0].attestationBundles[0].bundle.verificationMaterial.certificate.rawBytes =
          syntheticCertificate({ tag: "v0.3.0" });
      },
    ],
    [
      "wrong certificate issuer",
      (audit) => {
        audit.verified[0].attestationBundles[0].bundle.verificationMaterial.certificate.rawBytes =
          syntheticCertificate({ issuer: "https://example.invalid" });
      },
    ],
  ];
  for (const [name, change] of changes) {
    const audit = provenanceAudit(prepared.verified.manifest);
    change(audit);
    assert.throws(
      () => verifyProvenanceAudit(audit, prepared.verified.manifest),
      undefined,
      name,
    );
  }
  for (const [name, change] of [
    [
      "wrong commit",
      (statement) => {
        statement.predicate.buildDefinition.resolvedDependencies[0].digest.gitCommit =
          "b".repeat(40);
      },
    ],
    [
      "wrong tag",
      (statement) => {
        statement.predicate.buildDefinition.externalParameters.workflow.ref =
          "refs/tags/v0.3.0";
      },
    ],
    [
      "wrong workflow",
      (statement) => {
        statement.predicate.buildDefinition.externalParameters.workflow.path =
          ".github/workflows/other.yml";
      },
    ],
    [
      "wrong repository",
      (statement) => {
        statement.predicate.buildDefinition.externalParameters.workflow.repository =
          "https://github.com/other/agent-access";
      },
    ],
    [
      "wrong artifact digest",
      (statement) => {
        statement.subject[0].digest.sha512 = "0".repeat(128);
      },
    ],
    [
      "self hosted builder",
      (statement) => {
        statement.predicate.runDetails.builder.id = "synthetic-self-hosted";
      },
    ],
  ]) {
    const audit = provenanceAudit(prepared.verified.manifest);
    const envelope =
      audit.verified[0].attestationBundles[0].bundle.dsseEnvelope;
    const statement = JSON.parse(
      Buffer.from(envelope.payload, "base64").toString("utf8"),
    );
    change(statement);
    envelope.payload = Buffer.from(JSON.stringify(statement)).toString(
      "base64",
    );
    assert.throws(
      () => verifyProvenanceAudit(audit, prepared.verified.manifest),
      undefined,
      name,
    );
  }
});

test("registry verification uses exact released dependencies, script-free installation, public imports, and npm signature audit", async (t) => {
  const prepared = await fixture(t);
  const state = fakeRegistry(prepared);
  const operations = [];
  const result = await verifyRegistryRelease(prepared.options, {
    fetch: state.fetch,
    env: {
      SYNTHETIC_SOURCE_SECRET: "must-not-reach-consumer",
      NPM_TOKEN: "must-not-reach-consumer",
      NODE_AUTH_TOKEN: "must-not-reach-consumer",
      NODE_OPTIONS: "--require=synthetic-untrusted-hook.cjs",
      NPM_CONFIG_USERCONFIG: "synthetic-project-npmrc",
      npm_config_registry: "https://example.invalid/",
    },
    run: async (command, arguments_, { cwd, env }) => {
      assert.equal(command, process.execPath);
      assert.equal(env.SYNTHETIC_SOURCE_SECRET, undefined);
      assert.equal(env.NPM_TOKEN, undefined);
      assert.equal(env.NODE_AUTH_TOKEN, undefined);
      assert.equal(env.NODE_OPTIONS, undefined);
      assert.equal(env.NPM_CONFIG_USERCONFIG, undefined);
      assert.equal(env.npm_config_registry, registry);
      assert.equal(env.npm_config_ignore_scripts, "true");
      for (const key of ["npm_config_userconfig", "npm_config_globalconfig"]) {
        assert.equal(dirname(env[key]), cwd);
        assert.equal(await readFile(env[key], "utf8"), "");
      }
      assert.equal(dirname(env.npm_config_cache), cwd);
      const operation =
        arguments_[0] === prepared.options.npmCli
          ? arguments_[1]
          : "public-imports";
      operations.push(operation);
      if (operation === "--version") return { status: 0, stdout: "11.18.0\n" };
      if (operation === "install") {
        assert.deepEqual(arguments_.slice(1), [
          "install",
          "--ignore-scripts",
          "--no-audit",
          "--no-fund",
          "--registry",
          registry,
        ]);
        const consumer = JSON.parse(
          await readFile(join(cwd, "package.json"), "utf8"),
        );
        assert.deepEqual(
          consumer.dependencies,
          Object.fromEntries(
            prepared.artifacts.map(({ name, version }) => [name, version]),
          ),
        );
        await writeFile(
          join(cwd, "package-lock.json"),
          JSON.stringify({
            packages: Object.fromEntries(
              prepared.artifacts.map((record) => [
                `node_modules/${record.name}`,
                {
                  version: record.version,
                  integrity: record.integrity,
                  resolved: tarballUrl(record),
                },
              ]),
            ),
          }),
        );
        return { status: 0, stdout: "" };
      }
      if (operation === "public-imports") {
        const source = await readFile(arguments_[0], "utf8");
        for (const { name } of prepared.artifacts)
          assert.ok(source.includes(name));
        return { status: 0, stdout: "" };
      }
      assert.equal(operation, "audit");
      assert.deepEqual(arguments_.slice(1), [
        "audit",
        "signatures",
        "--json",
        "--include-attestations",
        "--registry",
        registry,
      ]);
      return {
        status: 0,
        stdout: JSON.stringify(provenanceAudit(prepared.verified.manifest)),
      };
    },
  });
  assert.deepEqual(operations, [
    "--version",
    "install",
    "audit",
    "public-imports",
  ]);
  assert.deepEqual(
    result.packages,
    prepared.artifacts.map(({ name }) => name),
  );
  assert.equal(result.verified, true);
});

test("registry verification stops before npm when any release package is absent", async (t) => {
  const prepared = await fixture(t);
  const state = fakeRegistry(
    prepared,
    prepared.artifacts.slice(0, 0).map(({ name }) => name),
  );
  const publishing = publisher(prepared, state);
  await assert.rejects(
    verifyRegistryRelease(prepared.options, publishing.seams),
    /complete release set/u,
  );
  assert.equal(publishing.calls.length, 0);
});

test("local prepared blob tampering fails before registry access or npm execution", async (t) => {
  const prepared = await fixture(t);
  const state = fakeRegistry(prepared, []);
  const publishing = publisher(prepared, state);
  await writeFile(
    prepared.verified.artifacts[0].path,
    "unreviewed prepared bytes",
  );
  await assert.rejects(
    publishPreparedRelease(prepared.options, publishing.seams),
  );
  assert.equal(state.requests.length, 0);
  assert.equal(publishing.calls.length, 0);
});

test("the snapshot blob is rehashed before privileged publication", async (t) => {
  const prepared = await fixture(t);
  const state = fakeRegistry(prepared, []);
  const publishing = publisher(prepared, state);
  const originalRun = publishing.seams.run;
  publishing.seams.run = async (...arguments_) => {
    const result = await originalRun(...arguments_);
    if (arguments_[1][1] === "--version") {
      const record = prepared.verified.artifacts[0];
      const bytes = Buffer.from(prepared.blobs.get(record.name));
      bytes[0] ^= 1;
      await writeFile(record.path, bytes);
    }
    return result;
  };
  await assert.rejects(
    publishPreparedRelease(prepared.options, publishing.seams),
    /changed after verification/u,
  );
  assert.equal(
    publishing.calls.some(({ arguments_ }) => arguments_[1] === "publish"),
    false,
  );
});

test("a linked npm CLI ancestor is rejected before any npm subprocess", async (t) => {
  for (const mode of ["publish", "verify"]) {
    await t.test(mode, async (t) => {
      const prepared = await fixture(t);
      const canonicalDirectory = join(prepared.directory, "canonical-npm");
      await mkdir(canonicalDirectory);
      await writeFile(
        join(canonicalDirectory, "npm-cli.js"),
        "// Synthetic seam: never executed.\n",
      );
      const linkedDirectory = join(prepared.directory, "linked-npm");
      await symlink(
        canonicalDirectory,
        linkedDirectory,
        process.platform === "win32" ? "junction" : "dir",
      );
      const options = {
        ...prepared.options,
        npmCli: join(linkedDirectory, "npm-cli.js"),
      };
      const state = fakeRegistry(prepared, mode === "publish" ? [] : undefined);
      const calls = [];
      const operation =
        mode === "publish" ? publishPreparedRelease : verifyRegistryRelease;
      await assert.rejects(
        operation(options, {
          env: trustedEnvironment(),
          fetch: state.fetch,
          run: async (...arguments_) => {
            calls.push(arguments_);
            throw new Error("Unexpected npm subprocess.");
          },
        }),
        /pinned npm CLI/u,
      );
      assert.deepEqual(calls, []);
      assert.equal(
        state.present.size,
        mode === "publish" ? 0 : prepared.artifacts.length,
      );
    });
  }
});

test("an unexpected npm version cannot publish any prepared package", async (t) => {
  const prepared = await fixture(t);
  const state = fakeRegistry(prepared, []);
  const publishing = publisher(prepared, state);
  publishing.seams.run = async () => ({ status: 0, stdout: "11.17.0\n" });
  await assert.rejects(
    publishPreparedRelease(prepared.options, publishing.seams),
    /pinned npm CLI/u,
  );
  assert.equal(state.present.size, 0);
});

test("the supported certificate-chain attestation shape binds the same source identity", async (t) => {
  const prepared = await fixture(t);
  const audit = provenanceAudit(prepared.verified.manifest);
  audit.verified[0].attestationBundles[0].bundle.verificationMaterial = {
    x509CertificateChain: {
      certificates: [{ rawBytes: syntheticCertificate() }],
    },
  };
  assert.doesNotThrow(() =>
    verifyProvenanceAudit(audit, prepared.verified.manifest),
  );
});

test("consumer lock and provenance failures stop verification before package runtime imports", async (t) => {
  for (const problem of [
    "wrong version",
    "workspace link",
    "wrong integrity",
    "foreign tarball",
    "invalid crypto audit",
    "wrong provenance source",
  ]) {
    await t.test(problem, async (t) => {
      const prepared = await fixture(t);
      const state = fakeRegistry(prepared);
      const operations = [];
      await assert.rejects(
        verifyRegistryRelease(prepared.options, {
          fetch: state.fetch,
          env: {},
          run: async (_command, arguments_, { cwd }) => {
            const operation =
              arguments_[0] === prepared.options.npmCli
                ? arguments_[1]
                : "public-imports";
            operations.push(operation);
            if (operation === "--version")
              return { status: 0, stdout: "11.18.0\n" };
            if (operation === "install") {
              const packages = Object.fromEntries(
                prepared.artifacts.map((record) => [
                  `node_modules/${record.name}`,
                  {
                    version: record.version,
                    integrity: record.integrity,
                    resolved: tarballUrl(record),
                  },
                ]),
              );
              const installed =
                packages[`node_modules/${prepared.artifacts[0].name}`];
              if (problem === "wrong version") installed.version = "0.3.0";
              if (problem === "workspace link") installed.link = true;
              if (problem === "wrong integrity")
                installed.integrity = "sha512-unreviewed";
              if (problem === "foreign tarball")
                installed.resolved = "https://example.invalid/foreign.tgz";
              await writeFile(
                join(cwd, "package-lock.json"),
                JSON.stringify({ packages }),
              );
              return { status: 0, stdout: "" };
            }
            assert.equal(
              operation,
              "audit",
              "package imports cannot precede a valid exact provenance audit",
            );
            if (problem === "invalid crypto audit")
              return { status: 1, stdout: "synthetic failure" };
            const audit = provenanceAudit(prepared.verified.manifest);
            audit.verified[0].attestationBundles[0].bundle.verificationMaterial.certificate.rawBytes =
              syntheticCertificate({ workflow: ".github/workflows/other.yml" });
            return { status: 0, stdout: JSON.stringify(audit) };
          },
        }),
      );
      assert.equal(operations.includes("public-imports"), false);
      assert.deepEqual(
        operations,
        [
          "wrong version",
          "workspace link",
          "wrong integrity",
          "foreign tarball",
        ].includes(problem)
          ? ["--version", "install"]
          : ["--version", "install", "audit"],
      );
    });
  }
});
