use std::collections::HashMap;
use std::io::Write;
use std::path::PathBuf;
use std::sync::Mutex;

/// Short, stable handles (e.g. `c4k2z`) for long ids/urls so LLM output stays small.
pub struct Refs {
    map: Mutex<HashMap<String, String>>,
    file: PathBuf,
}

fn fnv(s: &str) -> u64 {
    let mut h: u64 = 0xcbf29ce484222325;
    for b in s.bytes() {
        h ^= b as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    h
}

fn b36(mut n: u64, len: usize) -> String {
    const D: &[u8] = b"0123456789abcdefghijklmnopqrstuvwxyz";
    let mut v = Vec::new();
    for _ in 0..len {
        v.push(D[(n % 36) as usize]);
        n /= 36;
    }
    String::from_utf8(v).unwrap()
}

impl Refs {
    pub fn load(file: PathBuf) -> Refs {
        let mut map = HashMap::new();
        if let Ok(s) = std::fs::read_to_string(&file) {
            for l in s.lines() {
                if let Some((k, v)) = l.split_once('\t') {
                    map.insert(k.to_string(), v.to_string());
                }
            }
        }
        Refs {
            map: Mutex::new(map),
            file,
        }
    }

    pub fn put(&self, kind: char, full: &str) -> String {
        let h = fnv(full);
        let mut m = self.map.lock().unwrap();
        for len in 4..=12 {
            let s = format!("{kind}{}", b36(h, len));
            match m.get(&s) {
                Some(v) if v == full => return s,
                Some(_) => continue,
                None => {
                    m.insert(s.clone(), full.to_string());
                    if let Ok(mut f) = std::fs::OpenOptions::new()
                        .create(true)
                        .append(true)
                        .open(&self.file)
                    {
                        let _ = writeln!(f, "{s}\t{full}");
                    }
                    return s;
                }
            }
        }
        full.to_string()
    }

    pub fn get(&self, token: &str) -> Option<String> {
        self.map.lock().unwrap().get(token).cloned()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> PathBuf {
        let p = std::env::temp_dir().join(format!("fb-refs-{name}-{}", std::process::id()));
        let _ = std::fs::remove_file(&p);
        p
    }

    #[test]
    fn refs_are_stable_short_and_persisted() {
        let f = tmp("a");
        let r = Refs::load(f.clone());
        let a = r.put('p', "/page/posts/pfbid0abc");
        assert_eq!(a, r.put('p', "/page/posts/pfbid0abc"));
        assert!(a.starts_with('p') && a.len() == 5, "{a}");
        assert_eq!(r.get(&a).as_deref(), Some("/page/posts/pfbid0abc"));
        let again = Refs::load(f.clone());
        assert_eq!(again.get(&a).as_deref(), Some("/page/posts/pfbid0abc"));
        assert_eq!(again.get("pzzzzz"), None);
        let _ = std::fs::remove_file(f);
    }

    #[test]
    fn kinds_do_not_collide() {
        let r = Refs::load(tmp("b"));
        assert_ne!(r.put('p', "/x"), r.put('c', "/x"));
    }
}
