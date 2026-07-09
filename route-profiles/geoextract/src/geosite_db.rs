//! sing-box geosite.db

use std::collections::HashMap;
use std::io;

use crate::bin_reader::{norm_domain, BinReader};

pub fn list_codes(data: &[u8]) -> io::Result<Vec<String>> {
    let mut r = BinReader::new(data);
    if r.read_u8()? != 0 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "unsupported geosite.db version",
        ));
    }
    let n = r.read_uvarint()? as usize;
    let mut codes = Vec::with_capacity(n);
    for _ in 0..n {
        codes.push(r.read_string()?);
        let _ = r.read_uvarint()?;
        let _ = r.read_uvarint()?;
    }
    Ok(codes)
}

pub fn extract_geosite_db(data: &[u8], category: &str) -> io::Result<Vec<String>> {
    if category.is_empty() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "geosite-db requires category",
        ));
    }
    let mut r = BinReader::new(data);
    let version = r.read_u8()?;
    if version != 0 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("unsupported geosite.db version {version}"),
        ));
    }
    let entry_len = r.read_uvarint()? as usize;
    let mut index: HashMap<String, (usize, usize)> = HashMap::with_capacity(entry_len);
    let mut order = Vec::with_capacity(entry_len);
    for _ in 0..entry_len {
        let code = r.read_string()?;
        let code_index = r.read_uvarint()? as usize;
        let code_length = r.read_uvarint()? as usize;
        index.insert(code.to_ascii_lowercase(), (code_index, code_length));
        order.push(code);
    }
    let metadata_end = r.pos();
    let want = category.to_ascii_lowercase();
    let Some(&(off, length)) = index.get(&want) else {
        let sample: Vec<_> = order.into_iter().take(12).collect();
        return Err(io::Error::new(
            io::ErrorKind::NotFound,
            format!(
                "category {category:?} not in geosite.db (sample: {})",
                sample.join(", ")
            ),
        ));
    };
    r.seek(metadata_end + off)?;
    let mut out = Vec::with_capacity(length);
    for _ in 0..length {
        let itype = r.read_u8()?;
        let value = r.read_string()?;
        // 0=Domain 1=DomainSuffix 2=Keyword 3=Regex
        if (itype == 0 || itype == 1) && !value.is_empty() {
            let d = norm_domain(&value);
            if !d.is_empty() {
                out.push(d);
            }
        }
    }
    Ok(out)
}
