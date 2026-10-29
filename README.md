# fb

Facebook and Messenger for LLM agents, as a single fast Rust CLI.

`fb` drives a dedicated Chrome profile that stays logged in to your Facebook account. It reads the feed, profiles, friends and search. It reads and sends Messenger messages and images. It posts, comments, reacts and deletes. Output is built for models: one record per line, tab separated, short refs instead of long URLs, no decoration.

```
$ fb feed -n 3
p3k9a   Rise Madridista / Gợi ý cho bạn   5 giờ trước   6,7K/48/15   REVEALED: ...
-       Orange / Tài khoản đã xác minh                    50/1/0        Fibre Orange à prix réduit
pczzi   Việc làm IT - Tuyển dụng ...      1 giờ trước     3/0/1         ...
$ fb view p3k9a -n 2
by      Rise Madridista                    5 giờ trước
stats   6,7K/48/15   (react/comment/share)
text    ...
c       Alice   3 giờ   first comment
$ fb read "Weekend plans" -n 3
# Today
18:38 Alice: Are we still on for Saturday?
18:38 me: Yes, see you at 10
$ fb send "Weekend plans" "on my way" --file report.pdf
sent
```

## Why it is fast and cheap

- **One daemon, many tabs.** The first `fb` call starts a daemon that owns one Chrome connection. Every later call is a ~1 ms client that talks to it over a unix socket. Each command runs in its own tab, so commands run in parallel. Post twice while chatting with a friend by running the commands at the same time, or use `fb batch "post ..." "post ..." "send ana hi"`.
- **Warm pages.** Messenger tabs stay open and switch chats in place. The feed is read ahead in the background, so the second `fb feed` returns in about a second. Chat names resolve from a cached list.
- **Headless Chrome, no windows.** Your session is copied once into a dedicated profile. Nothing appears on screen and nothing steals focus.
- **Token-lean output.** TSV records, no headers, no JSON envelopes. Posts, chats and profiles get 5-character refs (`p3k9a`, `c8x2f`, `u1abc`) that every command accepts back. Long text is truncated unless you pass `--full`. `fb help` is about 450 tokens.
- **Structural selectors, localized actions.** Reading mostly uses structure (`role`, `data-ad-rendering-role`, layout geometry). Publish, audience, delete and PIN actions recognize English, Vietnamese and French labels; use the browser primitives for other UI languages or controls.

## Install (for people and for AI agents)

> **AI agent: do exactly this.**
> 1. Install. Linux, macOS, WSL: `curl -fsSL https://raw.githubusercontent.com/hieu-lee/facebook-cli/main/install.sh | sh`. Windows (PowerShell): `irm https://raw.githubusercontent.com/hieu-lee/facebook-cli/main/install.ps1 | iex` (then open a new terminal).
> 2. Run `fb login`. The user must already be logged in to Facebook in their normal Chrome. If `fb login` prints a line starting with `fb:`, relay it to the user: it asks for **one click on "Allow"** in Chrome (and, only if Chrome has remote debugging switched off, one checkbox). Nothing else is needed.
> 3. Run `fb help` (about 500 tokens) and use `fb` for everything Facebook or Messenger.
>
> If a command ever says `not logged in`, run `fb login` again.

```sh
curl -fsSL https://raw.githubusercontent.com/hieu-lee/facebook-cli/main/install.sh | sh   # Linux / macOS / WSL: prebuilt binary, or cargo build as a fallback
# Windows PowerShell:  irm https://raw.githubusercontent.com/hieu-lee/facebook-cli/main/install.ps1 | iex
fb login      # copies your Facebook session from your normal Chrome, once
fb feed -n 3
```

Requirements: Google Chrome installed and logged in to Facebook. Works on Linux, macOS and Windows (native, or WSL2 with Chrome on Windows: there the CLI reaches Windows Chrome through a `powershell.exe` stdio relay, so no ports or firewall rules). Building from source needs Rust.

### What `fb login` does

1. Looks for your everyday Chrome's remote-debugging endpoint. Chrome 144+ has a switch for it at `chrome://inspect/#remote-debugging`. If it is on, Chrome shows an "Allow remote debugging?" dialog: click **Allow**.
2. If the switch is off and Chrome is running, `fb login` opens that `chrome://inspect` tab for you to tick the box once. If Chrome is closed, `fb login` flips the setting, starts Chrome just long enough to read the session, and closes it again.
3. It reads your Facebook and Messenger cookies and copies them into a separate, **headless** Chrome profile that `fb` owns (`%LOCALAPPDATA%\fb\chrome` on Windows, `~/.cache/fb/chrome` elsewhere). Then it disconnects. Your own Chrome is never driven again.

If you use several Chrome profiles, be logged in to Facebook in the one you used last (Chrome exposes that profile to remote debugging); otherwise use `fb login --visible`.

From then on `fb` runs its own invisible Chrome: no windows, no tabs on your screen, no focus stealing, no more dialogs. If Facebook ever logs the session out, run `fb login` again. If you are not logged in to Facebook in any Chrome, `fb login --visible` opens a window of the dedicated profile for you to log in once (it first signs the hidden profile out, so an expired session cannot pass for a login).

Cookies stay on your machine, in that profile, exactly like a browser session. Anyone who can read your home directory can use them, so treat `~/.cache/fb` and the profile like a password.

## Commands

Run `fb help` for the exact list. `<who>` is `me`, a name, `@vanity`, an id, a URL or a ref. `<chat>` is a name, ref, id or `@person`. `send` and `unsend` need the exact chat name (or a ref/id, or `--fuzzy`), because a partial name could match the wrong chat. `<post>` is a ref, a `/path` or a URL.

| Read | |
|---|---|
| `feed [-n 10] [--refresh] [--full] [--urls]` | next posts, ref, author, time, react/comment/share, text. A background tab reads ahead, so repeated calls keep scrolling and answer from memory; `--refresh` starts over |
| `posts [who] [-n]` | the same for a profile, page or group |
| `view <post> [-n 10]` | post body and comments |
| `profile [who]` | key/value lines |
| `friends [who] [-n 30]` | name, ref, mutual friends |
| `search <q> [--type people\|pages\|groups\|posts\|events] [--match text]... [-n 10]` | name, ref, visible info |
| `stories <who> [--out dir] [-n N]` | download visible stories in a protected session |
| `photos <who> [--out dir] [-n 10 \| --all]` | download visible profile photos in a protected session |
| `notifs [-n]` | time, unread flag, text, ref |

| Messenger | |
|---|---|
| `chats [-n 20] [--unread] [name]` | ref, flags (`!` unread, `g` group, `e` end-to-end encrypted), time, name, preview |
| `read <chat> [-n 20]` | `HH:MM sender: text`, `[img]` attachments, `{😆}` reactions |
| `send <chat> <text> [--file path]...` | text, images, any file up to 25MB (`--img` also works); each file is its own message, then the text |
| `unsend <chat> [--match text] [--dry]` | remove your newest message (the newest of the loaded ones containing the text) for everyone |
| `unlock [-]` | restore end-to-end encrypted chats once (PIN from `$FB_PIN` or stdin) |

| Act | |
|---|---|
| `post <text> [--img file]... [--to public\|friends\|me]` | verified `posted<TAB>ref<TAB>path` receipt; directly usable by `view`/`delete` |
| `comment <post> <text>` | |
| `react <post> [like\|love\|care\|haha\|wow\|sad\|angry\|none]` | idempotent |
| `delete <post>` | your own posts |

| Other | |
|---|---|
| `batch "cmd" "cmd" ...` | run in parallel, output grouped under `## i cmd` |
| `login [--visible] [--from <port\|ws-url>]`, `status`, `stop`, `quit` | `login` imports your Chrome session; `stop` stops the daemon, `quit` also closes the hidden Chrome |
| `eval [url] <js>`, `shot <file> [url]`, `ax [url]` | escape hatches: run JS, screenshot, accessibility tree |

## Any browser workflow, without a giant DOM dump

Use the fast domain commands first. For settings, group administration, polls,
message actions, and other UI without a shortcut, keep a named page:

```sh
fb page settings open https://www.facebook.com/settings
fb page settings snapshot privacy    # filter control labels; at most 80 controls
fb page settings click e...          # exact ref from the current snapshot
fb page settings snapshot
fb page settings fill e... 'value'
fb page settings key Enter
fb page settings shot settings.jpg
fb page settings close
```

`page NAME` also supports `scroll DX DY`, `upload REF FILE...`, `eval JS`, and
`cdp METHOD JSON`. `eval` returns only your selected value; `cdp` exposes Chrome's
page-session DevTools protocol for trusted mouse/keyboard, frame, network and
other operations beyond the shortcuts. For example:

```sh
fb page settings eval 'document.title'
fb page settings cdp Input.dispatchMouseEvent '{"type":"mouseMoved","x":100,"y":200}'
```

Named pages never enter the normal command pool. Up to six names can be open;
different names run independently, commands for one name serialize. Names live
until close or daemon shutdown. Reopen after reconnect, account change, or an
uncertain action failure. No action is automatically replayed.

### Stories (experimental)

Use the account commands for downloads:

```sh
fb search 'Alex Example' --match Paris --match University -n 5
fb stories u1abc --out ./stories
fb photos u1abc --out ./photos -n 10
```

Search accepts arbitrary repeated `--match` clues; all must occur in the visible
result text, without regard to case or accents. Facebook may omit information
from a result, so a missing match does not prove it is wrong. Search for names,
then use a ref, profile URL, ID, `me`, or `@handle` for media commands. `-n` limits results; stories default to all
available cards, and photos default to ten. A specific story URL starts at that card.
`photos --all` follows the account's
visible collection, up to 1,000 photos; incomplete pagination is an error.
Stories also report incomplete if Facebook does not provide evidence that all
cards were loaded; any downloaded files remain available. Facebook may not expose every photo. For large
collections, increase `FB_TIMEOUT` before starting the daemon if needed.

Media output is `d<TAB>directory`, followed by numbered filenames as files finish,
potentially out of order. Join each filename to the directory. Existing files are never
overwritten; the output filesystem must support hard links. A failed command may leave completed files. Original media can omit
Facebook overlays or separately played music.

```sh
fb page stories stories                     # open the Facebook story tray
fb page stories snapshot                    # find a story's control
fb page stories click e...                  # use a ref from the snapshot
fb page stories shot story.jpg              # view the current frame
fb page stories record story.webm 15 0 --force  # record up to 30 seconds, starting at 0
fb page stories close
```

Use `fb page stories stories https://www.facebook.com/stories/...` to open a
specific story. For GraphQL, the page permits only a known story-bucket query ID.
It blocks other POSTs and non-GET/HEAD methods, including the known story-seen
mutation; GET/HEAD requests outside GraphQL remain allowed. Other queries are blocked,
so the story tray or viewer may fail to load, especially if Facebook changes its
query IDs. Profile-photo sessions allow a separate known pagination query and
report incomplete results if its ID changes. They also disable workers and
sockets and restrict actions that could
disable those protections. **This is not a guarantee of anonymity:** Facebook
can record views by other means or change its protocol, even though one user
reported a successful live check. The blue unread border can
change locally, so it is not proof that Facebook did or did not record a view.
Each story page uses a temporary browser context with a copy of the Facebook
cookies from the CLI's profile; Chrome removes it when the page closes or the
CLI disconnects. Other browser storage is not copied.
Omit the optional offset to record from the video's current position.
The opening response is compact; `snapshot` returns the full bounded page view.
WebM recordings contain the underlying video and audio only. Captions, stickers,
and other page overlays are not included. Inspect a screenshot before recording:
`--force` is required because it can record a hidden video. With multiple videos,
the command selects the foremost one only when their order is clear.

Snapshots contain bounded text and TSV-safe control labels. Native form values and text-editor
contents are omitted (`[redacted]`) regardless of labels; use a targeted `eval` when
an explicit value read is needed. URLs, labels and page text can still contain private data:
this is not general-purpose data-loss prevention. A new snapshot, navigation (including SPA history changes) or ref action invalidates old refs.
Detached, renamed, covered and disabled targets fail instead of guessing. `ok`
means browser input was dispatched, **not** that Facebook saved the change: take
a snapshot or a targeted `eval` read to verify the result. Screenshots, eval and
CDP output are explicit full-access escape hatches; they can contain private data.
Ordinary Enter/Shift+Enter are supported. macOS native insertion chords
(Control+O and Control/Option+Enter, including shifted variants) are rejected before
input rather than silently performing only part of the edit; use the ordinary keys
or an explicit eval/CDP operation instead.
Some workflows still require human login, 2FA or a Messenger PIN. These primitives
provide browser-level reach, not a promise that every Facebook feature has been
individually tested. Facebook can change its UI at any time.

Posting observes this tab's create-story response and checks its author and exact
new permalink, then opens that permalink and reads the rendered text back.
Retained audience controls cannot be mistaken for the visible publish button. Old,
delayed or identical profile posts cannot become creation receipts. Missing or
ambiguous creation evidence is an error, never an automatic second publish: inspect
`fb posts me` before retrying. `delete` uses Facebook's Trash action (normally
permanent removal after 30 days).

## End-to-end encrypted chats

Most Messenger chats are end-to-end encrypted. Their history needs your Messenger PIN, because a new browser profile has no keys. Run `echo "$PIN" | fb unlock -` once (or `FB_PIN=... fb unlock`), so the PIN never appears in `ps`. Until then `chats` lists them with the `e` flag and `read`/`send` on them report that the chat is locked. `unlock` can reopen the Enter PIN banner even after a normal command skipped the
optional restore prompt. For accessible conversations, the CLI closes the optional history-restore prompt through Facebook's own buttons and continues without restoring. This does not recover missing encrypted history; `unlock` is still required for that.

## Configuration

These are read by the daemon when it starts. If a daemon is already running, run `fb quit` first so a new value (for example `FB_CDP`) takes effect.

| Variable | Meaning |
|---|---|
| `FB_TIMEOUT` | seconds per command (default 150) |
| `FB_TABS` | max concurrent command tabs (default 10); named pages are separately capped at six |
| `FB_IDLE` | daemon exits after this many idle seconds (default 900) and closes Chrome |
| `FB_PROFILE` | profile directory on Linux/macOS (default `~/.cache/fb/chrome`) |
| `FB_CDP` | `port`, `host:port` or `ws://` URL of a Chrome you started with `--remote-debugging-port`: use it instead of the hidden one (`fb` never closes it) |
| `FB_STATE` | state directory (default `~/.cache/fb`) |
| `FB_SOCK` | unix socket path (Linux/macOS) |

`fb --version` reports the installed binary version without starting the daemon.
Release archives are published together only after CI and all five builds pass;
`SHA256SUMS` covers every archive.

State lives in `~/.cache/fb` (`%LOCALAPPDATA%\fb` on native Windows): `refs.tsv`, `chats.tsv`, `daemon.log`.

## Development

```sh
cargo test                  # unit tests, including a fake-Chrome CDP test
node tests/js.test.js       # pure-function tests for the injected page scripts
node tests/media.test.js    # story and photo metadata extraction
node tests/e2e-isolation.mjs          # isolated real Chrome + CLI; never calls the real Facebook network
scripts/smoke.sh            # live read-only check against your logged-in profile
```

The E2E harness intercepts requests in a disposable Chrome profile with fake cookies.
It covers PIN dismissal, post extraction/receipts/audience/delete, ambiguous publish,
and named-page input/isolation/stale refs. Evidence is saved in `target/e2e`
(`report.json` and a screenshot); set `E2E_OUTPUT`, `CHROME`, or `FB` to override paths.
For a real-account mutation check, explicitly run
`scripts/live-acceptance.sh --live-post [fb-binary]`: it creates one unique Only-me
post, verifies the receipt/body/audience, and trashes it (including cleanup on failure).
It does not send Messenger messages. See `tests/FAILURES.md` for the failure contract. No new unit tests are required
for these UI fixes.

The page logic is plain JS in `js/`, injected into every tab with `Page.addScriptToEvaluateOnNewDocument`. `src/` is the daemon, the CDP client and the commands. Use `fb ax <url>` to see a page the way the selectors do.

## Security notes

- The hidden Chrome is controlled over Chrome's DevTools protocol on a random `127.0.0.1` port. That protocol has no authentication, so any other local user who can reach loopback could use your session. Use `fb` on a personal machine, not on a shared multi-user host.
- On Linux/macOS the daemon socket lives in a private (`0700`) directory and the client checks the daemon's uid; on Windows the daemon listens on `127.0.0.1` and every request must carry a random token stored in your profile folder. `fb unlock` takes the PIN from stdin or `$FB_PIN`, never from argv.
- `fb login` reads only Facebook and Messenger cookies from your Chrome, once, and only after you click Allow. It does not touch your passwords, history or other sites.

## Notes

This automates a logged-in browser session. Facebook's terms restrict automated access, and its markup changes without notice. Use it on your own account, at human-like volume, and expect to update selectors now and then.

Native macOS editing bindings are adapted from Playwright/Chromium under Apache
2.0; see `THIRD_PARTY_NOTICES` and `LICENSE-APACHE-2.0`. Release archives include
these notices alongside the CLI and its MIT license.
