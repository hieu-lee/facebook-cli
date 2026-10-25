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
- **Locale independent.** Selectors use structure (`role`, `data-ad-rendering-role`, layout geometry), not button labels, so it works with any Facebook UI language. A few menu actions (delete, audience) also match English, Vietnamese and French labels.

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
| `search <q> [--type people\|pages\|groups\|posts\|events]` | name, ref, info |
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
| `post <text> [--img file]... [--to public\|friends\|me]` | create a post |
| `comment <post> <text>` | |
| `react <post> [like\|love\|care\|haha\|wow\|sad\|angry\|none]` | idempotent |
| `delete <post>` | your own posts |

| Other | |
|---|---|
| `batch "cmd" "cmd" ...` | run in parallel, output grouped under `## i cmd` |
| `login [--visible] [--from <port\|ws-url>]`, `status`, `stop`, `quit` | `login` imports your Chrome session; `stop` stops the daemon, `quit` also closes the hidden Chrome |
| `eval [url] <js>`, `shot <file> [url]`, `ax [url]` | escape hatches: run JS, screenshot, accessibility tree |

## End-to-end encrypted chats

Most Messenger chats are end-to-end encrypted. Their history needs your Messenger PIN, because a new browser profile has no keys. Run `echo "$PIN" | fb unlock -` once (or `FB_PIN=... fb unlock`), so the PIN never appears in `ps`. Until then `chats` lists them with the `e` flag and `read`/`send` on them report that the chat is locked. Unencrypted chats and groups work immediately.

## Configuration

These are read by the daemon when it starts. If a daemon is already running, run `fb quit` first so a new value (for example `FB_CDP`) takes effect.

| Variable | Meaning |
|---|---|
| `FB_TIMEOUT` | seconds per command (default 150) |
| `FB_TABS` | max concurrent tabs (default 10) |
| `FB_IDLE` | daemon exits after this many idle seconds (default 900) and closes Chrome |
| `FB_PROFILE` | profile directory on Linux/macOS (default `~/.cache/fb/chrome`) |
| `FB_CDP` | `port`, `host:port` or `ws://` URL of a Chrome you started with `--remote-debugging-port`: use it instead of the hidden one (`fb` never closes it) |
| `FB_STATE` | state directory (default `~/.cache/fb`) |
| `FB_SOCK` | unix socket path (Linux/macOS) |

State lives in `~/.cache/fb` (`%LOCALAPPDATA%\fb` on native Windows): `refs.tsv`, `chats.tsv`, `daemon.log`.

## Development

```sh
cargo test                  # unit tests, including a fake-Chrome CDP test
node tests/js.test.js       # pure-function tests for the injected page scripts
scripts/smoke.sh            # live read-only check against your logged-in profile
```

The page logic is plain JS in `js/`, injected into every tab with `Page.addScriptToEvaluateOnNewDocument`. `src/` is the daemon, the CDP client and the commands. Use `fb ax <url>` to see a page the way the selectors do.

## Security notes

- The hidden Chrome is controlled over Chrome's DevTools protocol on a random `127.0.0.1` port. That protocol has no authentication, so any other local user who can reach loopback could use your session. Use `fb` on a personal machine, not on a shared multi-user host.
- On Linux/macOS the daemon socket lives in a private (`0700`) directory and the client checks the daemon's uid; on Windows the daemon listens on `127.0.0.1` and every request must carry a random token stored in your profile folder. `fb unlock` takes the PIN from stdin or `$FB_PIN`, never from argv.
- `fb login` reads only Facebook and Messenger cookies from your Chrome, once, and only after you click Allow. It does not touch your passwords, history or other sites.

## Notes

This automates a logged-in browser session. Facebook's terms restrict automated access, and its markup changes without notice. Use it on your own account, at human-like volume, and expect to update selectors now and then.
