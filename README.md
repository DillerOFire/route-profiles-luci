# route-profiles

OpenWrt package that switches router routing with **TOML profiles**. Default is **DIRECT** (WAN). Apply another profile to change the default route and optional selective domain / GeoIP rules.

LuCI UI: **Network → Route Profiles**

> Profiles only control routing. WireGuard / AmneziaWG interfaces must already exist under OpenWrt **Network**.

## Features

- One TOML file = one full routing policy
- Built-in `direct` profile (default)
- Import profiles via CLI or LuCI paste
- Selective domain routing (nftables), up to 8 blocks / devices
- Remote lists: plain text, Xray text, sing-box JSON, plus binary `geosite.dat` / `geoip.dat` / `geosite.db` / `geoip.db` / `.srs` (decoded by a small Rust helper shipped in the package)
- GeoIP WAN bypass from a prefix-list URL + domains
- Boot re-apply (`/etc/init.d/route-profiles`), domain/GeoIP refresh every 30 min via cron
- Automatic preservation of WireGuard/AmneziaWG endpoint paths before default-route changes, including nested tunnels

## Requirements

- OpenWrt 23.05+ (CI builds 23.05, 24.10, SNAPSHOT)
- `nftables`, `luci-base`, `ca-bundle`
- Host **Rust** toolchain when building the package (CI/SDK installs rustup; crates are vendored)

## Install

Download a `.ipk` for your architecture from **[Releases](../../releases)** (CI publishes after each successful `main` build). Pick the file matching your device, e.g. `*_aarch64_cortex-a53.ipk` for MediaTek Filogic.

```sh
# example: Filogic / aarch64_cortex-a53
scp route-profiles_*_aarch64_cortex-a53.ipk root@openwrt.lan:/tmp/
ssh root@openwrt.lan opkg install /tmp/route-profiles_*_aarch64_cortex-a53.ipk
```

Also available as workflow artifacts under [Actions](../../actions). Tag `v*` creates a non-prerelease; pushes to `main` update the `vX.Y.Z` release from `PKG_VERSION` (marked prerelease until you cut a tag).
Build in an OpenWrt SDK / buildroot (this repo is an OpenWrt *feed* root):

```sh
# feeds.conf:
#   src-link routeprofiles /path/to/route-profiles-luci
./scripts/feeds update routeprofiles
./scripts/feeds install route-profiles
make package/route-profiles/compile V=s
```

## Quick start

```sh
route-profiles status
route-profiles list

# Use the shipped BRR example (adjust device name if needed)
cp /etc/route-profiles/profiles/brr.example.toml /etc/route-profiles/profiles/brr.toml
route-profiles apply brr

# Back to WAN
route-profiles apply direct
```

Or use **Network → Route Profiles** in LuCI: apply / edit / show / delete profiles, paste TOML to import, refresh domain/GeoIP sets.

## Profiles

Path: `/etc/route-profiles/profiles/<id>.toml`

| Shipped file | Role |
|--------------|------|
| `direct.toml` | Default — WAN, no selective/GeoIP |
| `brr.example.toml` | Example VPN profile (copy to `brr.toml`) |

### Schema

```toml
name = "BRR"
description = "Default route via AmneziaWG BRR"

[route]
# "direct" | "interface"
type = "interface"
device = "awg_brr"
# gateway = "..."   # optional for type=direct; else UCI wan_gw / DHCP

# Selective blocks (max 8 enabled). Forms:
#   [selective]          single unnamed block
#   [selective.ai]       named blocks (multi-device)
#   [[selective]]        array-of-tables

[selective.ai]
enabled = true
device = "awg_brr"      # omit → route.device when route.type=interface
domains = ["chatgpt.com", "claude.ai"]
lists = [
  # "https://example.com/ai.lst",
  # "xray:https://example.com/geosite-ai.txt",
  # "sing-box:https://example.com/ai-rules.json",
  # "geosite:openai@https://…/geosite.dat",
  # "srs:https://…/geosite-openai.srs",
  # "/etc/route-profiles/lists/local.lst",
]

# [selective.warp]
# enabled = true
# device = "awg_warp"
# domains = ["discord.com"]

[geoip]
enabled = false
source_url = "https://www.ipdeny.com/ipblocks/data/countries/ru.zone"
domains = ["ozon.ru"]
lists = []
```

Each enabled selective block is independent of the default route and gets its own routing table + nft set.

### Remote lists (`lists`)

URL or path; optional `format:` prefix (default: auto-detect for text/JSON).

| Prefix | Format |
|--------|--------|
| *(none)* / `lst:` | One domain or IPv4/CIDR per line (`#` comments) |
| `xray:` / `v2ray:` | Text geosite-style lines: `domain:`, `full:`, bare domains/IPs (`keyword:` / `regexp:` / `geosite:` skipped) |
| `sing-box:` / `singbox:` / `sb:` | sing-box **source** rule-set JSON (`domain`, `domain_suffix`, `ip_cidr`) |
| `geosite:CATEGORY@…` | V2Fly / Xray **`geosite.dat`** — extract one category (e.g. `openai`, `cn`) |
| `geoip:CATEGORY@…` | V2Fly / Xray **`geoip.dat`** — extract one code (e.g. `cn`, `private`) |
| `sing-geosite:CATEGORY@…` | sing-box **`geosite.db`** (aliases: `sb-geosite:`) |
| `sing-geoip:CATEGORY@…` | sing-box **`geoip.db`** (aliases: `sb-geoip:`) |
| `srs:…` | sing-box binary rule-set **`.srs`** (whole file; no category) |

Binary formats are decoded by the **Rust** helper `route-profiles-geoextract` (shipped as a native binary in the ipk; ~400 KiB, no Python). List categories:

```sh
route-profiles-geoextract --list-categories geosite-dat /path/geosite.dat
route-profiles-geoextract --list-categories geosite-db /path/geosite.db
```

Local helper rebuild (host):

```sh
cd route-profiles/geoextract && cargo build --release --offline
./target/release/route-profiles-geoextract geosite-dat /path/geosite.dat openai
```

OpenWrt package source lives in `route-profiles/` (Makefile + files + geoextract).

Examples:

```toml
lists = [
  "geosite:openai@https://github.com/Loyalsoldier/v2ray-rules-dat/releases/latest/download/geosite.dat",
  "geoip:private@https://github.com/Loyalsoldier/v2ray-rules-dat/releases/latest/download/geoip.dat",
  "sing-geosite:openai@https://github.com/SagerNet/sing-geosite/releases/latest/download/geosite.db",
  "srs:https://raw.githubusercontent.com/SagerNet/sing-geosite/rule-set/geosite-openai.srs",
]
```

Inline `domains` and list targets are merged. IPs/CIDRs go into nft; domains are resolved via DNS.

## CLI

```sh
route-profiles status
route-profiles list
route-profiles show <id>
route-profiles apply <id|path>
route-profiles import <path> [id]
route-profiles delete <id>
route-profiles update                 # refresh domain IPs / GeoIP (active profile)
route-profiles teardown
route-profiles help
```

## UCI

`/etc/config/route-profiles`:

```uci
config route-profiles 'settings'
	option active 'direct'
	option profiles_dir '/etc/route-profiles/profiles'
	option wan_dev 'wan'
	option wan_gw ''          # empty = auto from ifstatus/DHCP
```


## License

[GPL-2.0-or-later](LICENSE)
