//! sing-box binary rule-set (.srs)

use std::collections::HashMap;
use std::io::{self, Read};
use std::net::IpAddr;

use flate2::read::ZlibDecoder;

use crate::bin_reader::{norm_domain, BinReader};

const PREFIX_LABEL: u8 = 0x0d;
const ROOT_LABEL: u8 = 0x0a;

// --- succinct domain set (from sagernet/sing) ---

struct SuccinctSet {
    leaves: Vec<u64>,
    label_bitmap: Vec<u64>,
    labels: Vec<u8>,
    selects: Vec<i32>,
    ranks: Vec<i32>,
}

fn bits_ones(x: u64) -> u32 {
    x.count_ones()
}

fn index_rank64(words: &[u64], trailing: bool) -> Vec<i32> {
    let l = words.len() + if trailing { 1 } else { 0 };
    let mut idx = vec![0i32; l];
    let mut n = 0i32;
    for (i, w) in words.iter().enumerate() {
        idx[i] = n;
        n += bits_ones(*w) as i32;
    }
    if trailing {
        idx[words.len()] = n;
    }
    idx
}

fn index_select32_r64(words: &[u64]) -> (Vec<i32>, Vec<i32>) {
    let total_bits = words.len() << 6;
    let mut sidx = Vec::new();
    let mut ith = -1i32;
    for i in 0..total_bits {
        if words[i >> 6] & (1u64 << (i & 63)) != 0 {
            ith += 1;
            if ith & 31 == 0 {
                sidx.push(i as i32);
            }
        }
    }
    (sidx, index_rank64(words, true))
}

fn rank64(words: &[u64], rindex: &[i32], i: i32) -> (i32, i32) {
    let word_i = (i >> 6) as usize;
    let j = (i & 63) as u32;
    let n = rindex[word_i];
    let w = words[word_i];
    let mask = if j == 0 { 0 } else { (1u64 << j) - 1 };
    let c1 = n + bits_ones(w & mask) as i32;
    ((c1), ((w >> j) & 1) as i32)
}

// select8 lookup table (256 * 8)
fn build_select8() -> Vec<u8> {
    let mut t = vec![0u8; 256 * 8];
    for i in 0..256 {
        let mut w = i as u8;
        for j in 0..8 {
            if w == 0 {
                t[i * 8 + j] = 8;
            } else {
                let x = w.trailing_zeros() as u8;
                t[i * 8 + j] = x;
                w &= w.wrapping_sub(1);
            }
        }
    }
    t
}

fn select32_r64(
    words: &[u64],
    select_index: &[i32],
    rank_index: &[i32],
    select8: &[u8],
    i: i32,
) -> (i32, i32) {
    let l = words.len() as i32;
    let mut word_i = (select_index[(i >> 5) as usize] >> 6) as i32;
    while rank_index[(word_i + 1) as usize] <= i {
        word_i += 1;
    }
    let mut w = words[word_i as usize];
    let mut ww = w;
    let base = word_i << 6;
    let mut find_ith = i - rank_index[word_i as usize];
    let mut offset = 0i32;
    let mut ones = bits_ones(ww & 0xffff_ffff) as i32;
    if ones <= find_ith {
        find_ith -= ones;
        offset |= 32;
        ww >>= 32;
    }
    ones = bits_ones(ww & 0xffff) as i32;
    if ones <= find_ith {
        find_ith -= ones;
        offset |= 16;
        ww >>= 16;
    }
    ones = bits_ones(ww & 0xff) as i32;
    let a = if ones <= find_ith {
        let idx = (((ww >> 5) as usize) & 0x7f8) | (find_ith - ones) as usize;
        select8[idx] as i32 + offset + 8
    } else {
        let idx = (((ww & 0xff) as usize) << 3) | find_ith as usize;
        select8[idx] as i32 + offset
    };
    let a = a + base;
    let rmask = if (a & 63) == 63 {
        0u64
    } else {
        !((1u64 << ((a & 63) + 1)) - 1)
    };
    w &= rmask;
    if w != 0 {
        return (a, base + w.trailing_zeros() as i32);
    }
    word_i += 1;
    while word_i < l {
        w = words[word_i as usize];
        if w != 0 {
            return (a, (word_i << 6) + w.trailing_zeros() as i32);
        }
        word_i += 1;
    }
    (a, l << 6)
}

impl SuccinctSet {
    fn get_bit(bm: &[u64], i: i32) -> bool {
        bm[(i >> 6) as usize] & (1u64 << (i & 63)) != 0
    }

    fn keys(&self, select8: &[u8]) -> Vec<Vec<u8>> {
        let mut result = Vec::new();
        let mut current = Vec::new();

        fn traverse(
            ss: &SuccinctSet,
            select8: &[u8],
            node_id: i32,
            mut bm_idx: i32,
            current: &mut Vec<u8>,
            result: &mut Vec<Vec<u8>>,
        ) {
            if SuccinctSet::get_bit(&ss.leaves, node_id) {
                result.push(current.clone());
            }
            loop {
                if SuccinctSet::get_bit(&ss.label_bitmap, bm_idx) {
                    return;
                }
                let next_label = ss.labels[(bm_idx - node_id) as usize];
                current.push(next_label);
                let (a, _) = rank64(&ss.label_bitmap, &ss.ranks, bm_idx + 1);
                let next_node_id = (bm_idx + 1) - a;
                let next_bm_idx = select32_r64(
                    &ss.label_bitmap,
                    &ss.selects,
                    &ss.ranks,
                    select8,
                    next_node_id - 1,
                )
                .0 + 1;
                traverse(ss, select8, next_node_id, next_bm_idx, current, result);
                current.pop();
                bm_idx += 1;
            }
        }

        traverse(self, select8, 0, 0, &mut current, &mut result);
        result
    }
}

fn read_u64_slice(r: &mut BinReader<'_>) -> io::Result<Vec<u64>> {
    let length = r.read_uvarint()? as usize;
    let mut out = Vec::with_capacity(length);
    for _ in 0..length {
        out.push(r.read_u64_be()?);
    }
    Ok(out)
}

fn read_byte_slice(r: &mut BinReader<'_>) -> io::Result<Vec<u8>> {
    let length = r.read_uvarint()? as usize;
    if length == 0 {
        return Ok(Vec::new());
    }
    Ok(r.read_exact(length)?.to_vec())
}

fn read_succinct_set(r: &mut BinReader<'_>) -> io::Result<SuccinctSet> {
    let _ = r.read_u8()?;
    let leaves = read_u64_slice(r)?;
    let label_bitmap = read_u64_slice(r)?;
    let labels = read_byte_slice(r)?;
    let (selects, ranks) = index_select32_r64(&label_bitmap);
    Ok(SuccinctSet {
        leaves,
        label_bitmap,
        labels,
        selects,
        ranks,
    })
}

fn dump_matcher(ss: &SuccinctSet, select8: &[u8]) -> (Vec<String>, Vec<String>) {
    let mut domain_map: HashMap<String, bool> = HashMap::new();
    let mut prefix_map: HashMap<String, bool> = HashMap::new();
    let mut prefix_list: Vec<String> = Vec::new();

    for key in ss.keys(select8) {
        let rev: Vec<u8> = key.iter().rev().copied().collect();
        if rev.is_empty() {
            continue;
        }
        match rev[0] {
            PREFIX_LABEL => {
                let s = String::from_utf8_lossy(&rev[1..]).into_owned();
                prefix_map.insert(s, true);
            }
            ROOT_LABEL => {
                prefix_list.push(String::from_utf8_lossy(&rev[1..]).into_owned());
            }
            _ => {
                domain_map.insert(String::from_utf8_lossy(&rev).into_owned(), true);
            }
        }
    }

    let mut out_prefix = prefix_list;
    for raw_prefix in prefix_map.keys() {
        if let Some(root) = raw_prefix.strip_prefix('.') {
            if domain_map.remove(root).is_some() {
                out_prefix.push(root.to_string());
                continue;
            }
        }
        out_prefix.push(raw_prefix.clone());
    }

    let mut domains: Vec<_> = domain_map.into_keys().collect();
    domains.sort();
    out_prefix.sort();
    (domains, out_prefix)
}

fn read_string_list(r: &mut BinReader<'_>) -> io::Result<Vec<String>> {
    let n = r.read_uvarint()? as usize;
    let mut out = Vec::with_capacity(n);
    for _ in 0..n {
        out.push(r.read_string()?);
    }
    Ok(out)
}

fn read_ip_set(r: &mut BinReader<'_>) -> io::Result<Vec<String>> {
    let version = r.read_u8()?;
    if version != 1 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("unsupported IP set version {version}"),
        ));
    }
    let length = r.read_u64_be()? as usize;
    let mut out = Vec::new();
    for _ in 0..length {
        let frm = r.read_bytes_lp()?;
        let to = r.read_bytes_lp()?;
        let (Ok(a), Ok(b)) = (parse_ip(frm), parse_ip(to)) else {
            continue;
        };
        if a.is_ipv4() != b.is_ipv4() {
            continue;
        }
        out.extend(range_to_cidrs(a, b));
    }
    Ok(out)
}

fn parse_ip(b: &[u8]) -> Result<IpAddr, ()> {
    match b.len() {
        4 => Ok(IpAddr::V4(<[u8; 4]>::try_from(b).unwrap().into())),
        16 => Ok(IpAddr::V6(<[u8; 16]>::try_from(b).unwrap().into())),
        _ => Err(()),
    }
}

fn range_to_cidrs(start: IpAddr, end: IpAddr) -> Vec<String> {
    let (mut cur, end_i, max_bits) = match (start, end) {
        (IpAddr::V4(a), IpAddr::V4(b)) => {
            (u128::from(u32::from(a)), u128::from(u32::from(b)), 32u32)
        }
        (IpAddr::V6(a), IpAddr::V6(b)) => (u128::from(a), u128::from(b), 128u32),
        _ => return Vec::new(),
    };
    let mut out = Vec::new();
    while cur <= end_i {
        let max_align = if cur == 0 {
            max_bits
        } else {
            cur.trailing_zeros().min(max_bits)
        };
        let mut host_bits = 0u32;
        while host_bits < max_align && cur + (1u128 << (host_bits + 1)) - 1 <= end_i {
            host_bits += 1;
        }
        let prefix = max_bits - host_bits;
        let cidr = if max_bits == 32 {
            let ip = Ipv4Addr::from(cur as u32);
            format!("{ip}/{prefix}")
        } else {
            let ip = Ipv6Addr::from(cur);
            format!("{ip}/{prefix}")
        };
        out.push(cidr);
        cur += 1u128 << host_bits;
    }
    out
}

use std::net::{Ipv4Addr, Ipv6Addr};

fn read_default_rule(r: &mut BinReader<'_>, select8: &[u8]) -> io::Result<Vec<String>> {
    let mut out = Vec::new();
    let mut last = 0u8;
    loop {
        let item = r.read_u8()?;
        if item == 0xff {
            let _ = r.read_u8()?; // invert
            return Ok(out);
        }
        match item {
            0 => {
                let n = r.read_uvarint()? as usize;
                let _ = r.read_exact(n * 2)?;
            }
            1 => {
                let _ = read_string_list(r)?;
            }
            2 => {
                let ss = read_succinct_set(r)?;
                let (domains, suffixes) = dump_matcher(&ss, select8);
                for d in domains.into_iter().chain(suffixes) {
                    let d = norm_domain(&d);
                    if !d.is_empty() {
                        out.push(d);
                    }
                }
            }
            3 | 4 | 8 | 10 | 11 | 12 | 13 | 14 | 15 | 17 => {
                let _ = read_string_list(r)?;
            }
            5 => {
                let _ = read_ip_set(r)?;
            }
            6 => {
                out.extend(read_ip_set(r)?);
            }
            7 | 9 => {
                let n = r.read_uvarint()? as usize;
                let _ = r.read_exact(n * 2)?;
            }
            16 => {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "AdGuard domain rules in .srs cannot be decompiled",
                ));
            }
            18 => {
                let n = r.read_uvarint()? as usize;
                let _ = r.read_exact(n)?;
            }
            19 | 20 => {}
            _ => {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    format!("unknown rule item type {item} (last={last})"),
                ));
            }
        }
        last = item;
    }
}

fn read_rule(r: &mut BinReader<'_>, select8: &[u8]) -> io::Result<Vec<String>> {
    let rtype = r.read_u8()?;
    match rtype {
        0 => read_default_rule(r, select8),
        1 => {
            let _ = r.read_u8()?; // mode
            let n = r.read_uvarint()? as usize;
            let mut out = Vec::new();
            for _ in 0..n {
                out.extend(read_rule(r, select8)?);
            }
            let _ = r.read_u8()?; // invert
            Ok(out)
        }
        _ => Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("unknown rule type {rtype}"),
        )),
    }
}

pub fn extract_srs(data: &[u8]) -> io::Result<Vec<String>> {
    if data.len() < 4 || &data[..3] != b"SRS" {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "not a sing-box .srs file (missing SRS magic)",
        ));
    }
    let version = data[3];
    if version > 4 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("unsupported .srs version {version}"),
        ));
    }
    let mut dec = ZlibDecoder::new(&data[4..]);
    let mut payload = Vec::new();
    dec.read_to_end(&mut payload).map_err(|e| {
        io::Error::new(
            io::ErrorKind::InvalidData,
            format!("zlib decompress failed: {e}"),
        )
    })?;
    let mut r = BinReader::new(&payload);
    let n = r.read_uvarint()? as usize;
    let select8 = build_select8();
    let mut out = Vec::new();
    for i in 0..n {
        match read_rule(&mut r, &select8) {
            Ok(items) => out.extend(items),
            Err(e) => {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    format!("read rule[{i}]: {e}"),
                ));
            }
        }
    }
    Ok(out)
}
