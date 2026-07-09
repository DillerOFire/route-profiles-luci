//! route-profiles-geoextract — extract domains/CIDRs from binary geo rule files.
//!
//! Formats: geosite-dat | geoip-dat | geosite-db | geoip-db | srs | auto

mod bin_reader;
mod dat;
mod geoip_db;
mod geosite_db;
mod srs;

use std::collections::HashSet;
use std::env;
use std::fs;
use std::io::{self, Write};
use std::process::ExitCode;

fn usage() -> ! {
    eprintln!(
        "\
Usage:
  route-profiles-geoextract <format> <file> [category]
  route-profiles-geoextract --list-categories <format> <file>

Formats:
  geosite-dat   V2Fly/Xray geosite.dat  (category required)
  geoip-dat     V2Fly/Xray geoip.dat    (category required)
  geosite-db    sing-box geosite.db     (category required)
  geoip-db      sing-box geoip.db       (category required)
  srs           sing-box binary rule-set
  auto          detect from content"
    );
    std::process::exit(2);
}

fn detect_format(data: &[u8], category: Option<&str>) -> io::Result<&'static str> {
    if data.len() >= 4 && &data[..3] == b"SRS" {
        return Ok("srs");
    }
    if find_marker(data, b"\xab\xcd\xefMaxMind.com").is_some() {
        return Ok("geoip-db");
    }
    if !data.is_empty() && data[0] == 0 {
        if category.map(|c| !c.is_empty()).unwrap_or(false) {
            if let Ok(codes) = geosite_db::list_codes(data) {
                if !codes.is_empty() {
                    return Ok("geosite-db");
                }
            }
        }
    }
    if category.map(|c| !c.is_empty()).unwrap_or(false) {
        let sample_len = data.len().min(256 * 1024);
        if let Some(kind) = sniff_pb(&data[..sample_len]) {
            return Ok(kind);
        }
    }
    Err(io::Error::new(
        io::ErrorKind::InvalidData,
        "cannot auto-detect format; use geosite-dat|geoip-dat|geosite-db|geoip-db|srs",
    ))
}

fn find_marker(data: &[u8], marker: &[u8]) -> Option<usize> {
    data.windows(marker.len()).rposition(|w| w == marker)
}

fn sniff_pb(data: &[u8]) -> Option<&'static str> {
    // light copy of field walk for first entry only
    use crate::bin_reader::BinReader;
    let mut r = BinReader::new(data);
    let tag = r.read_uvarint().ok()?;
    if tag >> 3 != 1 || tag & 7 != 2 {
        return None;
    }
    let n = r.read_uvarint().ok()? as usize;
    let val = r.read_exact(n).ok()?;
    let mut has_cidr = false;
    let mut has_domain = false;
    let mut r2 = BinReader::new(val);
    while r2.remaining() > 0 {
        let t = r2.read_uvarint().ok()?;
        let f = t >> 3;
        let w = t & 7;
        if w != 2 {
            if w == 0 {
                let _ = r2.read_uvarint().ok()?;
            } else if w == 1 {
                let _ = r2.read_exact(8).ok()?;
            } else if w == 5 {
                let _ = r2.read_exact(4).ok()?;
            } else {
                return None;
            }
            continue;
        }
        let ln = r2.read_uvarint().ok()? as usize;
        let v = r2.read_exact(ln).ok()?;
        if f == 2 {
            let mut r3 = BinReader::new(v);
            while r3.remaining() > 0 {
                let t3 = r3.read_uvarint().ok()?;
                let f3 = t3 >> 3;
                let w3 = t3 & 7;
                if w3 == 2 {
                    let ln3 = r3.read_uvarint().ok()? as usize;
                    let v3 = r3.read_exact(ln3).ok()?;
                    if f3 == 1 && (v3.len() == 4 || v3.len() == 16) {
                        has_cidr = true;
                    }
                    if f3 == 2 {
                        has_domain = true;
                    }
                } else if w3 == 0 {
                    let _ = r3.read_uvarint().ok()?;
                } else if w3 == 1 {
                    let _ = r3.read_exact(8).ok()?;
                } else if w3 == 5 {
                    let _ = r3.read_exact(4).ok()?;
                } else {
                    break;
                }
            }
        }
    }
    if has_cidr && !has_domain {
        Some("geoip-dat")
    } else if has_domain {
        Some("geosite-dat")
    } else {
        None
    }
}

fn extract(fmt: &str, data: &[u8], category: Option<&str>) -> io::Result<Vec<String>> {
    let fmt = if fmt == "auto" {
        detect_format(data, category)?
    } else {
        fmt
    };
    match fmt {
        "geosite-dat" | "geosite_dat" | "xray-geosite" | "v2ray-geosite" => {
            dat::extract_geosite_dat(data, category.unwrap_or(""))
        }
        "geoip-dat" | "geoip_dat" | "xray-geoip" | "v2ray-geoip" => {
            dat::extract_geoip_dat(data, category.unwrap_or(""))
        }
        "geosite-db" | "geosite_db" | "sing-geosite" => {
            geosite_db::extract_geosite_db(data, category.unwrap_or(""))
        }
        "geoip-db" | "geoip_db" | "sing-geoip" => {
            geoip_db::extract_geoip_db(data, category.unwrap_or(""))
        }
        "srs" | "sing-srs" | "rule-set" => srs::extract_srs(data),
        other => Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("unknown format {other:?}"),
        )),
    }
}

fn list_categories(fmt: &str, data: &[u8]) -> io::Result<()> {
    let fmt = if fmt == "auto" {
        if data.len() >= 3 && &data[..3] == b"SRS" {
            eprintln!("(srs has no categories)");
            return Ok(());
        }
        if find_marker(data, b"\xab\xcd\xefMaxMind.com").is_some() {
            for c in geoip_db::list_languages(data)? {
                println!("{c}");
            }
            return Ok(());
        }
        detect_format(data, Some("cn")).unwrap_or("geosite-dat")
    } else {
        fmt
    };

    match fmt {
        "geosite-dat" | "geoip-dat" => {
            for c in dat::list_codes(data)? {
                println!("{c}");
            }
        }
        "geosite-db" => {
            for c in geosite_db::list_codes(data)? {
                println!("{c}");
            }
        }
        "srs" => eprintln!("(srs has no categories — whole file is one rule-set)"),
        "geoip-db" => {
            for c in geoip_db::list_languages(data)? {
                println!("{c}");
            }
        }
        other => {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                format!("list-categories unsupported for {other}"),
            ));
        }
    }
    Ok(())
}

fn main() -> ExitCode {
    let mut args: Vec<String> = env::args().skip(1).collect();
    if args.is_empty() {
        usage();
    }

    let list_cats = if args[0] == "--list-categories" {
        args.remove(0);
        true
    } else {
        false
    };

    if args.len() < 2 {
        usage();
    }
    let format = args[0].as_str();
    let file = args[1].as_str();
    let category = args.get(2).map(|s| s.as_str());

    let data = match fs::read(file) {
        Ok(d) => d,
        Err(e) => {
            eprintln!("error: read {file}: {e}");
            return ExitCode::from(2);
        }
    };

    if list_cats {
        return match list_categories(format, &data) {
            Ok(()) => ExitCode::SUCCESS,
            Err(e) => {
                eprintln!("error: {e}");
                ExitCode::FAILURE
            }
        };
    }

    match extract(format, &data, category) {
        Ok(items) => {
            let mut seen = HashSet::new();
            let stdout = io::stdout();
            let mut out = stdout.lock();
            for it in items {
                let it = it.trim();
                if it.is_empty() || !seen.insert(it.to_string()) {
                    continue;
                }
                let _ = writeln!(out, "{it}");
            }
            ExitCode::SUCCESS
        }
        Err(e) => {
            eprintln!("error: {e}");
            ExitCode::FAILURE
        }
    }
}
