#!/usr/bin/env node

const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const cp = require("child_process");

function die(message, code = 1) {
  console.error(message);
  process.exit(code);
}

function homePath(...parts) {
  return path.join(os.homedir(), ...parts);
}

function pathExists(target) {
  try {
    fs.accessSync(target);
    return true;
  } catch {
    return false;
  }
}

function findStateDb() {
  const candidates = [
    homePath("Library", "Application Support", "Code", "User", "globalStorage", "state.vscdb"),
    homePath(".config", "Code", "User", "globalStorage", "state.vscdb"),
  ];

  for (const candidate of candidates) {
    if (pathExists(candidate)) {
      return candidate;
    }
  }
  die("VSCode state.vscdb not found.");
}

function findExtensionRoot() {
  const root = homePath(".vscode", "extensions");
  if (!pathExists(root)) {
    die("VSCode extensions directory not found.");
  }

  const candidates = fs
    .readdirSync(root)
    .filter((name) => name.startsWith("iamhyc.overleaf-workshop-"))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

  if (candidates.length === 0) {
    die("VSCode extension iamhyc.overleaf-workshop is not installed.");
  }

  return path.join(root, candidates[candidates.length - 1]);
}

function loadPluginState() {
  const db = findStateDb();
  let raw = "";
  try {
    raw = cp.execFileSync(
      "sqlite3",
      [db, "select value from ItemTable where key='iamhyc.overleaf-workshop';"],
      { encoding: "utf8" }
    ).trim();
  } catch (error) {
    die(`Failed to read VSCode state DB: ${error.message}`);
  }

  if (!raw) {
    die("No iamhyc.overleaf-workshop state found in VSCode DB.");
  }

  try {
    return JSON.parse(raw);
  } catch (error) {
    die(`Failed to parse VSCode Overleaf state: ${error.message}`);
  }
}

function loadRuntime() {
  const extensionRoot = findExtensionRoot();
  const { BaseAPI } = require(path.join(extensionRoot, "out", "api", "base.js"));
  const DiffMatchPatch = require(path.join(extensionRoot, "node_modules", "diff-match-patch"));
  return { extensionRoot, BaseAPI, DiffMatchPatch };
}

function parseArgs(argv) {
  const args = [...argv];
  let serverName;
  let json = false;
  let fromFile;
  let stdin = false;

  const positionals = [];
  while (args.length) {
    const arg = args.shift();
    if (arg === "--server") {
      serverName = args.shift();
      if (!serverName) {
        die("--server requires a value.");
      }
      continue;
    }
    if (arg === "--json") {
      json = true;
      continue;
    }
    if (arg === "--from-file") {
      fromFile = args.shift();
      if (!fromFile) {
        die("--from-file requires a value.");
      }
      continue;
    }
    if (arg === "--stdin") {
      stdin = true;
      continue;
    }
    positionals.push(arg);
  }

  return { serverName, json, fromFile, stdin, positionals };
}

function resolveServer(state, requestedName) {
  const servers = state["overleaf-servers"] || {};
  if (requestedName) {
    const server = servers[requestedName];
    if (!server) {
      die(`Unknown server: ${requestedName}`);
    }
    return { name: requestedName, server };
  }

  if (servers["www.overleaf.com"]) {
    return { name: "www.overleaf.com", server: servers["www.overleaf.com"] };
  }

  const names = Object.keys(servers);
  if (names.length === 1) {
    return { name: names[0], server: servers[names[0]] };
  }

  if (names.length === 0) {
    die("No Overleaf servers found in VSCode plugin state.");
  }

  die(`Multiple Overleaf servers found. Use --server. Available: ${names.join(", ")}`);
}

function resolveProject(server, projectNameOrId) {
  const projects = server.login?.projects || [];
  const project = projects.find(
    (item) => item.id === projectNameOrId || item.name === projectNameOrId
  );
  if (!project) {
    die(`Project not found: ${projectNameOrId}`);
  }
  return project;
}

function emitAsync(socket, event, ...args) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Timed out waiting for ${event}`));
    }, 10000);

    socket.emit(event, ...args, (err, ...data) => {
      clearTimeout(timer);
      if (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
        return;
      }
      resolve(data);
    });
  });
}

async function connectProject(BaseAPI, server, identity, projectId) {
  const api = new BaseAPI(server.url);
  const socket = api._initSocketV0(identity, `?projectId=${projectId}&t=${Date.now()}`);

  const project = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error("Timed out waiting for joinProjectResponse"));
    }, 12000);

    const cleanup = () => {
      clearTimeout(timeout);
      socket.removeAllListeners("joinProjectResponse");
      socket.removeAllListeners("connectionRejected");
      socket.removeAllListeners("connect_failed");
      socket.removeAllListeners("error");
    };

    socket.on("joinProjectResponse", (response) => {
      cleanup();
      resolve(response.project);
    });

    socket.on("connectionRejected", (error) => {
      cleanup();
      reject(new Error(error?.message || String(error)));
    });

    socket.on("connect_failed", () => {
      cleanup();
      reject(new Error("Socket connect_failed"));
    });

    socket.on("error", (error) => {
      cleanup();
      reject(error instanceof Error ? error : new Error(String(error)));
    });
  });

  return { api, socket, project };
}

const FOLDER_KEYS = {
  folder: "folders",
  doc: "docs",
  file: "fileRefs",
  outputs: "outputs",
};

function findEntityByPath(root, targetPath, base = "/") {
  for (const [type, key] of Object.entries(FOLDER_KEYS)) {
    for (const entity of root[key] || []) {
      const entityPath = type === "folder" ? `${base}${entity.name}/` : `${base}${entity.name}`;
      if (entityPath === targetPath) {
        return { type, entity, path: entityPath, parent: root };
      }
      if (type === "folder") {
        const nested = findEntityByPath(entity, targetPath, entityPath);
        if (nested) {
          return nested;
        }
      }
    }
  }
  return null;
}

function normalizeRemotePath(remotePath) {
  if (!remotePath) {
    die("Missing remote path.");
  }
  return remotePath.startsWith("/") ? remotePath : `/${remotePath}`;
}

function decodePackedUtf8(text) {
  return Buffer.from(text, "latin1").toString("utf-8");
}

async function readDoc(socket, rootFolder, remotePath) {
  const target = findEntityByPath(rootFolder, normalizeRemotePath(remotePath));
  if (!target) {
    die(`Remote path not found: ${remotePath}`);
  }
  if (target.type !== "doc") {
    die(`Remote path is not a doc-backed text file: ${remotePath}`);
  }

  const [docLinesAscii, version] = await emitAsync(socket, "joinDoc", target.entity._id, {
    encodeRanges: true,
  });
  const content = docLinesAscii.map((line) => decodePackedUtf8(line)).join("\n");
  return { target, version, content };
}

function buildOtUpdate(DiffMatchPatch, docId, version, remoteContent, nextContent) {
  const dmp = new DiffMatchPatch();
  const remoteAscii = Buffer.from(remoteContent, "utf-8").toString("utf-8");
  const nextAscii = Buffer.from(nextContent, "utf-8").toString("utf-8");

  let currentPos = 0;
  const op = dmp
    .diff_main(remoteAscii, nextAscii)
    .map((part) => {
      const kind = part[0];
      const text = part[1];
      const incCount = kind === -1 ? 0 : text.length;
      currentPos += incCount;

      if (kind === 0) {
        return undefined;
      }
      return {
        p: currentPos - incCount,
        i: kind === 1 ? text : undefined,
        d: kind === -1 ? text : undefined,
      };
    })
    .filter(Boolean);

  return {
    doc: docId,
    lastV: undefined,
    v: version,
    hash: crypto
      .createHash("sha1")
      .update(`blob ${nextContent.length}\x00${nextContent}`)
      .digest("hex"),
    op,
  };
}

function readInputContent({ fromFile, stdin }) {
  if (fromFile && stdin) {
    die("Use either --from-file or --stdin, not both.");
  }
  if (!fromFile && !stdin) {
    die("write requires --from-file or --stdin.");
  }
  if (fromFile) {
    return fs.readFileSync(fromFile, "utf8");
  }
  return fs.readFileSync(0, "utf8");
}

async function main() {
  const { BaseAPI, DiffMatchPatch } = loadRuntime();
  const state = loadPluginState();
  const parsed = parseArgs(process.argv.slice(2));
  const [command, projectArg, remotePathArg] = parsed.positionals;
  const { server } = resolveServer(state, parsed.serverName);
  const identity = server.login?.identity;

  if (!identity) {
    die("No saved Overleaf login session found in VSCode plugin state.");
  }

  if (command === "projects") {
    const projects = (server.login?.projects || []).map((project) => ({
      id: project.id,
      name: project.name,
      archived: project.archived,
      trashed: project.trashed,
      accessLevel: project.accessLevel,
      lastUpdated: project.lastUpdated,
    }));
    if (parsed.json) {
      console.log(JSON.stringify(projects, null, 2));
    } else {
      for (const project of projects) {
        console.log(`${project.name}\t${project.id}`);
      }
    }
    return;
  }

  if (!projectArg) {
    die("Missing project name or id.");
  }
  const project = resolveProject(server, projectArg);

  if (command === "files") {
    const api = new BaseAPI(server.url);
    const response = await api.projectEntitiesJson(identity, project.id);
    const entities = response.entities || [];
    if (parsed.json) {
      console.log(JSON.stringify(entities, null, 2));
    } else {
      for (const entity of entities) {
        console.log(`${entity.path}\t${entity.type}`);
      }
    }
    return;
  }

  if (!remotePathArg) {
    die("Missing remote path.");
  }

  const { socket, project: projectTree } = await connectProject(
    BaseAPI,
    server,
    identity,
    project.id
  );

  try {
    const rootFolder = projectTree.rootFolder[0];
    if (!rootFolder) {
      die(`Project tree missing for ${project.name}`);
    }

    if (command === "read") {
      const { content } = await readDoc(socket, rootFolder, remotePathArg);
      process.stdout.write(content);
      return;
    }

    if (command === "write") {
      const desiredContent = readInputContent(parsed);
      const { target, version, content: currentContent } = await readDoc(
        socket,
        rootFolder,
        remotePathArg
      );
      const update = buildOtUpdate(
        DiffMatchPatch,
        target.entity._id,
        version,
        currentContent,
        desiredContent
      );

      if (!update.op.length) {
        console.error("No remote change needed.");
        return;
      }

      await emitAsync(socket, "applyOtUpdate", target.entity._id, update);

      const verify = await readDoc(socket, rootFolder, remotePathArg);
      if (verify.content !== desiredContent) {
        die(`Write verification failed for ${normalizeRemotePath(remotePathArg)}`);
      }

      console.error(`Wrote ${normalizeRemotePath(remotePathArg)} in project ${project.name}.`);
      return;
    }

    die(`Unknown command: ${command}`);
  } finally {
    try {
      socket.disconnect();
    } catch {
      // no-op
    }
  }
}

main().catch((error) => {
  die(error?.stack || String(error));
});
