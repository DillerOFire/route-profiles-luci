//! V2Fly / Xray geosite.dat & geoip.dat (protobuf wire format).

use std::io;
use std::net::IpAddr;

use crate::bin_reader::{norm_domain, BinReader};

fn pb_fields(data: &[u8]) -> io::Result<Vec<(u32, u8, &[u8])>> {
    let mut r = BinReader::new(data);
    let mut out = Vec::new();
    while r.remaining() > 0 {
        let tag = r.read_uvarint()?;
        let field = (tag >> 3) as u32;
        let wire = (tag & 7) as u8;
        match wire {
            0 => {
                let start = r.pos();
                let _ = r.read_uvarint()?;
                out.push((field, wire, &data[start..r.pos()]));
            }
            2 => {
                let n = r.read_uvarint()? as usize;
                let b = r.read_exact(n)?;
                out.push((field, wire, b));
            }
            1 => {
                let b = r.read_exact(8)?;
                out.push((field, wire, b));
            }
            5 => {
                let b = r.read_exact(4)?;
                out.push((field, wire, b));
            }
            _ => {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    format!("unsupported protobuf wire type {wire}"),
                ));
            }
        }
    }
    Ok(out)
}

fn pb_varint(raw: &[u8]) -> io::Result<u64> {
    BinReader::new(raw).read_uvarint()
}

pub fn list_codes(data: &[u8]) -> io::Result<Vec<String>> {
    let mut codes = Vec::new();
    for (field, wire, val) in pb_fields(data)? {
        if field != 1 || wire != 2 {
            continue;
        }
        for (f2, w2, v2) in pb_fields(val)? {
            if f2 == 1 && w2 == 2 {
                codes.push(String::from_utf8_lossy(v2).into_owned());
                break;
            }
        }
    }
    Ok(codes)
}

/// Domain types: 0=Plain(keyword) 1=Regex 2=RootDomain 3=Full
pub fn extract_geosite_dat(data: &[u8], category: &str) -> io::Result<Vec<String>> {
    if category.is_empty() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "geosite-dat requires category (e.g. openai, cn)",
        ));
    }
    let want = category.to_ascii_lowercase();
    let mut found = false;
    let mut out = Vec::new();

    for (field, wire, val) in pb_fields(data)? {
        if field != 1 || wire != 2 {
            continue;
        }
        let mut code = String::new();
        let mut domains: Vec<(u64, String)> = Vec::new();
        for (f2, w2, v2) in pb_fields(val)? {
            if f2 == 1 && w2 == 2 {
                code = String::from_utf8_lossy(v2).into_owned();
            } else if f2 == 2 && w2 == 2 {
                let mut dtype = 0u64;
                let mut dval = String::new();
                for (f3, w3, v3) in pb_fields(v2)? {
                    if f3 == 1 && w3 == 0 {
                        dtype = pb_varint(v3)?;
                    } else if f3 == 2 && w3 == 2 {
                        dval = String::from_utf8_lossy(v3).into_owned();
                    }
                }
                if !dval.is_empty() {
                    domains.push((dtype, dval));
                }
            }
        }
        if code.to_ascii_lowercase() != want {
            continue;
        }
        found = true;
        for (dtype, dval) in domains {
            if dtype == 2 || dtype == 3 {
                let d = norm_domain(&dval);
                if !d.is_empty() {
                    out.push(d);
                }
            }
        }
        break;
    }

    if !found {
        let sample: Vec<_> = list_codes(data)?.into_iter().take(12).collect();
        return Err(io::Error::new(
            io::ErrorKind::NotFound,
            format!("category {category:?} not in geosite.dat (sample: {})", sample.join(", ")),
        ));
    }
    Ok(out)
}

pub fn extract_geoip_dat(data: &[u8], category: &str) -> io::Result<Vec<String>> {
    if category.is_empty() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "geoip-dat requires category (e.g. cn, private)",
        ));
    }
    let want = category.to_ascii_lowercase();
    let mut found = false;
    let mut out = Vec::new();

    for (field, wire, val) in pb_fields(data)? {
        if field != 1 || wire != 2 {
            continue;
        }
        let mut code = String::new();
        let mut cidrs = Vec::new();
        for (f2, w2, v2) in pb_fields(val)? {
            if f2 == 1 && w2 == 2 {
                code = String::from_utf8_lossy(v2).into_owned();
            } else if f2 == 2 && w2 == 2 {
                let mut ip_b: &[u8] = &[];
                let mut prefix = 0u64;
                for (f3, w3, v3) in pb_fields(v2)? {
                    if f3 == 1 && w3 == 2 {
                        ip_b = v3;
                    } else if f3 == 2 && w3 == 0 {
                        prefix = pb_varint(v3)?;
                    }
                }
                if let Some(ip) = parse_ip_bytes(ip_b) {
                    cidrs.push(format!("{ip}/{prefix}"));
                }
            }
        }
        if code.to_ascii_lowercase() != want {
            continue;
        }
        found = true;
        out.extend(cidrs);
        break;
    }

    if !found {
        let sample: Vec<_> = list_codes(data)?.into_iter().take(12).collect();
        return Err(io::Error::new(
            io::ErrorKind::NotFound,
            format!("category {category:?} not in geoip.dat (sample: {})", sample.join(", ")),
        ));
    }
    Ok(out)
}

fn parse_ip_bytes(b: &[u8]) -> Option<IpAddr> {
    match b.len() {
        4 => {
            let a: [u8; 4] = b.try_into().ok()?;
            Some(IpAddr::V4(a.into()))
        }
        16 => {
            let a: [u8; 16] = b.try_into().ok()?;
            Some(IpAddr::V6(a.into()))
        }
        _ => None,
    }
}
