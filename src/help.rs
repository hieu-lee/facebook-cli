pub const HELP: &str = "fb: Facebook + Messenger CLI for LLMs. Drives its own headless Chrome; run `fb login` once.
Output: TSV, one record per line. Short refs (p3k9a post, c8x2f chat, u1abc profile) are accepted wherever that thing is expected.
<who>: me | name | @vanity | id | url | ref    <chat>: name | ref | id | @person    <post>: ref | /path | url

READ
  feed [-n 10] [--refresh] [--full] [--urls]   next posts (scrolls on): ref, author, time, react/comment/share, text
  posts [who] [-n 10]                same, for a profile / page / group (/groups/ID)
  view <post> [-n 10]                by, stats, text, then c<TAB>author<TAB>time<TAB>text per comment
  profile [who]                      key<TAB>value lines
  friends [who] [-n 30]              name, ref, mutual friends
  search <q> [--type people|pages|groups|posts|events] [-n 10]
  notifs [-n 15]                     time, !=unread, text, ref
MESSENGER
  chats [-n 20] [--unread] [name]    ref, flags(! unread, g group, e e2ee), time, name, preview
  read <chat> [-n 20]                `# date` lines, then `HH:MM sender: text` ([img] [file], {emoji} reactions)
  send <chat> <text> [--file path]... [--dry]   file or image, 25MB max each, one message per file then the text. Options BEFORE `--`; after `--` is text. Name must match exactly (or use ref / --fuzzy)
  unsend <chat> [--match text] [--dry]   remove your newest loaded message (containing text) for everyone
  unlock [-]                         once: restore end-to-end encrypted chats; PIN read from $FB_PIN or stdin
ACT
  post <text> [--img file]... [--to public|friends|me]   confirmed: posted<TAB>ref<TAB>path
  comment <post> <text>
  react <post> [like|love|care|haha|wow|sad|angry|none]
  delete <post>                      your own posts only
BROWSER (fallback; named tabs are separate from normal commands)
  page <name> open <url> | snapshot [filter]   bounded text + refs; max 6 pages
  page <name> click <ref> | fill <ref> <text> | key <Ctrl+a|Enter|...> | scroll <dx> <dy>
  page <name> upload <ref> <files>... | eval <js> | cdp <method> <json> | shot <file> | close
  Form/editor values are omitted; use eval for explicit value reads.
  Refs expire on snapshot/navigation/action. ok means input dispatched, not saved; read back to confirm.
OTHER
  batch \"cmd\" \"cmd\" ...             run commands in parallel (or one per stdin line); output grouped under `## i cmd`
  login [--visible] [--from port|ws-url]   first run: copies your Chrome's Facebook session (one Allow click)
  --version | status | stop (daemon; hidden browser keeps running) | quit (daemon + hidden browser) | eval [url] <js> | shot <file> [url] | ax [url]
Env (read by the daemon when it starts: `fb quit` to apply a change): FB_TIMEOUT=sec per command (150), FB_PROFILE=dir (non-WSL), FB_CDP=port|ws-url (use your own Chrome).
Each command runs in its own tab: invoke several at once (shell & or batch) for concurrency.";
