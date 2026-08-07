{
  flake-utils,
  nixpkgs,
  ...
}:
let
  runtimeVersions = builtins.fromJSON (builtins.readFile ../../scripts/runtime-versions.json);
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
    version = runtimeVersions.codexCli.version;
    platform =
      {
        aarch64-darwin = {
          os = "darwin";
          arch = "arm64";
        };
        x86_64-darwin = {
          os = "darwin";
          arch = "x64";
        };
        aarch64-linux = {
          os = "linux";
          arch = "arm64";
        };
        x86_64-linux = {
          os = "linux";
          arch = "x64";
        };
      }
      .${system};
    artifact = runtimeVersions.codexCli.artifacts.${platform.os}.${platform.arch};
    src = pkgs.fetchurl {
      url = artifact.url;
      hash = artifact.integrity;
    };
  in
  {
    packages.codex =
      pkgs.runCommand "codex-${version}"
        {
          pname = "codex";
          inherit src version;
        }
        ''
          tar -xzf "$src"
          install -Dm755 package/vendor/*/bin/codex "$out/bin/codex"
          install -Dm755 package/vendor/*/bin/codex-code-mode-host "$out/bin/codex-code-mode-host"
        '';
  }
)
