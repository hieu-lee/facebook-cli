//! List a group's photos from its Media tab. Rows are the photo permalinks
//! (`/photo/?fbid=…`), so the app can open them with its normal reader.
use crate::browser::Browser;
use crate::cdp::Res;
use crate::daemon::{Daemon, Out};
use crate::ops::parse;
use serde_json::Value;
use std::sync::Arc;

pub async fn group_photos(d: &Daemon, args: &[String], out: &Out) -> Res<()> {
    let a = parse(args, &[], &[])?;
    let spec = a.pos.first().ok_or("usage: group-photos <group> [-n N]")?;
    let b: Arc<Browser> = d.browser(out).await?;
    let group = crate::ops::group_path(d, spec)?;
    let t = b.acquire().await?;
    let r = async {
        b.goto(
            &t,
            &format!("https://www.facebook.com{group}/media/photos/"),
        )
        .await?;
        let v = b
            .eval(
                &t,
                &format!(
                    "window.__fb.groupPhotos({}).then(JSON.stringify)",
                    a.n.unwrap_or(50)
                ),
            )
            .await?;
        let v: Value =
            serde_json::from_str(v.as_str().unwrap_or("{}")).map_err(|e| e.to_string())?;
        if let Some(e) = v["err"].as_str() {
            return Err(e.to_string());
        }
        let rows = v["rows"].as_array().cloned().unwrap_or_default();
        if rows.is_empty() {
            if let Some(note) = v["note"].as_str() {
                out.err(format!("{note}\n"));
            }
            return Ok(());
        }
        for row in rows {
            let cells: Vec<Value> = row.as_array().cloned().unwrap_or_default();
            let get = |i: usize| cells.get(i).and_then(Value::as_str).unwrap_or("");
            out.line(format!(
                "{}\t{}\t{}",
                get(0).replace(['\t', '\n'], " "),
                get(1),
                get(2).replace(['\t', '\n'], " ")
            ));
        }
        Ok(())
    }
    .await;
    b.release(t).await;
    r
}
