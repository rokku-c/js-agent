// view.test.js — scoped resource authorization at the JavaScript facade.
import { test } from "node:test";
import assert from "node:assert/strict";
import { namespace } from "./helpers.js";
import { createView } from "../src/kernel/view.js";

const all = ["stat", "list", "read", "write", "mkdir", "remove", "rename"];
const grant = (path, operations = all) => ({ path, operations });

async function seeded() {
  const vfs = await namespace();
  await vfs.mkdir("/public");
  await vfs.mkdir("/private");
  await vfs.mkdir("/publicity");
  await vfs.write("/public/read.txt", "public", { create: true });
  await vfs.write("/private/secret.txt", "secret", { create: true });
  return vfs;
}

test("view: defaults to deny and normalizes traversal without sibling confusion", async () => {
  const vfs = await seeded();
  const view = createView(vfs, { grants: [grant("/public/**", ["stat", "read"])] });

  assert.equal(await view.read("/public/./read.txt"), "public");
  await assert.rejects(() => view.read("/public/../private/secret.txt"), { code: "EACCES" });
  await assert.rejects(() => view.read("/publicity/read.txt"), { code: "EACCES" });
  await assert.rejects(() => view.stat("/private/secret.txt"), { code: "EACCES" });
  await assert.rejects(() => view.exists("/private/secret.txt"), { code: "EACCES" });
  await assert.rejects(() => view.read("/public/missing.txt"), { code: "ENOENT" });
});

test("view: list exposes only entries authorized by at least one operation", async () => {
  const vfs = await seeded();
  await vfs.write("/public/visible.txt", "visible", { create: true });
  await vfs.write("/public/hidden.txt", "hidden", { create: true });
  const view = createView(vfs, {
    grants: [grant("/public", ["list"]), grant("/public/visible.txt", ["read"])],
  });

  assert.deepEqual((await view.list("/public")).map((entry) => entry.name), ["visible.txt"]);
});

test("view: derivation intersects grants and cannot be widened or mutated", async () => {
  const vfs = await seeded();
  const parentGrants = [grant("/public/**", ["stat", "read", "write"]), grant("/private", ["stat"] )];
  const view = createView(vfs, { grants: parentGrants });
  const childGrants = [grant("/public/**", ["read"]), grant("/private/**", ["read"] )];
  const child = view.derive({ grants: childGrants });

  parentGrants[0].path = "/private/**";
  parentGrants[0].operations.push("remove");
  childGrants[0].operations.push("write");

  assert.equal(await child.read("/public/read.txt"), "public");
  await assert.rejects(() => child.write("/public/read.txt", "changed"), { code: "EACCES" });
  await assert.rejects(() => child.read("/private/secret.txt"), { code: "EACCES" });
  await assert.rejects(() => child.stat("/private"), { code: "EACCES" });

  const description = child.describe();
  assert.deepEqual(description, { grants: [{ path: "/public/**", operations: ["read"] }] });
  description.grants[0].operations.push("write");
  assert.deepEqual(child.describe(), { grants: [{ path: "/public/**", operations: ["read"] }] });
});

test("view: checks both rename paths and mkdirp ancestors before mutating", async () => {
  const vfs = await seeded();
  const view = createView(vfs, {
    grants: [
      grant("/public/**", ["stat", "mkdir", "rename", "write"]),
      grant("/new/deep", ["stat", "mkdir"]),
    ],
  });

  await assert.rejects(() => view.rename("/public/read.txt", "/private/moved.txt"), { code: "EACCES" });
  assert.equal(await vfs.exists("/public/read.txt"), true);
  assert.equal(await vfs.exists("/private/moved.txt"), false);

  await assert.rejects(() => view.mkdirp("/new/deep"), { code: "EACCES" });
  assert.equal(await vfs.exists("/new"), false);

  await view.mkdirp("/public/nested/dir");
  assert.equal(await vfs.exists("/public/nested/dir"), true);
});

test("view: forwards resource arguments and exposes no driver or handle escape", async () => {
  const calls = [];
  const resource = {
    async stat(path, options) { calls.push(["stat", path, options]); return { type: "file" }; },
    async list(path, options) { calls.push(["list", path, options]); return [{ name: "item" }]; },
    async read(path, options) { calls.push(["read", path, options]); return "ok"; },
    async write(path, value, options) { calls.push(["write", path, value, options]); return { bytes: 2 }; },
    async exists(path, options) { calls.push(["exists", path, options]); return true; },
    async mkdir(path, options) { calls.push(["mkdir", path, options]); },
    async remove(path, options) { calls.push(["remove", path, options]); },
    async rename(from, to, options) { calls.push(["rename", from, to, options]); },
  };
  const view = createView(resource, { grants: [grant("/x", all), grant("/dir/**", ["list"])] });
  const signal = { aborted: false };
  const options = { signal, encoding: "utf8" };

  await view.read("x", options);
  await view.write("/x", "hi", options);
  await view.exists("/x", options);
  await view.list("/dir", options);
  assert.deepEqual(calls.slice(0, 4), [
    ["read", "/x", options],
    ["write", "/x", "hi", options],
    ["exists", "/x", options],
    ["list", "/dir", options],
  ]);
  assert.equal(view.resolve, undefined);
  assert.equal(view.mount, undefined);
  assert.equal(view.open, undefined);
  assert.equal(typeof view.invoke, "function");
  assert.equal(view.vfs, undefined);
});

test("view: rejects unsupported grant glob syntax", () => {
  const resource = { stat() {} };
  for (const path of ["relative", "/a/*", "/a/**/b", "/a/**/"]) {
    assert.throws(() => createView(resource, { grants: [grant(path, ["stat"])] }), { code: "EINVAL" });
  }
});

test("view: listing redacts metadata unless child stat is granted", async () => {
  const vfs = await seeded();
  const view = createView(vfs, {
    grants: [grant("/public", ["list"]), grant("/public/read.txt", ["read"])],
  });
  const entry = (await view.list("/public")).find((item) => item.name === "read.txt");
  assert.deepEqual(entry, { name: "read.txt" });
});

test("view: recursive and directory-wide mutations require subtree grants", async () => {
  const vfs = await seeded();
  const exact = createView(vfs, {
    grants: [grant("/private", ["remove", "rename"]), grant("/public", ["rename"])],
  });
  await assert.rejects(() => exact.remove("/private", { recursive: true }), /subtree authority/);
  await assert.rejects(() => exact.rename("/public", "/private"), /subtree authority/);
  assert.equal(await vfs.exists("/private/secret.txt"), true);
});
