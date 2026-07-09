//! Minimal binary cursor for varints / big-endian reads.

use std::io;

pub struct BinReader<'a> {
    data: &'a [u8],
    pos: usize,
}

impl<'a> BinReader<'a> {
    pub fn new(data: &'a [u8]) -> Self {
        Self { data, pos: 0 }
    }

    pub fn pos(&self) -> usize {
        self.pos
    }

    pub fn remaining(&self) -> usize {
        self.data.len().saturating_sub(self.pos)
    }

    pub fn seek(&mut self, pos: usize) -> io::Result<()> {
        if pos > self.data.len() {
            return Err(io::Error::new(io::ErrorKind::UnexpectedEof, "seek OOB"));
        }
        self.pos = pos;
        Ok(())
    }

    pub fn read_exact(&mut self, n: usize) -> io::Result<&'a [u8]> {
        if self.pos + n > self.data.len() {
            return Err(io::Error::new(io::ErrorKind::UnexpectedEof, "EOF"));
        }
        let s = &self.data[self.pos..self.pos + n];
        self.pos += n;
        Ok(s)
    }

    pub fn read_u8(&mut self) -> io::Result<u8> {
        Ok(self.read_exact(1)?[0])
    }

    pub fn read_u64_be(&mut self) -> io::Result<u64> {
        let b = self.read_exact(8)?;
        Ok(u64::from_be_bytes([
            b[0], b[1], b[2], b[3], b[4], b[5], b[6], b[7],
        ]))
    }

    pub fn read_uvarint(&mut self) -> io::Result<u64> {
        let mut result: u64 = 0;
        let mut shift = 0;
        loop {
            if shift >= 64 {
                return Err(io::Error::new(io::ErrorKind::InvalidData, "uvarint too long"));
            }
            let b = self.read_u8()?;
            result |= u64::from(b & 0x7f) << shift;
            if b & 0x80 == 0 {
                return Ok(result);
            }
            shift += 7;
        }
    }

    pub fn read_string(&mut self) -> io::Result<String> {
        let n = self.read_uvarint()? as usize;
        if n == 0 {
            return Ok(String::new());
        }
        let b = self.read_exact(n)?;
        Ok(String::from_utf8_lossy(b).into_owned())
    }

    pub fn read_bytes_lp(&mut self) -> io::Result<&'a [u8]> {
        let n = self.read_uvarint()? as usize;
        if n == 0 {
            return Ok(&[]);
        }
        self.read_exact(n)
    }
}

pub fn norm_domain(s: &str) -> String {
    let s = s.trim().trim_start_matches('.').to_ascii_lowercase();
    s
}
