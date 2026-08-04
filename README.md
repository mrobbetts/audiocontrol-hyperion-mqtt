# audiocontrol-hyperion-mqtt

An MQTT bridge for **AudioControl Hyperion** processors (the **Axis** eARC→Dante
range — Axis2 / Axis10 / Axis16, and likely the wider Hyperion/ACP family). It
owns a persistent TCP/23 connection to each device, speaks the ASCII "ACP"
protocol, and exposes state + control as retained MQTT topics so Node-RED, Home
Assistant, or your GLM tooling can drive it without touching the socket.

## Design

A small **pure core / impure shell** split:

| File | Purity | Role |
|------|--------|------|
| `src/protocol.mjs` | pure data | command builders, response matchers, poll sets — the wire protocol as tables |
| `src/codec.mjs` | pure | `encode(name, arg)` / `parse(line)` |
| `src/state.mjs` | pure | immutable state + `applyEvent` reducer (emits deltas) |
| `src/transport.mjs` | I/O | socket, CRLF framing, **serialized** command queue, reconnect, poll |
| `src/mqtt.mjs` | I/O | LWT availability, retained status publish, prefix-scoped subscribe |
| `src/device.mjs` | glue | wires transport + codec + state + MQTT for one unit |
| `src/index.mjs` | glue | config → N devices, graceful shutdown |

The device is **request/response with no documented async push**, so the bridge
polls. If a bench test shows the unit echoes state unsolicited, raise
`poll.intervalMs` and let events carry most updates.

## MQTT interface

Topic prefix defaults to `audiocontrol/hyperion` (configurable).

**Status** (retained, published on change): `…/<id>/status/<path>`

```
…/theatre/status/connected            true|false
…/theatre/status/power                true|false
…/theatre/status/input                earc|digital
…/theatre/status/inputFormat          "Dolby Atmos"      (≤30 chars, device text)
…/theatre/status/outputFormat         "…"
…/theatre/status/audioMode            native|2chStereo|allChStereo|dolbySurround|dolbyMode
…/theatre/status/speaker/volume       0..100
…/theatre/status/speaker/mute         true|false
…/theatre/status/downmix/volume       0..100
…/theatre/status/downmix/follow       on|off|defeat
…/theatre/status/sub/mute             true|false
…/theatre/status/inputs/earc/drc      off|on|auto
…/bridge/status                       online|offline   (LWT)
```

**Commands**: publish to `…/<id>/set/<path>`

```
…/theatre/set/power             on|off
…/theatre/set/input             earc|digital
…/theatre/set/speaker/volume    30
…/theatre/set/speaker/volumeStep   3 | -2       (native relative step)
…/theatre/set/speaker/mute      on|off
…/theatre/set/downmix/volume    25
…/theatre/set/downmix/follow    off|on|defeat
…/theatre/set/audioMode         dolbySurround
…/theatre/set/inputs/earc/drc   auto
…/theatre/set/inputs/digital/volDefeat  on|off  (digital only; eARC not defeatable)
…/theatre/set/raw               SET VOL 40      (verbatim ACP passthrough)
```

## Run locally (via nix)

```bash
nix develop            # or: nix-shell -p nodejs_22
npm install            # generates package-lock.json (needed by the flake build)
npm test               # pure codec/state tests, no broker needed
AUDIOCONTROL_HYPERION_CONFIG=./config.example.json npm start
```

Env overrides (win over the config file): `MQTT_URL`, `MQTT_PREFIX`,
`MQTT_USERNAME`, `MQTT_PASSWORD`, `MQTT_CLIENT_ID`, `LOG_LEVEL`.

## Deploy on NixOS

The flake exposes `nixosModules.default`. In your system flake:

```nix
{
  inputs.hyperion.url = "path:/path/to/audiocontrol-hyperion-mqtt"; # or a git URL

  outputs = { nixpkgs, hyperion, ... }: {
    nixosConfigurations.flare = nixpkgs.lib.nixosSystem {
      modules = [
        hyperion.nixosModules.default
        {
          services.audiocontrol-hyperion-mqtt = {
            enable = true;
            mqtt.url = "mqtt://10.0.0.2:1883";
            mqtt.prefix = "audiocontrol/hyperion";
            environmentFile = "/run/secrets/hyperion-mqtt.env";  # MQTT_PASSWORD=…
            devices = [
              { id = "theatre"; host = "10.0.0.50"; }
              { id = "living-room"; host = "10.0.0.51"; pollIntervalMs = 5000; }
            ];
          };
        }
      ];
    };
  };
}
```

### One-time build hash

`buildNpmPackage` needs `package-lock.json` and a deps hash. After `npm install`
creates the lock, run `nix build`; it will fail and print the real
`npmDepsHash` — paste that into `flake.nix` (replacing `pkgs.lib.fakeHash`).

## Status / TODO

- Protocol verified against the published ACP API + decompiled Crestron driver.
- **Bench-confirm** on real hardware: line terminator behaviour under load, the
  exact `INPUT FORMAT` vocabulary (DD/DTS/Atmos strings), and whether the unit
  emits any unsolicited lines (would let us cut polling).
- Model table is currently one shared command set; split per-model in
  `protocol.mjs` if the amps / APR-16 diverge.
