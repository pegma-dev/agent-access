import {
  createProtectedResourceAuthenticator,
  OAuthError,
} from "@pegma/agent-access";
import { createMemoryStore } from "@pegma/storage-core";
import { describe, expect, it } from "vitest";
import { READ, RESOURCE, WRITE, fixture } from "../test/fixtures.js";

const BOUNDARY = "synthetic-upload-boundary";
/** Documented multipart bounds: 1 MiB default, 16 MiB ceiling. */
const DEFAULT_MULTIPART_MAX_BYTES = 1_048_576;
const MAX_MULTIPART_BYTES = 16_777_216;
const UPLOAD = `${RESOURCE}/uploads`;

function multipartBody(
  parts: readonly { name: string; value: string; filename?: string }[],
): string {
  return (
    parts
      .map(
        (part) =>
          `--${BOUNDARY}\r\nContent-Disposition: form-data; name="${part.name}"` +
          (part.filename === undefined
            ? ""
            : `; filename="${part.filename}"\r\nContent-Type: text/plain`) +
          `\r\n\r\n${part.value}\r\n`,
      )
      .join("") + `--${BOUNDARY}--\r\n`
  );
}

function upload(
  token: string | undefined,
  body: BodyInit | null,
  headers: Record<string, string> = {},
): Request {
  return new Request(UPLOAD, {
    method: "POST",
    headers: {
      "content-type": `multipart/form-data; boundary=${BOUNDARY}`,
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
      ...headers,
    },
    body,
    ...(body instanceof ReadableStream ? { duplex: "half" } : {}),
  } as RequestInit);
}

/** A body that records how many chunks the authenticator actually pulled. */
function countingStream(chunks: number, chunkBytes: number) {
  const state = { pulled: 0, cancelled: false };
  const prefix = new TextEncoder().encode(
    `--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="a.txt"\r\n\r\n`,
  );
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      state.pulled += 1;
      if (state.pulled === 1) controller.enqueue(prefix);
      else if (state.pulled <= chunks)
        controller.enqueue(new Uint8Array(chunkBytes).fill(0x61));
      else controller.close();
    },
    cancel() {
      state.cancelled = true;
    },
  });
  return { stream, state };
}

async function setup(maxBytes?: number) {
  const world = fixture(createMemoryStore());
  const { tokens } = await world.completeDevice([READ]);
  const optedIn = createProtectedResourceAuthenticator({
    service: world.service,
    configuration: world.options.configuration,
    multipart: maxBytes === undefined ? {} : { maxBytes },
  });
  const standard = createProtectedResourceAuthenticator({
    service: world.service,
    configuration: world.options.configuration,
  });
  return { world, tokens, optedIn, standard };
}

async function errorOf(result: unknown) {
  if (!(result instanceof Response)) throw new Error("Expected a rejection");
  expect(result.headers.get("cache-control")).toContain("no-store");
  return {
    status: result.status,
    body: (await result.json()) as { error: string },
    challenge: result.headers.get("www-authenticate"),
  };
}

describe("opt-in bounded multipart bearer transport", () => {
  it("keeps rejecting multipart bodies when the host has not opted in", async () => {
    const { tokens, standard } = await setup();
    const request = upload(
      tokens.access_token,
      multipartBody([{ name: "file", value: "hello", filename: "a.txt" }]),
    );
    const rejected = await errorOf(
      await standard.authenticate(request, [READ]),
    );
    expect(rejected.status).toBe(400);
    expect(rejected.body.error).toBe("invalid_request");
    expect(request.bodyUsed).toBe(false);
  });

  it("accepts a header-bearer upload, returns its parsed form, and leaves the request readable", async () => {
    const { tokens, optedIn } = await setup();
    const form = new FormData();
    form.set("title", "Synthetic notes");
    form.set(
      "file",
      new Blob(["synthetic file body"], { type: "text/plain" }),
      "notes.txt",
    );
    const request = new Request(UPLOAD, {
      method: "POST",
      headers: { authorization: `Bearer ${tokens.access_token}` },
      body: form,
    });
    expect(request.headers.get("content-type")).toMatch(
      /^multipart\/form-data; boundary=/,
    );
    const result = await optedIn.authenticate(request, [READ]);
    if (result instanceof Response) throw new Error("Expected access");
    expect(result.scopes).toEqual([READ]);
    expect(result.access.roles).toEqual([]);
    expect(result.form?.get("title")).toBe("Synthetic notes");
    const file = result.form?.get("file");
    if (!(file instanceof Blob)) throw new Error("Expected parsed file");
    expect(await file.text()).toBe("synthetic file body");
    // The host may still read its own request instead of the handed-back form.
    expect(request.bodyUsed).toBe(false);
    const again = await request.formData();
    expect(again.get("title")).toBe("Synthetic notes");
  });

  it("does not attach a form to non-multipart requests and still enforces scope", async () => {
    const { tokens, optedIn } = await setup();
    const json = await optedIn.authenticate(
      new Request(UPLOAD, {
        method: "POST",
        headers: {
          authorization: `Bearer ${tokens.access_token}`,
          "content-type": "application/json",
        },
        body: "{}",
      }),
      [READ],
    );
    if (json instanceof Response) throw new Error("Expected access");
    expect(json.form).toBeUndefined();
    const insufficient = await errorOf(
      await optedIn.authenticate(
        upload(
          tokens.access_token,
          multipartBody([{ name: "title", value: "x" }]),
        ),
        [WRITE],
      ),
    );
    expect(insufficient.status).toBe(403);
    expect(insufficient.body.error).toBe("insufficient_scope");
  });

  it("rejects a declared oversized body before reading it", async () => {
    const { tokens, optedIn } = await setup(1_024);
    const { stream, state } = countingStream(4, 512);
    const request = upload(tokens.access_token, stream, {
      "content-length": "4096",
    });
    const rejected = await errorOf(await optedIn.authenticate(request, [READ]));
    expect(rejected.status).toBe(413);
    expect(rejected.body.error).toBe("invalid_request");
    expect(state.pulled).toBeLessThanOrEqual(1);
    for (const declared of ["-1", "1e3", "01", "abc"]) {
      const malformed = await errorOf(
        await optedIn.authenticate(
          upload(tokens.access_token, "x", { "content-length": declared }),
          [READ],
        ),
      );
      expect(malformed.status).toBe(400);
    }
  });

  it("cancels a streamed body once it exceeds the bound", async () => {
    const { tokens, optedIn } = await setup(2_048);
    const { stream, state } = countingStream(1_000, 512);
    const request = upload(tokens.access_token, stream);
    const rejected = await errorOf(await optedIn.authenticate(request, [READ]));
    expect(rejected.status).toBe(413);
    expect(rejected.body.error).toBe("invalid_request");
    // Only a few chunks past the bound are ever pulled, never the whole stream.
    expect(state.pulled).toBeLessThan(20);
  });

  it("rejects credential-bearing form parts and query credentials", async () => {
    const { tokens, optedIn } = await setup();
    const forbidden = [
      [{ name: "access_token", value: "sentinel-secret" }],
      [{ name: "Refresh_Token", value: "sentinel-secret" }],
      [{ name: "client_secret", value: "sentinel-secret" }],
      [{ name: "code_verifier", value: "sentinel-secret" }],
      [
        { name: "title", value: "ok" },
        { name: "notes", value: `prefix ${tokens.refresh_token} suffix` },
      ],
      [
        {
          name: "file",
          value: "content",
          filename: `${tokens.access_token}.txt`,
        },
      ],
    ];
    for (const parts of forbidden) {
      const request = upload(tokens.access_token, multipartBody(parts));
      const result = await optedIn.authenticate(request, [READ]);
      if (!(result instanceof Response))
        throw new Error("Expected credential rejection");
      const text = await result.clone().text();
      expect(text).not.toContain("sentinel-secret");
      expect(text).not.toContain(tokens.refresh_token);
      const rejected = await errorOf(result);
      expect(rejected.status).toBe(400);
      expect(rejected.body.error).toBe("invalid_request");
    }
    const query = await errorOf(
      await optedIn.authenticate(
        new Request(`${UPLOAD}?access_token=sentinel-secret`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${tokens.access_token}`,
            "content-type": `multipart/form-data; boundary=${BOUNDARY}`,
          },
          body: multipartBody([{ name: "title", value: "x" }]),
        }),
        [READ],
      ),
    );
    expect(query.status).toBe(400);
    const form = await errorOf(
      await optedIn.authenticate(
        new Request(UPLOAD, {
          method: "POST",
          headers: {
            authorization: `Bearer ${tokens.access_token}`,
            "content-type": "application/x-www-form-urlencoded",
          },
          body: "title=x",
        }),
        [READ],
      ),
    );
    expect(form.status).toBe(400);
  });

  it("rejects malformed multipart and missing or ambiguous boundaries predictably", async () => {
    const { tokens, optedIn } = await setup();
    for (const contentType of [
      "multipart/form-data",
      "multipart/form-data;",
      "multipart/form-data; charset=utf-8",
      `multipart/form-data; boundary=${BOUNDARY}; boundary=other`,
      'multipart/form-data; boundary=""',
      `multipart/form-data; boundary=${"b".repeat(71)}`,
      "multipart/form-data; boundary=bad\\boundary",
    ]) {
      const request = upload(
        tokens.access_token,
        multipartBody([{ name: "title", value: "x" }]),
        { "content-type": contentType },
      );
      const rejected = await errorOf(
        await optedIn.authenticate(request, [READ]),
      );
      expect(rejected.status).toBe(400);
      expect(rejected.body.error).toBe("invalid_request");
      expect(rejected.challenge).toContain('error="invalid_request"');
    }
    for (const body of [
      "not a multipart body",
      `--${BOUNDARY}\r\nContent-Disposition: form-data\r\n\r\nx\r\n`,
    ]) {
      const rejected = await errorOf(
        await optedIn.authenticate(upload(tokens.access_token, body), [READ]),
      );
      expect(rejected.status).toBe(400);
      expect(rejected.body.error).toBe("invalid_request");
    }
    const empty = await errorOf(
      await optedIn.authenticate(upload(tokens.access_token, null), [READ]),
    );
    expect(empty.status).toBe(400);
  });

  it("checks the bearer header before reading any multipart bytes", async () => {
    const { optedIn } = await setup();
    for (const token of [undefined, "sentinel-secret"]) {
      const { stream, state } = countingStream(4, 16);
      const request = upload(token, stream);
      const rejected = await errorOf(
        await optedIn.authenticate(request, [READ]),
      );
      expect(rejected.status).toBe(401);
      expect(rejected.challenge).toContain("resource_metadata=");
      expect(state.pulled).toBeLessThanOrEqual(1);
      expect(request.bodyUsed).toBe(false);
    }
  });

  it("validates the opt-in bound at construction", async () => {
    const world = fixture(createMemoryStore());
    for (const maxBytes of [0, -1, 1.5, MAX_MULTIPART_BYTES + 1, Number.NaN])
      expect(() =>
        createProtectedResourceAuthenticator({
          service: world.service,
          configuration: world.options.configuration,
          multipart: { maxBytes },
        }),
      ).toThrow(OAuthError);
    expect(DEFAULT_MULTIPART_MAX_BYTES).toBeLessThanOrEqual(
      MAX_MULTIPART_BYTES,
    );
    expect(() =>
      createProtectedResourceAuthenticator({
        service: world.service,
        configuration: world.options.configuration,
        multipart: { maxBytes: MAX_MULTIPART_BYTES },
      }),
    ).not.toThrow();
  });
});
