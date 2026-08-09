{
  flake-utils,
  nixpkgs,
  self,
  ...
}:
let
  runtimeVersions = builtins.fromJSON (builtins.readFile ./scripts/runtime-versions.json);
  systems = [
    "aarch64-darwin"
    "x86_64-darwin"
    "aarch64-linux"
    "x86_64-linux"
  ];
in
flake-utils.lib.eachSystem systems (
  system:
  let
    pkgs = import nixpkgs { inherit system; };
    codexZip = pkgs.fetchurl {
      url = runtimeVersions.desktop.url;
      hash = runtimeVersions.desktop.integrity;
    };
    codex = self.packages.${system}.codex;
  in
  {
    devShells.default = pkgs.mkShell {
      HOSTED_CODEX_APP_ZIP = codexZip;

      packages = [
        codex
        pkgs.nodejs
        pkgs.unzip
      ];
    };

    packages =
      let
        nodeSources = pkgs.srcOnly pkgs.nodejs;
        npmDeps = pkgs.importNpmLock {
          npmRoot = ./.;
        };

        betterSqlite3Native = pkgs.stdenv.mkDerivation {
          pname = "better-sqlite3-native";
          version = "12.9.0";
          src = pkgs.lib.fileset.toSource {
            root = ./.;
            fileset = pkgs.lib.fileset.unions [
              ./package.json
              ./package-lock.json
            ];
          };

          inherit npmDeps;

          npmRebuildFlags = [ "--ignore-scripts" ];

          nativeBuildInputs = [
            pkgs.importNpmLock.npmConfigHook
            pkgs.nodejs
            pkgs.python3
            pkgs.removeReferencesTo
          ]
          ++ pkgs.lib.optionals pkgs.stdenv.hostPlatform.isDarwin [ pkgs.cctools ];

          buildPhase = ''
            runHook preBuild

            pushd node_modules/better-sqlite3
            npm run build-release --offline --nodedir="${nodeSources}"
            rm -rf build/Release/{.deps,obj,obj.target,test_extension.node}
            find build -type f -exec ${pkgs.lib.getExe pkgs.removeReferencesTo} -t "${nodeSources}" {} \;
            popd

            runHook postBuild
          '';

          installPhase = ''
            runHook preInstall

            mkdir -p "$out"
            cp -R node_modules/better-sqlite3/build "$out/build"

            runHook postInstall
          '';
        };
      in
      {
        default = pkgs.buildNpmPackage {
          HOSTED_CODEX_APP_ZIP = codexZip;
          CODEX_CLI_PATH = "${codex}/bin/codex";
          # importNpmLock intentionally suppresses dependency lifecycle scripts
          # and the Nix sandbox cannot fetch Electron's release archive.
          CODEX_WEB_SKIP_ELECTRON_RUNTIME = "1";

          pname = "codex-web";
          version = "1.0.0";
          src = ./.;

          inherit npmDeps;

          npmConfigHook = pkgs.importNpmLock.npmConfigHook;
          npmBuildScript = "build";
          npmRebuildFlags = [ "--ignore-scripts" ];
          npmPruneFlags = [ "--ignore-scripts" ];

          nativeBuildInputs = [
            pkgs.makeWrapper
            pkgs.unzip
          ];

          preBuild = ''
            patchShebangs scripts
          '';

          preInstall = ''
            # npm pack always runs the package prepare lifecycle. Nix already ran
            # the explicit build script above, so remove prepare in the sandbox.
            node -e '
              const fs = require("fs");
              const packageJsonPath = "package.json";
              const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
              delete packageJson.scripts.prepare;
              fs.writeFileSync(packageJsonPath, JSON.stringify(packageJson, null, 2) + "\n");
            '

            # Keep only extracted asar artifacts for packaging.
            rm -rf scratch/desktop-source
          '';

          postInstall = ''
            addon="$out/lib/node_modules/codex-web/node_modules/better-sqlite3"
            rm -rf "$addon/build"
            ln -s ${betterSqlite3Native}/build "$addon/build"
            wrapProgram "$out/bin/codex-web" --set CODEX_CLI_PATH ${codex}/bin/codex
          '';
        };

        codex_remote_proxy = pkgs.writeShellApplication {
          name = "codex_remote_proxy";
          runtimeInputs = with pkgs; [
            bash
            coreutils
            websocat
          ];
          text = builtins.readFile ./scripts/codex_remote_proxy;
        };
      };
  }
)
