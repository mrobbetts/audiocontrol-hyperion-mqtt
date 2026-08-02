{
  description = "MQTT bridge for AudioControl Hyperion (Axis eARC/Dante) processors";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils }:
    let
      # System-agnostic NixOS module.
      nixosModule = { config, lib, pkgs, ... }:
        let
          cfg = config.services.audiocontrol-hyperion-mqtt;
          jsonFormat = pkgs.formats.json { };
          # Non-secret config rendered to the store. Secrets (mqtt password) are
          # injected at runtime via environmentFile -> MQTT_PASSWORD, which the
          # daemon layers over this file.
          configFile = jsonFormat.generate "audiocontrol-hyperion.json" {
            mqtt = {
              inherit (cfg.mqtt) url username prefix clientId;
            };
            poll.intervalMs = cfg.pollIntervalMs;
            logLevel = cfg.logLevel;
            devices = cfg.devices;
          };
        in {
          options.services.audiocontrol-hyperion-mqtt = {
            enable = lib.mkEnableOption "AudioControl Hyperion MQTT bridge";

            package = lib.mkOption {
              type = lib.types.package;
              default = self.packages.${pkgs.system}.default;
              description = "The audiocontrol-hyperion-mqtt package to run.";
            };

            mqtt = {
              url = lib.mkOption {
                type = lib.types.str;
                example = "mqtt://10.0.0.2:1883";
                description = "MQTT broker URL.";
              };
              prefix = lib.mkOption {
                type = lib.types.str;
                default = "audiocontrol/hyperion";
                description = "MQTT topic prefix for all devices.";
              };
              username = lib.mkOption {
                type = lib.types.nullOr lib.types.str;
                default = null;
                description = "MQTT username (optional).";
              };
              clientId = lib.mkOption {
                type = lib.types.str;
                default = "audiocontrol-hyperion-mqtt";
                description = "MQTT client id.";
              };
            };

            environmentFile = lib.mkOption {
              type = lib.types.nullOr lib.types.path;
              default = null;
              example = "/run/secrets/hyperion-mqtt.env";
              description = ''
                Optional systemd EnvironmentFile providing secrets, e.g.
                `MQTT_PASSWORD=...` (and optionally MQTT_USERNAME/MQTT_URL).
                Kept out of the Nix store.
              '';
            };

            pollIntervalMs = lib.mkOption {
              type = lib.types.ints.positive;
              default = 2000;
              description = "Default poll interval (ms); per-device overridable.";
            };

            logLevel = lib.mkOption {
              type = lib.types.enum [ "error" "warn" "info" "debug" ];
              default = "info";
              description = "Log verbosity.";
            };

            devices = lib.mkOption {
              description = "Hyperion devices to bridge.";
              default = [ ];
              type = lib.types.listOf (lib.types.submodule {
                options = {
                  id = lib.mkOption { type = lib.types.str; description = "Stable id used in MQTT topics."; };
                  host = lib.mkOption { type = lib.types.str; description = "Device IP/hostname."; };
                  port = lib.mkOption { type = lib.types.port; default = 23; description = "TCP port."; };
                  pollIntervalMs = lib.mkOption {
                    type = lib.types.nullOr lib.types.ints.positive;
                    default = null;
                    description = "Per-device poll interval override (ms).";
                  };
                };
              });
              example = [{ id = "theatre"; host = "10.0.0.50"; }];
            };
          };

          config = lib.mkIf cfg.enable {
            systemd.services.audiocontrol-hyperion-mqtt = {
              description = "AudioControl Hyperion MQTT bridge";
              wantedBy = [ "multi-user.target" ];
              after = [ "network-online.target" ];
              wants = [ "network-online.target" ];
              environment.AUDIOCONTROL_HYPERION_CONFIG = configFile;
              serviceConfig = {
                ExecStart = "${cfg.package}/bin/audiocontrol-hyperion-mqtt";
                EnvironmentFile = lib.mkIf (cfg.environmentFile != null) cfg.environmentFile;
                Restart = "on-failure";
                RestartSec = 3;
                # Hardening — no persistent state, network client only.
                DynamicUser = true;
                NoNewPrivileges = true;
                ProtectSystem = "strict";
                ProtectHome = true;
                PrivateTmp = true;
                PrivateDevices = true;
                ProtectKernelTunables = true;
                ProtectControlGroups = true;
                # AF_UNIX needed for NSS/DNS via systemd-resolved's socket.
                RestrictAddressFamilies = [ "AF_UNIX" "AF_INET" "AF_INET6" ];
                RestrictNamespaces = true;
                LockPersonality = true;
                # No MemoryDenyWriteExecute: V8's JIT requires W^X page
                # transitions and hard-aborts at isolate init under MDWE.
              };
            };
          };
        };
    in
    {
      nixosModules.default = nixosModule;
    }
    // flake-utils.lib.eachDefaultSystem (system:
      let pkgs = nixpkgs.legacyPackages.${system};
      in {
        packages.default = pkgs.buildNpmPackage {
          pname = "audiocontrol-hyperion-mqtt";
          version = "0.1.0";
          src = ./.;
          # TODO: after `npm install` generates package-lock.json, run
          # `nix build` once and replace this with the hash it prints.
          #npmDepsHash = pkgs.lib.fakeHash;
          npmDepsHash = "sha256-OO3+X216PmLXj9l+ab+Q7plKdlePd4PRUQ+wcN83j5A=";
          dontNpmBuild = true;
          meta = {
            description = "MQTT bridge for AudioControl Hyperion processors";
            license = pkgs.lib.licenses.mit;
            mainProgram = "audiocontrol-hyperion-mqtt";
          };
        };

        devShells.default = pkgs.mkShell {
          packages = [ pkgs.nodejs_22 ];
        };
      });
}
