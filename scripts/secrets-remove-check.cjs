/**
 * Credential deletion must reach the OS keystore.
 *
 * On the keychain / libsecret backends the ciphertext is NOT in the plugin's
 * placeholder file: it lives in Keychain / libsecret. Deleting only the local
 * file (the old behaviour) left the entry behind, so "clear password" did not
 * actually clear anything -- it stayed readable via `security
 * find-generic-password` / `secret-tool lookup`.
 *
 * Those branches never run on Windows, so this check replaces the process
 * launcher (`__setSpawnForTest`) and asserts on the exact argv the plugin
 * issues: the delete must happen, and must name the same account/key that was
 * used when storing.
 */
const { mkdir, mkdtemp, readFile, rm, writeFile } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join } = require("node:path");

(async () => {
  const { SecretStore, __setSpawnForTest } = await import("../dist-secrets-test.mjs");

  const results = [];
  const ok = (m) => { results.push(true); console.log("OK  " + m); };
  const fail = (m) => { results.push(false); console.log("ERR " + m); };

  const dir = await mkdtemp(join(tmpdir(), "pi-terminal-secrets-"));

  const calls = [];
  /**
   * Per-run exit code. Default 0; a test can make the *next* delete fail by
   * pushing onto `exitQueue` (one entry consumed per spawned process).
   */
  const exitQueue = [];
  __setSpawnForTest((command, args) => {
    calls.push({ command, args: [...args] });
    const emitter = () => {
      const listeners = {};
      const api = {
        setEncoding: () => api,
        on: (event, fn) => { listeners[event] = fn; return api; },
        emit: (event, arg) => { if (listeners[event]) listeners[event](arg); },
      };
      return api;
    };
    const handle = {
      stdout: emitter(),
      stderr: emitter(),
      stdin: { end: () => undefined },
      listeners: {},
      on(event, fn) { this.listeners[event] = fn; return this; },
      emit(event, arg) { if (this.listeners[event]) this.listeners[event](arg); },
    };
    const code = exitQueue.length ? exitQueue.shift() : 0;
    setImmediate(() => {
      if (code !== 0) handle.stderr.emit("data", "keystore unavailable");
      handle.emit("close", code);
    });
    return handle;
  });

  const failNext = (code) => exitQueue.push(code);

  const takeCalls = () => { const copy = calls.slice(); calls.length = 0; return copy; };
  const accountOf = (call) => {
    const a = call.args.indexOf("-a");
    if (a >= 0) return call.args[a + 1];
    const idx = call.args.indexOf("account");
    return idx >= 0 ? call.args[idx + 1] : null;
  };

  /* -- keychain ---------------------------------------------------------- */
  const kc = await SecretStore.openWith(dir, { backend: "keychain", degraded: false, detail: "test" });
  takeCalls();
  await kc.set("profile-a", "password", "s3cret");
  const stored = takeCalls().find((c) => c.command === "security" && c.args[0] === "add-generic-password");
  if (stored) ok("keychain store issued add-generic-password");
  else fail("keychain store did not call add-generic-password");

  const storedAccount = stored ? accountOf(stored) : null;
  if (storedAccount === "profile-a.password") ok("the stored account is scoped to the profile (" + storedAccount + ")");
  else fail("unexpected account when storing: " + JSON.stringify(storedAccount));

  takeCalls();
  await kc.remove("profile-a", "password");
  const del = takeCalls().find((c) => c.command === "security" && c.args[0] === "delete-generic-password");
  if (del) ok("keychain remove issued delete-generic-password");
  else fail("keychain remove did NOT delete the keystore entry");

  if (del && accountOf(del) === storedAccount) ok("the deleted account matches the stored one (" + accountOf(del) + ")");
  else fail("delete used a different account than store: " + JSON.stringify(del && accountOf(del)));

  if (await kc.has("profile-a", "password")) fail("the local placeholder file survived the delete");
  else ok("the local placeholder file is gone too");

  /* -- libsecret --------------------------------------------------------- */
  const ls = await SecretStore.openWith(dir, { backend: "libsecret", degraded: false, detail: "test" });
  takeCalls();
  await ls.set("profile-b", "passphrase", "phrase");
  const libStore = takeCalls().find((c) => c.command === "secret-tool" && c.args[0] === "store");
  if (libStore) ok("libsecret store issued secret-tool store");
  else fail("libsecret store did not call secret-tool");

  takeCalls();
  await ls.remove("profile-b", "passphrase");
  const libClear = takeCalls().find((c) => c.command === "secret-tool" && c.args[0] === "clear");
  if (libClear) ok("libsecret remove issued secret-tool clear");
  else fail("libsecret remove did NOT clear the keystore entry");

  if (libStore && libClear && accountOf(libClear) === accountOf(libStore)) {
    ok("the cleared key matches the stored key (" + accountOf(libClear) + ")");
  } else if (libStore && libClear) {
    fail("clear used different attributes than store");
  }

  /* -- repeated removal is a no-op --------------------------------------- */
  await ls.remove("profile-b", "passphrase");
  ok("removing an already-removed credential does not throw");

  /* -- legacy entry without a recorded account --------------------------- */
  const path = join(dir, "secrets", "legacy.password.bin");
  await writeFile(path, Buffer.alloc(0));
  await writeFile(path + ".meta", JSON.stringify({ backend: "keychain" }));
  takeCalls();
  await kc.remove("legacy", "password");
  const legacyDel = takeCalls().find((c) => c.command === "security" && c.args[0] === "delete-generic-password");
  if (legacyDel && accountOf(legacyDel) === "legacy.password") {
    ok("an entry without a recorded account is still deleted by its computed name");
  } else {
    fail("legacy entry was not deleted: " + JSON.stringify(legacyDel && legacyDel.args));
  }

  /* -- failure path: the delete command itself fails --------------------- */
  /*
   * A locked keychain or a refused delete must NOT be reported as success, and
   * the local sidecar must survive so the user can retry: `.meta` holds the
   * only record of which keystore account this credential lives under.
   */
  await kc.set("profile-c", "password", "s3cret");
  const cPath = join(dir, "secrets", "profile-c.password.bin");
  const cMeta = cPath + ".meta";
  takeCalls();
  failNext(1); // `security` refused the delete
  let threw = false;
  try {
    await kc.remove("profile-c", "password");
  } catch {
    threw = true;
  }
  if (threw) ok("a failed keystore delete is reported, not swallowed");
  else fail("a failed keystore delete was silently treated as success");

  if (await kc.has("profile-c", "password")) ok("the local credential survives a failed delete (so it can be retried)");
  else fail("the local credential was removed even though the keystore entry is still there");

  const metaAfterFailure = await readFile(cMeta, "utf8").catch(() => null);
  if (metaAfterFailure !== null) ok("the .meta sidecar survives, so a retry still knows the keystore account");
  else fail("the .meta sidecar was deleted, losing the only record of the keystore account");

  /* -- a retry after the keystore comes back must succeed ---------------- */
  takeCalls();
  await kc.remove("profile-c", "password").then(
    () => ok("retrying the removal succeeds once the keystore is available again"),
    (e) => fail("the retry failed too: " + e.message),
  );
  const retryDel = takeCalls().find((c) => c.command === "security" && c.args[0] === "delete-generic-password");
  if (retryDel && accountOf(retryDel) === "profile-c.password") ok("the retry deleted the same account as the original store");
  else fail("the retry used a different account: " + JSON.stringify(retryDel && accountOf(retryDel)));
  if (await kc.has("profile-c", "password")) fail("the local file survived a successful retry");
  else ok("the local file is gone after the successful retry");

  /* -- "already gone" is not a failure ----------------------------------- */
  /*
   * `security delete-generic-password` exits 44 when the item does not exist.
   * The user asked for "it must be gone", so already-gone counts as done --
   * otherwise every retry would fail forever on a stale entry.
   */
  await kc.set("profile-d", "password", "s3cret");
  failNext(44);
  await kc.remove("profile-d", "password").then(
    () => ok("deleting an already-absent keystore entry (exit 44) is not an error"),
    (e) => fail("exit 44 (item not found) was treated as a failure: " + e.message),
  );
  if (await kc.has("profile-d", "password")) fail("exit 44 left the local file behind");
  else ok("exit 44 still clears the local placeholder");

  /* -- failure path: the local file itself cannot be removed ------------- */
  /*
   * On the dpapi / passphrase-file backends the ciphertext lives in this very
   * file, so failing to unlink it means the credential was NOT deleted. That
   * must be reported, not swallowed -- and the keystore entry must not be
   * deleted first, otherwise the retry has nothing left to clean up.
   *
   * Reproduced portably by making the path a non-empty directory: unlink then
   * fails with EPERM/EISDIR on both Windows and POSIX.
   */
  takeCalls();
  await kc.set("profile-e", "password", "s3cret");
  const ePath = join(dir, "secrets", "profile-e.password.bin");
  const eMeta = ePath + ".meta";
  await rm(ePath, { force: true });
  await mkdir(ePath, { recursive: true });
  await writeFile(join(ePath, "blocker.txt"), "occupied");
  takeCalls();
  let localThrew = false;
  try {
    await kc.remove("profile-e", "password");
  } catch {
    localThrew = true;
  }
  if (localThrew) ok("a local credential file that cannot be unlinked is reported, not swallowed");
  else fail("a local unlink failure was silently treated as success");

  /*
   * The keystore is cleaned first by design: it is the side that lets anyone
   * read the plaintext back. So a local unlink failure still leaves the
   * keystore empty -- what must survive is `.meta`, and the retry must then
   * finish the job instead of hitting a dead end.
   */
  const callsDuringFailure = takeCalls();
  const deletedAnyway = callsDuringFailure.some((c) => c.command === "security" && c.args[0] === "delete-generic-password");
  if (deletedAnyway) ok("the keystore entry is still cleared even when the local unlink fails");
  else fail("the keystore delete did not run");

  const eMetaText = await readFile(eMeta, "utf8").catch(() => null);
  if (eMetaText !== null) ok("the .meta sidecar survives the local unlink failure (retry path stays open)");
  else fail("the .meta sidecar was removed after a failed local unlink");
  await rm(ePath, { recursive: true, force: true });
  takeCalls();
  await kc.remove("profile-e", "password").then(
    () => ok("retrying after the obstruction is cleared succeeds"),
    (e) => fail("the retry after clearing the obstruction failed: " + e.message),
  );
  if (await kc.has("profile-e", "password")) fail("the credential is still present after a successful retry");
  else ok("the credential is really gone after the retry");

  /* -- a missing file is not a failure (idempotent) ---------------------- */
  await kc.remove("profile-e", "password").then(
    () => ok("removing an already-gone credential is not an error (ENOENT ignored)"),
    (e) => fail("ENOENT was treated as a failure: " + e.message),
  );

  /* -- profile deletion keeps the profile if the keystore fails ---------- */
  const { ProfileStore } = await import("../dist-profiles-test.mjs");
  const store = await ProfileStore.open(dir, kc);
  takeCalls();
  const created = await store.save({ name: "locked", host: "example.test", user: "u", auth: "password", password: "pw" });
  takeCalls();
  failNext(1);
  let removeThrew = false;
  try {
    await store.remove(created.id);
  } catch {
    removeThrew = true;
  }
  if (removeThrew) ok("deleting a profile whose keystore entry cannot be removed fails loudly");
  else fail("profile deletion swallowed the keystore failure");
  const stillThere = await store.list();
  if (stillThere.some((p) => p.id === created.id)) ok("the profile is kept when its credential could not be removed (so it can be retried)");
  else fail("the profile disappeared although its credential is still in the keystore");


  __setSpawnForTest(null);
  const failed = results.filter((v) => !v).length;
  console.log(failed ? "\nSECRETS REMOVE CHECK FAILED (" + failed + ")" : "\nSECRETS REMOVE CHECK OK");
  process.exit(failed ? 1 : 0);
})();