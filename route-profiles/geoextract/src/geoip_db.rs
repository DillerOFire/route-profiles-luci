//! sing-box geoip.db (MaxMind MMDB, type sing-geoip).

use std::io;
use std::net::{Ipv4Addr, Ipv6Addr};

const MARKER: &[u8] = b"\xab\xcd\xefMaxMind.com";

pub struct Mmdb<'a> {
    data: &'a [u8],
    node_count: u32,
    record_size: u16,
    ip_version: u16,
    tree_size: usize,
    data_section_start: usize,
    languages: Vec<String>,
}

impl<'a> Mmdb<'a> {
    pub fn open(data: &'a [u8]) -> io::Result<Self> {
        let idx = data
            .windows(MARKER.len())
            .rposition(|w| w == MARKER)
            .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "not a MaxMind MMDB"))?;
        let meta_start = idx + MARKER.len();
        let meta = decode_at(data, meta_start, meta_start)?;
        let Meta {
            node_count,
            record_size,
            ip_version,
            languages,
        } = parse_meta(&meta)?;
        let tree_size = node_count as usize * record_size as usize / 4;
        Ok(Self {
            data,
            node_count,
            record_size,
            ip_version,
            tree_size,
            data_section_start: tree_size + 16,
            languages,
        })
    }

    pub fn languages(&self) -> &[String] {
        &self.languages
    }

    fn read_node(&self, node: u32) -> io::Result<(u32, u32)> {
        let rs = self.record_size;
        let data = self.data;
        match rs {
            24 => {
                let off = node as usize * 6;
                if off + 6 > data.len() {
                    return Err(eof());
                }
                let b = &data[off..off + 6];
                let left = (u32::from(b[0]) << 16) | (u32::from(b[1]) << 8) | u32::from(b[2]);
                let right = (u32::from(b[3]) << 16) | (u32::from(b[4]) << 8) | u32::from(b[5]);
                Ok((left, right))
            }
            28 => {
                let off = node as usize * 7;
                if off + 7 > data.len() {
                    return Err(eof());
                }
                let b = &data[off..off + 7];
                let left = ((u32::from(b[3]) >> 4) << 24)
                    | (u32::from(b[0]) << 16)
                    | (u32::from(b[1]) << 8)
                    | u32::from(b[2]);
                let right = ((u32::from(b[3]) & 0x0f) << 24)
                    | (u32::from(b[4]) << 16)
                    | (u32::from(b[5]) << 8)
                    | u32::from(b[6]);
                Ok((left, right))
            }
            32 => {
                let off = node as usize * 8;
                if off + 8 > data.len() {
                    return Err(eof());
                }
                let left = u32::from_be_bytes(data[off..off + 4].try_into().unwrap());
                let right = u32::from_be_bytes(data[off + 4..off + 8].try_into().unwrap());
                Ok((left, right))
            }
            _ => Err(io::Error::new(
                io::ErrorKind::InvalidData,
                format!("unsupported record_size {rs}"),
            )),
        }
    }

    fn data_for_node(&self, node: u32) -> io::Result<Option<String>> {
        if node <= self.node_count {
            return Ok(None);
        }
        let off = self.tree_size + (node - self.node_count) as usize;
        if off >= self.data.len() {
            return Ok(None);
        }
        match decode_at(self.data, off, self.data_section_start)? {
            Value::String(s) => Ok(Some(s)),
            other => Ok(Some(other.to_display())),
        }
    }

    /// Collect all networks whose data equals `want` (case-insensitive).
    pub fn walk_code(&self, want: &str) -> io::Result<Vec<String>> {
        let want_l = want.to_ascii_lowercase();
        let mut out = Vec::new();

        if self.ip_version == 4 {
            self.walk_iter(&want_l, 0, 0, 0, 32, true, &mut out)?;
        } else {
            // sing-geoip: DisableIPv4Aliasing → IPv4 under ::/96
            let mut node = 0u32;
            let mut ok = true;
            for _ in 0..96 {
                let (left, _) = self.read_node(node)?;
                node = left;
                if node >= self.node_count {
                    ok = false;
                    break;
                }
            }
            if ok {
                self.walk_iter(&want_l, node, 0, 0, 32, true, &mut out)?;
            }
            self.walk_iter(&want_l, 0, 0, 0, 128, false, &mut out)?;
        }
        Ok(out)
    }

    /// Iterative DFS to avoid deep recursion cost.
    fn walk_iter(
        &self,
        want: &str,
        start_node: u32,
        start_bits: u128,
        start_depth: u8,
        max_depth: u8,
        v4: bool,
        out: &mut Vec<String>,
    ) -> io::Result<()> {
        // stack: (node, bits, depth)
        let mut stack: Vec<(u32, u128, u8)> = vec![(start_node, start_bits, start_depth)];
        while let Some((node, bits, depth)) = stack.pop() {
            if node > self.node_count {
                if let Some(code) = self.data_for_node(node)? {
                    if code.eq_ignore_ascii_case(want) {
                        if !v4 {
                            // skip IPv4-under-::/96 duplicates (first 96 bits zero, depth>96)
                            if depth > 96 && (bits >> (depth - 96)) == 0 {
                                continue;
                            }
                        }
                        if let Some(cidr) = emit_net(bits, depth, v4) {
                            out.push(cidr);
                        }
                    }
                }
                continue;
            }
            if node == self.node_count || depth >= max_depth {
                continue;
            }
            let (left, right) = self.read_node(node)?;
            // push right first so left is processed first (stable-ish order)
            stack.push((right, (bits << 1) | 1, depth + 1));
            stack.push((left, bits << 1, depth + 1));
        }
        Ok(())
    }
}

fn emit_net(bits: u128, depth: u8, v4: bool) -> Option<String> {
    if v4 {
        let shift = 32u8.saturating_sub(depth);
        let addr = (bits as u32) << shift;
        let ip = Ipv4Addr::from(addr);
        Some(format!("{ip}/{depth}"))
    } else {
        let shift = 128u8.saturating_sub(depth);
        let addr = bits << shift;
        let ip = Ipv6Addr::from(addr);
        Some(format!("{ip}/{depth}"))
    }
}

fn eof() -> io::Error {
    io::Error::new(io::ErrorKind::UnexpectedEof, "EOF")
}

enum Value {
    String(String),
    #[allow(dead_code)]
    Bytes(Vec<u8>),
    U64(u64),
    I64(i64),
    #[allow(dead_code)]
    F64(f64),
    Bool(bool),
    Map(Vec<(String, Value)>),
    Array(Vec<Value>),
    Null,
}

impl Value {
    fn to_display(&self) -> String {
        match self {
            Value::String(s) => s.clone(),
            Value::U64(n) => n.to_string(),
            Value::I64(n) => n.to_string(),
            Value::Bool(b) => b.to_string(),
            _ => String::new(),
        }
    }

    fn as_u64(&self) -> Option<u64> {
        match self {
            Value::U64(n) => Some(*n),
            Value::I64(n) if *n >= 0 => Some(*n as u64),
            _ => None,
        }
    }

    fn as_str(&self) -> Option<&str> {
        match self {
            Value::String(s) => Some(s),
            _ => None,
        }
    }
}

struct Meta {
    node_count: u32,
    record_size: u16,
    ip_version: u16,
    languages: Vec<String>,
}

fn parse_meta(v: &Value) -> io::Result<Meta> {
    let Value::Map(entries) = v else {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "invalid MMDB metadata",
        ));
    };
    let mut node_count = 0u32;
    let mut record_size = 0u16;
    let mut ip_version = 6u16;
    let mut languages = Vec::new();
    for (k, val) in entries {
        match k.as_str() {
            "node_count" => node_count = val.as_u64().unwrap_or(0) as u32,
            "record_size" => record_size = val.as_u64().unwrap_or(0) as u16,
            "ip_version" => ip_version = val.as_u64().unwrap_or(6) as u16,
            "languages" => {
                if let Value::Array(arr) = val {
                    for a in arr {
                        if let Some(s) = a.as_str() {
                            languages.push(s.to_string());
                        }
                    }
                }
            }
            _ => {}
        }
    }
    if node_count == 0 || record_size == 0 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "MMDB metadata missing node_count/record_size",
        ));
    }
    Ok(Meta {
        node_count,
        record_size,
        ip_version,
        languages,
    })
}

fn decode_at(data: &[u8], offset: usize, data_base: usize) -> io::Result<Value> {
    let mut pos = offset;
    decode_val(data, &mut pos, data_base)
}

fn decode_val(data: &[u8], pos: &mut usize, data_base: usize) -> io::Result<Value> {
    let ctrl = read_u8(data, pos)?;
    let mut typ = ctrl >> 5;
    if typ == 1 {
        // pointer
        let size = (ctrl >> 3) & 0x3;
        let p = match size {
            0 => u32::from(read_u8(data, pos)?),
            1 => ((u32::from(ctrl & 7) << 8) + u32::from(read_u8(data, pos)?)) + 2048,
            2 => {
                let b1 = read_u8(data, pos)?;
                let b2 = read_u8(data, pos)?;
                ((u32::from(ctrl & 7) << 16) + (u32::from(b1) << 8) + u32::from(b2)) + 526_336
            }
            _ => read_u32_be(data, pos)?,
        };
        return decode_at(data, data_base + p as usize, data_base);
    }
    if typ == 0 {
        typ = 7 + read_u8(data, pos)?;
    }
    let mut size = u32::from(ctrl & 0x1f);
    if size == 29 {
        size = 29 + u32::from(read_u8(data, pos)?);
    } else if size == 30 {
        size = 285 + u32::from(read_u16_be(data, pos)?);
    } else if size == 31 {
        size = 65_821 + read_u24_be(data, pos)?;
    }

    match typ {
        2 => {
            let b = read_slice(data, pos, size as usize)?;
            Ok(Value::String(String::from_utf8_lossy(b).into_owned()))
        }
        3 => {
            let b = read_slice(data, pos, 8)?;
            let n = f64::from_be_bytes(b.try_into().unwrap());
            Ok(Value::F64(n))
        }
        4 => {
            let b = read_slice(data, pos, size as usize)?;
            Ok(Value::Bytes(b.to_vec()))
        }
        5 | 6 | 9 | 10 => {
            let b = read_slice(data, pos, size as usize)?;
            Ok(Value::U64(int_be(b)))
        }
        7 => {
            let mut map = Vec::with_capacity(size as usize);
            for _ in 0..size {
                let key = decode_val(data, pos, data_base)?;
                let val = decode_val(data, pos, data_base)?;
                let k = match key {
                    Value::String(s) => s,
                    other => other.to_display(),
                };
                map.push((k, val));
            }
            Ok(Value::Map(map))
        }
        8 => {
            let b = read_slice(data, pos, size as usize)?;
            if b.is_empty() {
                return Ok(Value::I64(0));
            }
            let mut v = int_be(b) as i64;
            let bits = b.len() * 8;
            if b[0] & 0x80 != 0 {
                v -= 1i64 << bits;
            }
            Ok(Value::I64(v))
        }
        11 => {
            let mut arr = Vec::with_capacity(size as usize);
            for _ in 0..size {
                arr.push(decode_val(data, pos, data_base)?);
            }
            Ok(Value::Array(arr))
        }
        14 => Ok(Value::Bool(size != 0)),
        15 => {
            let b = read_slice(data, pos, 4)?;
            Ok(Value::F64(f32::from_be_bytes(b.try_into().unwrap()) as f64))
        }
        _ => {
            let _ = read_slice(data, pos, size as usize)?;
            Ok(Value::Null)
        }
    }
}

fn int_be(b: &[u8]) -> u64 {
    let mut n = 0u64;
    for &x in b {
        n = (n << 8) | u64::from(x);
    }
    n
}

fn read_u8(data: &[u8], pos: &mut usize) -> io::Result<u8> {
    if *pos >= data.len() {
        return Err(eof());
    }
    let v = data[*pos];
    *pos += 1;
    Ok(v)
}

fn read_u16_be(data: &[u8], pos: &mut usize) -> io::Result<u16> {
    let b = read_slice(data, pos, 2)?;
    Ok(u16::from_be_bytes([b[0], b[1]]))
}

fn read_u24_be(data: &[u8], pos: &mut usize) -> io::Result<u32> {
    let b = read_slice(data, pos, 3)?;
    Ok((u32::from(b[0]) << 16) | (u32::from(b[1]) << 8) | u32::from(b[2]))
}

fn read_u32_be(data: &[u8], pos: &mut usize) -> io::Result<u32> {
    let b = read_slice(data, pos, 4)?;
    Ok(u32::from_be_bytes([b[0], b[1], b[2], b[3]]))
}

fn read_slice<'a>(data: &'a [u8], pos: &mut usize, n: usize) -> io::Result<&'a [u8]> {
    if *pos + n > data.len() {
        return Err(eof());
    }
    let s = &data[*pos..*pos + n];
    *pos += n;
    Ok(s)
}

pub fn extract_geoip_db(data: &[u8], category: &str) -> io::Result<Vec<String>> {
    if category.is_empty() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "geoip-db requires category (e.g. cn)",
        ));
    }
    let mmdb = Mmdb::open(data)?;
    let nets = mmdb.walk_code(category)?;
    if nets.is_empty() {
        return Err(io::Error::new(
            io::ErrorKind::NotFound,
            format!("category {category:?} not found or empty in geoip.db"),
        ));
    }
    Ok(nets)
}

pub fn list_languages(data: &[u8]) -> io::Result<Vec<String>> {
    Ok(Mmdb::open(data)?.languages().to_vec())
}
