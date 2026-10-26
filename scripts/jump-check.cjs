/**
 * Jump host (ProxyJump) chain verification.
 *
 * The old implementation had three hard defects, all pinned by this script:
 *   1. it probed the final target's host key from THIS machine, so a target
 *      reachable only through the jump host always timed out;
 *   2. the tunnel was forwarded to hop.host:hop.port (the jump host itself);
 *   3. the target's fingerprint was never verified inside the tunnel.
 *
 * Now it is "connect first, then probe further": hop N is probed/connected over
 * hop N-1's tunnel, and the final target likewise.
 *
 * Evidence:
 *   - the jump host saw a forward request aimed at the TARGET port (not at itself);
 *   - the target only emits its real banner once a forward has happened, so
 *     receiving that banner also proves the traffic went through the tunnel.
 */
const ssh2 = require("ssh2");
const { Server, utils } = ssh2;
const { spawn } = require("node:child_process");
const { readFile, mkdtemp } = require("node:fs/promises");
const net = require("node:net");
const { tmpdir } = require("node:os");
const { join } = require("node:path");

(async () => {
  const { SshTransport } = await import("../dist-ssh-test.mjs");
  const { KnownHosts } = await import("../dist-known-hosts-test.mjs");

  const watchdog = setTimeout(() => {
    console.log("jump host check timed out after 90s");
    process.exit(1);
  }, 90_000);
  watchdog.unref();

  const results = [];
  const ok = (m) => { results.push(true); console.log("OK  " + m); };
  const fail = (m) => { results.push(false); console.log("ERR " + m); };

  const dir = await mkdtemp(join(tmpdir(), "pi-terminal-jump-"));
  const keygen = (name) => new Promise((resolve, reject) => {
    const path = join(dir, name);
    const child = spawn("ssh-keygen", ["-t", "ed25519", "-N", "", "-f", path, "-q"], { windowsHide: true });
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve(path) : reject(new Error("ssh-keygen exited " + code))));
  });

  const jumpHostKey = await readFile(await keygen("jumpHost"));
  const secondJumpHostKey = await readFile(await keygen("secondJumpHost"));
  const targetHostKey = await readFile(await keygen("targetHost"));
  const clientKey = await readFile(await keygen("client"));
  const parsed = utils.parseKey(clientKey);
  const first = Array.isArray(parsed) ? parsed[0] : parsed;
  const clientPublicBlob = first.getPublicSSH().toString("base64");

  const acceptKey = (ctx) => {
    if (ctx.method !== "publickey") return ctx.reject();
    return ctx.key && ctx.key.data.toString("base64") === clientPublicBlob ? ctx.accept() : ctx.reject();
  };

  // Forward requests each jump host received, as "127.0.0.1:12345".
  const firstForwardedTo = [];
  const secondForwardedTo = [];
  const createJumpServer = (hostKey, forwardedTo) => new Server({ hostKeys: [hostKey] }, (client) => {
    client.on("authentication", acceptKey);
    client.on("ready", () => {
      client.on("tcpip", (accept, reject, info) => {
        forwardedTo.push(info.destIP + ":" + info.destPort);
        const stream = accept();
        const socket = net.connect(info.destPort, info.destIP);
        socket.on("connect", () => {
          socket.pipe(stream);
          stream.pipe(socket);
        });
        socket.on("error", () => stream.close());
        void reject;
      });
      client.on("session", (acceptSession) => {
        const session = acceptSession();
        session.on("pty", (a) => typeof a === "function" && a());
        session.on("shell", (acceptShell) => acceptShell().write("JUMP_SHELL\r\n"));
      });
    });
    client.on("error", () => undefined);
  });
  const jumpServer = createJumpServer(jumpHostKey, firstForwardedTo);
  const secondJumpServer = createJumpServer(secondJumpHostKey, secondForwardedTo);

  let targetConnections = 0;
  const targetServer = new Server({ hostKeys: [targetHostKey] }, (client) => {
    targetConnections += 1;
    client.on("authentication", acceptKey);
    client.on("ready", () => {
      client.on("session", (acceptSession) => {
        const session = acceptSession();
        session.on("pty", (a) => typeof a === "function" && a());
        session.on("shell", (acceptShell) => {
          const stream = acceptShell();
          stream.write(secondForwardedTo.length > 0 ? "PI_THROUGH_JUMP_OK\r\n" : "PI_DIRECT_LEAK\r\n");
        });
        session.on("exec", (acceptExec) => {
          const stream = acceptExec();
          stream.write("/home/target\r\n");
          stream.exit(0);
          stream.end();
        });
      });
    });
    client.on("error", () => undefined);
  });

  const listen = (s) => new Promise((r) => s.listen(0, "127.0.0.1", () => r(s.address().port)));
  const jumpPort = await listen(jumpServer);
  const secondJumpPort = await listen(secondJumpServer);
  const targetPort = await listen(targetServer);
  ok("jump servers :" + jumpPort + " -> " + secondJumpPort + ", target server :" + targetPort);

  const profile = {
    id: "00000000-0000-0000-0000-0000000000bb",
    name: "through jump",
    host: "127.0.0.1",
    port: targetPort,
    user: "smoke",
    auth: "key",
    term: "xterm-256color",
    jump: [
      { host: "127.0.0.1", port: jumpPort, user: "jump", auth: "key" },
      { host: "127.0.0.1", port: secondJumpPort, user: "jump", auth: "key" },
    ],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };

  const seen = [];
  const transport = await SshTransport.open(
    profile,
    { privateKey: clientKey },
    { cols: 90, rows: 24 },
    { onData: (chunk) => seen.push(chunk.toString("utf8")), onExit: () => undefined, onError: () => undefined },
    {
      onHostKey: async (input) => { seen.push("PROMPT:" + input.host + ":" + input.port); return true; },
      onProgress: () => undefined,
    },
    await KnownHosts.load(dir),
  ).catch((error) => error);

  if (!transport || !transport.kind) {
    fail("the jump chain could not connect at all: " + (transport && transport.message ? transport.message : transport));
  } else {
    ok("a session through the jump host connected");
    await new Promise((r) => setTimeout(r, 400));

    if (firstForwardedTo.indexOf("127.0.0.1:" + secondJumpPort) >= 0) {
      ok("the first jump forwarded to the second jump (" + firstForwardedTo.join(", ") + ")");
    } else {
      fail("the first jump was not forwarded to the second jump; requests: " + JSON.stringify(firstForwardedTo));
    }

    if (secondForwardedTo.indexOf("127.0.0.1:" + targetPort) >= 0) {
      ok("the second jump forwarded to the target (" + secondForwardedTo.join(", ") + ")");
    } else {
      fail("the second jump was not forwarded to the target; requests: " + JSON.stringify(secondForwardedTo));
    }

    const prompted = seen.filter((l) => l.indexOf("PROMPT:") === 0).map((l) => l.slice(7));
    if (
      prompted.indexOf("127.0.0.1:" + jumpPort) >= 0 &&
      prompted.indexOf("127.0.0.1:" + secondJumpPort) >= 0 &&
      prompted.indexOf("127.0.0.1:" + targetPort) >= 0
    ) {
      ok("both jump hosts and the target had their host keys verified");
    } else {
      fail("host key verification was not requested for every hop: " + JSON.stringify(prompted));
    }

    const text = seen.join("");
    if (text.indexOf("PI_THROUGH_JUMP_OK") >= 0) ok("the shell came from the target through the tunnel");
    else fail("no banner from the target: " + JSON.stringify(text.slice(0, 160)));
    if (text.indexOf("PI_DIRECT_LEAK") >= 0) fail("the target answered a connection that did not go through both jump hosts");

    const knownText = await readFile(join(dir, "known_hosts"), "utf8").catch(() => "");
    const jumpRecorded = knownText.indexOf("[127.0.0.1]:" + jumpPort) >= 0;
    const secondJumpRecorded = knownText.indexOf("[127.0.0.1]:" + secondJumpPort) >= 0;
    const targetRecorded = knownText.indexOf("[127.0.0.1]:" + targetPort) >= 0;
    if (jumpRecorded && secondJumpRecorded && targetRecorded) ok("known_hosts recorded both jump hosts and the target");
    else fail("known_hosts is missing an entry (jump=" + jumpRecorded + ", secondJump=" + secondJumpRecorded + ", target=" + targetRecorded + ")");

    await transport.kill().catch(() => undefined);
  }

  if (targetConnections === 0) fail("the target server was never reached");
  else ok("the target server saw " + targetConnections + " connection(s)");

  jumpServer.close();
  secondJumpServer.close();
  targetServer.close();
  clearTimeout(watchdog);
  const failed = results.filter((v) => !v).length;
  console.log(failed ? "\nJUMP HOST CHECK FAILED (" + failed + ")" : "\nJUMP HOST CHECK OK");
  process.exit(failed ? 1 : 0);
})();