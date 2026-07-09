# route-profiles

OpenWrt package that switches router routing with **TOML profiles**. Default is **DIRECT** (WAN). Apply another profile to change the default route and optional selective domain / GeoIP rules.

LuCI UI: **Network → Route Profiles**

> Profiles only control routing. WireGuard / AmneziaWG interfaces must already exist under OpenWrt **Network**.

## Features

- One TOML file = one full routing policy
- Built-in `direct` profile (default)
- Import profiles via CLI or LuCI paste
- Selective domain routing (nftables), up to 8 blocks / devices
- GeoIP WAN bypass from a prefix-list URL + domains
- Boot re-apply (`/etc/init.d/route-profiles`), domain/GeoIP refresh every 30 min via cron
- Upgrade from former **vpn-switch**: imports old profiles/UCI, then applies DIRECT

## Requirements

- OpenWrt 23.05+ (CI builds 23.05, 24.10, SNAPSHOT)
- `nftables`, `luci-base`, `ca-bundle` (declared package deps)

## Install

Download a `.ipk` from [GitHub Actions](../../actions) artifacts (or a release if published), then:

```sh
scp route-profiles_*_all.ipk root@openwrt.lan:/tmp/
ssh root@openwrt.lan opkg install /tmp/route-profiles_*_all.ipk
```

Build in an OpenWrt SDK / buildroot:

```sh
ln -s /path/to/route-profiles-luci package/route-profiles
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

Or use **Network → Route Profiles** in LuCI: apply / show / delete profiles, paste TOML to import, refresh domain/GeoIP sets.

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

URL or path; optional `format:` prefix (default: auto-detect).

| Prefix | Format |
|--------|--------|
| *(none)* / `lst:` | One domain or IPv4/CIDR per line (`#` comments) |
| `xray:` / `v2ray:` | `domain:`, `full:`, bare domains/IPs (`keyword:` / `regexp:` / `geosite:` skipped) |
| `sing-box:` / `singbox:` / `sb:` | sing-box rule-set JSON (`domain`, `domain_suffix`, `ip_cidr`) |

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
route-profiles migrate-legacy [--force]
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
	option migrated_v2 '0'
```

## Upgrade from vpn-switch / 1.x

On install, `route-profiles migrate-legacy` runs once when needed:

1. Imports TOML profiles from `/etc/vpn-switch/profiles/` if present
2. Detects live 1.x route, selective, GeoIP, domain files
3. Writes `legacy-snapshot.toml` (and simple slot profiles if old UCI had them)
4. Backs up domain/prefix files under `/etc/route-profiles/backup/<timestamp>/`
5. Tears down old rules/helpers, applies **DIRECT**

```sh
route-profiles apply legacy-snapshot   # restore previous policy
route-profiles migrate-legacy --force  # re-run migration
```

## License

[GPL-2.0-or-later](LICENSE)
