{
  flake-utils,
  nixpkgs,
  ...
}:
let
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
    version = "0.147.0-alpha.1.2";
    platform =
      {
        aarch64-darwin = {
          npm = "darwin-arm64";
          hash = "sha512-f0+t0R77PFu0sG3WH67pDNIslePbua7grhxFIkAeatWnSxHq7XRYuK1VCg/2QtBYR3KYYPd3D6XjNMDgwu04Ag==";
        };
        x86_64-darwin = {
          npm = "darwin-x64";
          hash = "sha512-Ig64tM9JMxIFeltnDjuD0AQsmT0Ef19UWyGlgLhmBNzr5LeZceds0NsvJPcOwtuKZkkmcJugtcdDs0+WWM5s6g==";
        };
        aarch64-linux = {
          npm = "linux-arm64";
          hash = "sha512-BTpVNF/jLO3K9FYxNHUg8PdukPphff967A4lvED+mxbPpFYE2K7ZWSS1P3zzdueO3wtrhQJfTK6904z28I3Vow==";
        };
        x86_64-linux = {
          npm = "linux-x64";
          hash = "sha512-hXqsBa8SWyP8E8BwI+bwaSV2PeRyoHTbaKttNbsOtysJWXX6KqFxSIZcO3TfwsLvHS5tY9b96T/QFtliHepF4w==";
        };
      }
      .${system};
    src = pkgs.fetchurl {
      url = "https://registry.npmjs.org/@openai/codex/-/codex-${version}-${platform.npm}.tgz";
      hash = platform.hash;
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
