import { describe, it, expect, vi } from "vitest";
import { checkAncestry } from "@/server/policy";
import { FOLDER, SHORTCUT, type DriveFile } from "@/server/google";
import { encrypt, decrypt, hash } from "@/server/crypto";
import { makeSession, validSession } from "@/server/auth";
import { boundedBody } from "@/server/body";
import { sliceStream, utf8Prefix } from "@/server/content";
import { allowedGoogleUrl } from "@/server/google";
import { writeNative } from "@/server/native";
const root = { folder_id: "root", name: "Approved", can_write: true };
const files: Record<string, DriveFile> = {
  root: { id: "root", name: "Approved", mimeType: FOLDER },
  child: { id: "child", name: "Child", mimeType: FOLDER, parents: ["root"] },
  file: {
    id: "file",
    name: "File",
    mimeType: "text/plain",
    parents: ["child"],
  },
  outside: {
    id: "outside",
    name: "Outside",
    mimeType: "text/plain",
    parents: ["other"],
  },
  other: { id: "other", name: "Other", mimeType: FOLDER },
  shortcut: {
    id: "shortcut",
    name: "Shortcut",
    mimeType: SHORTCUT,
    parents: ["root"],
  },
  trash: {
    id: "trash",
    name: "Trash",
    mimeType: "text/plain",
    parents: ["root"],
    trashed: true,
  },
  loop: { id: "loop", name: "Loop", mimeType: FOLDER, parents: ["loop"] },
};
const drive = { metadata: vi.fn(async (id: string) => files[id]) };
describe("Drive authorization boundary", () => {
  it("accepts descendants by ancestry", async () =>
    expect((await checkAncestry(drive, "file", [root], true, true)).id).toBe(
      "file",
    ));
  it.each(["outside", "shortcut", "trash", "loop"])(
    "rejects %s",
    async (id) => {
      await expect(
        checkAncestry(drive, id, [root], false, false),
      ).rejects.toThrow();
    },
  );
  it("denies a write through a read-only root", async () =>
    expect(
      checkAncestry(drive, "file", [{ ...root, can_write: false }], true, true),
    ).rejects.toThrow("OUTSIDE_APPROVED_FOLDERS"));
  it("denies a write from a read-only client", async () =>
    expect(checkAncestry(drive, "file", [root], true, false)).rejects.toThrow(
      "WRITE_DENIED",
    ));
  it("rechecks when a file is moved", async () => {
    const changing = {
      metadata: vi.fn(async (id: string) =>
        id === "file" ? { ...files.file, parents: ["other"] } : files[id],
      ),
    };
    await expect(
      checkAncestry(changing, "file", [root], false, false),
    ).rejects.toThrow("OUTSIDE_APPROVED_FOLDERS");
  });
});
describe("credentials and transfers", () => {
  it("paginates UTF-8 without losing BOMs or splitting characters", () => {
    const bytes = Buffer.from("\ufeffa😀b");
    const first = utf8Prefix(bytes.subarray(0, 6), true);
    expect(first.content).toBe("\ufeffa");
    expect(first.consumed).toBe(4);
    expect(utf8Prefix(bytes.subarray(first.consumed), false).content).toBe(
      "😀b",
    );
  });
  it("encrypts secrets and rejects tampering", () => {
    const value = encrypt("refresh-secret");
    expect(value).not.toContain("refresh-secret");
    expect(decrypt(value)).toBe("refresh-secret");
    const bytes = Buffer.from(value, "base64");
    bytes[20] ^= 1;
    expect(() => decrypt(bytes.toString("base64"))).toThrow();
  });
  it("rejects modified or expired sessions", () => {
    const session = makeSession();
    expect(validSession(session)).toBe(true);
    expect(validSession(session + "x")).toBe(false);
    expect(validSession("0.abc.signature")).toBe(false);
    expect(hash(session)).not.toBe(session);
  });
  it("bounds streaming requests with no content-length", async () => {
    const request = new Request("http://localhost", {
      method: "POST",
      body: "x".repeat(50),
    });
    await expect(boundedBody(request, 20)).rejects.toThrow("PAYLOAD_TOO_LARGE");
  });
  it("extracts bounded stream slices", async () => {
    const response = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("abcdef"));
          controller.enqueue(new TextEncoder().encode("ghijkl"));
          controller.close();
        },
      }),
    );
    expect((await sliceStream(response, 4, 5)).toString()).toBe("efghi");
  });
  it.each([
    "https://evil.test/upload",
    "http://www.googleapis.com/upload",
    "https://www.googleapis.com@evil.test/upload",
  ])("denies credential forwarding to %s", (value) =>
    expect(() => allowedGoogleUrl(value)).toThrow("GOOGLE_URL_DENIED"),
  );
  it("rejects unapproved native mutations before sending", async () => {
    const api = { json: vi.fn() };
    await expect(
      writeNative(api as never, "doc", "slides", {
        revisionId: "r1",
        requests: [{ createImage: { url: "https://external.example" } }],
      }),
    ).rejects.toThrow("NATIVE_REQUEST_UNSUPPORTED");
    expect(api.json).not.toHaveBeenCalled();
  });
});
