// vfs.test.js — the mount table, which is the whole boundary.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { namespace, tmpdir } from "./helpers.js";
import { VfsError } from "../src/kernel/errors.js";
import { Vfs } from "../src/kernel/vfs.js";

test("vfs: the floor a booted namespace stands on", async () => {
  const vfs = await namespace();
  const roots = (await vfs.list("/")).map((e) => e.name);
  assert.deepEqual(roots, ["bin", "dev", "proc", "tmp"]);
  // and nothing else — no home, no /etc, no network, no model
  for (const absent of ["/etc", "/home", "/dev/net", "/dev/providers"]) {
    assert.equal(await vfs.exists(absent), false, `${absent} must not exist until it is mounted`);
  }
});

test("vfs: a path under no mount at all names what is mounted", async () => {
  // with a root filesystem in place, /etc is simply a path the mem driver has never heard
  // of. the hint is for the case where there is nothing at all to have heard of it.
  const bare = new Vfs({ log: () => {} });
  await assert.rejects(() => bare.read("/etc/passwd"), (e) => {
    assert.ok(e instanceof VfsError);
    assert.equal(e.code, "ENOENT");
    assert.match(e.message, /nothing is mounted here/);
    assert.match(e.message, /the namespace is empty/);
    return true;
  });

  const vfs = await namespace();
  await assert.rejects(() => vfs.read("/etc/passwd"), (e) => {
    assert.equal(e.code, "ENOENT");
    assert.match(e.message, /path=\/etc\/passwd/);
    return true;
  });
});

test("vfs: longest mount point wins", async () => {
  const vfs = await namespace();
  await vfs.mount("mem", "/host", {});
  await vfs.write("/host/inner.txt", "outer", { create: true });
  await vfs.mount("mem", "/host/deep", {});
  await vfs.write("/host/deep/inner.txt", "inner", { create: true });
  assert.equal(await vfs.read("/host/inner.txt"), "outer");
  assert.equal(await vfs.read("/host/deep/inner.txt"), "inner");
  // and the two filesystems are genuinely separate
  assert.notEqual(vfs.resolve("/host/deep/x").mount, vfs.resolve("/host/y").mount);
});

test("vfs: an intermediate directory is synthesised from the mount below it", async () => {
  // /dev/providers does not exist until something is mounted under it, and a namespace
  // where `ls /dev` shows `providers` but `ls /dev/providers` says "no such device" is a
  // namespace that lies
  const vfs = await namespace();
  await vfs.mount("mem", "/dev/providers/ai", {});
  await vfs.mkdir("/dev/providers/ai/type");
  const dev = (await vfs.list("/dev")).map((e) => e.name);
  assert.ok(dev.includes("providers"), "/dev shows the mount point");
  const providers = await vfs.list("/dev/providers");
  assert.deepEqual(providers.map((e) => e.name), ["ai"]);
  assert.equal((await vfs.stat("/dev/providers")).type, "dir");
});

test("vfs: mounting twice is refused, and umount makes room", async () => {
  const vfs = await namespace();
  await assert.rejects(() => vfs.mount("mem", "/", {}), /EBUSY/);
  await vfs.mount("mem", "/data", {});
  await vfs.umount("/data");
  assert.equal(await vfs.exists("/data"), false);
  assert.rejects(() => vfs.umount("/data"), /ENOENT/);
});

test("vfs: writing to a file that is not there needs create", async () => {
  const vfs = await namespace();
  await assert.rejects(() => vfs.write("/new.txt", "x"), (e) => {
    assert.match(e.message, /file not found/);
    assert.match(e.message, /pass create=true/);
    return true;
  });
  await vfs.write("/new.txt", "x", { create: true });
  assert.equal(await vfs.read("/new.txt"), "x");
});

test("vfs: a device refuses append rather than quietly meaning overwrite", async () => {
  const vfs = await namespace();
  const st = await vfs.stat("/dev/null");
  assert.equal(st.device, false, "/dev/null is honest to treat as bytes");
  const rnd = await vfs.stat("/dev/random");
  assert.equal(rnd.device, true);
  assert.equal(rnd.appendable, false);
  await assert.rejects(() => vfs.write("/dev/random", "x", { append: true }), (e) => {
    assert.equal(e.code, "EINVAL");
    assert.match(e.message, /does not support append/);
    return true;
  });
});

test("vfs: a directory is not a file and says so both ways", async () => {
  const vfs = await namespace();
  await assert.rejects(() => vfs.read("/dev"), /EISDIR|is a directory/);
  await assert.rejects(() => vfs.write("/dev", "x", { create: true }), /is a directory/);
  await assert.rejects(() => vfs.list("/dev/null"), /not a directory/);
});

test("hostfs: read-only means read-only", async () => {
  const dir = await tmpdir();
  try {
    await fs.writeFile(path.join(dir.path, "a.txt"), "hello\n");
    const vfs = await namespace({ host: dir.path });
    assert.equal(await vfs.read("/host/a.txt"), "hello\n");
    await assert.rejects(() => vfs.write("/host/b.txt", "x", { create: true }), (e) => {
      assert.equal(e.code, "EACCES");
      assert.match(e.message, /read-only/);
      assert.match(e.message, /mode=rw/);
      return true;
    });
    assert.equal(await vfs.exists("/host/b.txt"), false);
  } finally {
    await dir.cleanup();
  }
});

test("hostfs: a path cannot escape its root, through .. or through a symlink", async () => {
  const root = await tmpdir();
  const outside = await tmpdir();
  try {
    await fs.writeFile(path.join(outside.path, "secret.txt"), "not yours");
    await fs.symlink(outside.path, path.join(root.path, "escape"));
    const vfs = await namespace({ host: root.path });

    await assert.rejects(() => vfs.read("/host/../escape/secret.txt"), (e) => {
      assert.ok(["EACCES", "ENOENT"].includes(e.code));
      return true;
    });
    // the lexical path is inside the mount; the realpath is not. that is the check.
    await assert.rejects(() => vfs.read("/host/escape/secret.txt"), (e) => {
      assert.equal(e.code, "EACCES");
      assert.match(e.message, /symlink resolves to/);
      return true;
    });
  } finally {
    await root.cleanup();
    await outside.cleanup();
  }
});

test("hostfs: rw mounts really write", async () => {
  const dir = await tmpdir();
  try {
    const vfs = await namespace({ mounts: [{ driver: "hostfs", at: "/host", options: { source: dir.path, mode: "rw" } }] });
    await vfs.write("/host/new.txt", "written\n", { create: true });
    assert.equal(await fs.readFile(path.join(dir.path, "new.txt"), "utf8"), "written\n");
    await vfs.mkdir("/host/sub");
    await vfs.write("/host/sub/inner.txt", "deep", { create: true });
    assert.deepEqual((await vfs.list("/host")).map((e) => e.name).sort(), ["new.txt", "sub"]);
  } finally {
    await dir.cleanup();
  }
});

test("proc: the mount table is readable, and reports what is there", async () => {
  const vfs = await namespace({ mounts: ["mem:/data"] });
  const mounts = await vfs.read("/proc/mounts");
  assert.match(mounts, /hostfs|mem on \/data/);
  assert.match(mounts, /driver|mem|bin/);
  // /proc is a view, not a control surface
  await assert.rejects(() => vfs.write("/proc/mounts", "x"), /permission denied/);
});

test("proc: the environment is not exposed unless it was asked for", async () => {
  const closed = await namespace();
  await assert.rejects(() => closed.read("/proc/env"), /ENOENT|no such file/);

  const open = await namespace({ mounts: ["proc:/env-proc,expose-env=1"] });
  const text = await open.read("/env-proc/env");
  assert.match(text, /PATH=/);
});
