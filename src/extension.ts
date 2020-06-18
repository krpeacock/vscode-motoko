import { workspace, ExtensionContext, window, commands } from "vscode";
import * as fs from "fs";
import * as path from "path";
// import * as which from "which";
import { execSync } from "child_process";

import {
  LanguageClient,
  LanguageClientOptions,
  ServerOptions,
} from "vscode-languageclient";

const config = workspace.getConfiguration("motoko");

let client: LanguageClient;

export function activate(context: ExtensionContext) {
  context.subscriptions.push(
    commands.registerCommand("motoko.startService", startServer)
  );
  startServer();
}

export function startServer() {
  if (client) {
    client.stop();
  }

  const dfxConfig = isDfxProject();
  if (dfxConfig !== null) {
    return launchDfxProject(dfxConfig);
  }

  const prompt = `We failed to detect a dfx project for this Motoko file. What file do you want to use as an entry point?`;
  const currentDocument = window.activeTextEditor?.document?.fileName;

  window.showInputBox({ prompt, value: currentDocument }).then((entryPoint) => {
    if (entryPoint) {
      const serverCommand = {
        command: config.standaloneBinary,
        args: ["--canister-main", entryPoint]
          .concat(vesselArgs())
          .concat(config.standaloneArguments.split(" ")),
      };
      launchClient({ run: serverCommand, debug: serverCommand });
    }
  });
}

function getOrCreateIDLPath(): string | null {
  try {
    const wsf = workspace.workspaceFolders;
    if (!wsf) return null;
    const idlPath = path.join(wsf[0].uri.fsPath, ".vscode", "idl");
    if (fs.existsSync(idlPath)) return idlPath;
    fs.mkdirSync(idlPath, { recursive: true });
    return idlPath;
  } catch {
    return null;
  }
}

function copyIDLFiles(): {
  idlPath: string;
  canisterMappings: { alias: string; id: string }[];
} | null {
  let idlPath = getOrCreateIDLPath();
  if (idlPath === null) return null;
  let canisterManifest = getDfxManifest();
  if (canisterManifest === null) return null;

  const canisterMappings = [];
  for (const [alias, info] of Object.entries(canisterManifest.canisters)) {
    // Drops the leading ic:
    let canisterId = info.canister_id.slice(3);
    canisterMappings.push({ alias, id: info.canister_id });
    console.log(info.canister_id, canisterId);
    fs.copyFileSync(info.candid_path, path.join(idlPath, canisterId + ".did"));
  }
  return { idlPath, canisterMappings };
}

function launchDfxProject(dfxConfig: DfxConfig) {
  const start = (canister: string) => {
    const idlArgs: string[] = [];
    const idlFiles = copyIDLFiles();
    if (idlFiles !== null) {
      idlArgs.push("--actor-idl");
      idlArgs.push(idlFiles.idlPath);
      idlFiles.canisterMappings.forEach((mapping) => {
        idlArgs.push("--actor-alias");
        idlArgs.push(mapping.alias);
        idlArgs.push(mapping.id);
      });
    }
    const args = ["--canister-main", dfxConfig.canisters[canister].main].concat(
      idlArgs
    );
    const serverCommand = {
      command: config.standaloneBinary,
      args,
    };
    launchClient({ run: serverCommand, debug: serverCommand });
  };

  let canister = config.get("canister") as string;
  let canisters = Object.keys(dfxConfig.canisters);

  if (canister !== "") start(canister);
  else if (canisters.length === 1) start(canisters[0]);
  else
    window
      .showQuickPick(canisters, {
        canPickMany: false,
        placeHolder: "What canister do you want to work on?",
      })
      .then((c) => {
        if (c) start(c);
      });
}

function launchClient(serverOptions: ServerOptions) {
  let clientOptions: LanguageClientOptions = {
    // Register the server for motoko source files
    documentSelector: [{ scheme: "file", language: "motoko" }],
    synchronize: {
      // Notify the server about file changes to '.clientrc files contained in the workspace
      fileEvents: workspace.createFileSystemWatcher("**/.clientrc"),
    },
  };

  // Create the language client and start the client.
  client = new LanguageClient(
    "motoko",
    "Motoko language server",
    serverOptions,
    clientOptions
  );

  // Start the client. This will also launch the server
  client.start();
}

export function deactivate(): Thenable<void> | undefined {
  if (!client) {
    return undefined;
  }
  return client.stop();
}

interface DfxCanisters {
  [key: string]: { main: string };
}

type DfxConfig = {
  canisters: DfxCanisters;
};

type DfxManifestCanister = {
  candid_path: string;
  canister_id: string /* timestamp, wasm_path */;
};

type DfxCanisterManifest = {
  canisters: Record<string, DfxManifestCanister>;
};

function getDfxManifest(): DfxCanisterManifest | null {
  const wsf = workspace.workspaceFolders;
  if (wsf) {
    try {
      const res = JSON.parse(
        fs
          .readFileSync(
            path.join(wsf[0].uri.fsPath, "canisters", "canister_manifest.json")
          )
          .toString("utf8")
      );
      return res;
    } catch {
      return null;
    }
  } else {
    return null;
  }
}

function isDfxProject(): DfxConfig | null {
  const wsf = workspace.workspaceFolders;
  if (wsf) {
    try {
      return JSON.parse(
        fs
          .readFileSync(path.join(wsf[0].uri.fsPath, "dfx.json"))
          .toString("utf8")
      );
    } catch {
      return null;
    }
  } else {
    return null;
  }
}

// function getDfx(): string {
//   const dfx = config.get("dfx") as string;
//   try {
//     return which.sync(dfx);
//   } catch (ex) {
//     if (!fs.existsSync(dfx)) {
//       window.showErrorMessage(
//         `Failed to locate dfx at ${dfx} check that dfx is installed or try changing motoko.dfx in settings`
//       );
//       throw Error("Failed to locate dfx");
//     } else {
//       return dfx;
//     }
//   }
// }

function vesselArgs(): string[] {
  try {
    let ws = workspace.workspaceFolders!![0].uri.fsPath;
    if (!fs.existsSync(path.join(ws, "vessel.json"))) return [];
    let flags = execSync("vessel sources", {
      cwd: ws,
    }).toString("utf8");
    return flags.split(" ");
  } catch (err) {
    console.log(err);
    return [];
  }
}
