pub const HELP: &str = "fb: Facebook + Messenger CLI for LLMs. Drives its own headless Chrome; run `fb login` once.
Output: TSV, one record per line. Short refs (p3k9a post, c8x2f chat, u1abc profile) are accepted wherever that thing is expected.
<who>: me | name | @vanity | id | url | ref    <chat>: name | ref | id | @person    <post>: ref | /path | url

READ
  resolve <ref>                     original URL, path or thread id for a saved ref; no navigation
  feed/posts --reaction-state prepends ru<TAB>label<TAB>aria-pressed metadata to each post.
  feed [-n 10] [--refresh] [--full] [--urls]   next posts (scrolls on): ref, author, time, react/comment/share, text
  posts [who] [-n 10]                same, for a profile / page / group (/groups/ID)
  post-menu <post> [--press <label>]...   a post's actions menu, pressing each label in turn (submenus, dialogs such as Report): from, title, text, option<TAB>label<TAB>detail<TAB>on, done, note lines
  saved [-n 10] [--full] [--urls]     your saved posts, same rows as feed
  view <post> [-n 10]                by, stats, text, then c<TAB>author<TAB>time<TAB>text per comment
  profile [who]                      key<TAB>value lines
  friends [who] [-n 30]              name, ref, mutual friends
  groups [-n 100] [--urls]           groups you have joined: name, ref, privacy and size
  events [-n 50] [--urls]            events from your events page: name, ref, date and place info
  pages [-n 100] [--urls]            pages from your pages page: name, ref, category and follower info
  places [-n 50] [--urls]            places from the places page: name, ref, category and location info
  members <group> [-n 200] [--urls]  people in a group: name, ref, role or join info
  search <q> [--type top|posts|people|friends|photos|videos|pages|places|groups|events|marketplace] [-n 10]   top = All (default); friends = people narrowed by the Friends chip; marketplace rows are title, ref, price and place
  marketplace [query] [-n 20]        browse Marketplace listings (the recommended feed, or search with a query): title, ref, price and place
  notifs [-n 15]                     time, !=unread, text, ref
MESSENGER
  chats [-n 20] [--unread] [name]    ref, flags(! unread, g group, e e2ee), time, name, preview
  read <chat> [-n 20]                `# date` lines, then `HH:MM sender: text` ([img] [file], {emoji} reactions)
  send <chat> <text> [--file path]... [--dry]   file or image, 25MB max each, one message per file then the text. Options BEFORE `--`; after `--` is text. Name must match exactly (or use ref / --fuzzy)
  unsend <chat> [--match text] [--dry]   remove your newest loaded message (containing text) for everyone
  msgreact <chat> <like|love|care|haha|wow|sad|angry> [--match text] [--nth n]   react to the newest message (or the nth newest containing text)
  reply <chat> <text> --match text [--nth n] [--file path]...   reply to the (nth newest) message containing text (quotes it), then send like `send`
  unlock [-]                         once: restore end-to-end encrypted chats; PIN read from $FB_PIN or stdin
ACT
  post <text> [--img file]... [--video file]... [--to public|friends|me]   confirmed: posted<TAB>ref<TAB>path (pending<TAB>ref<TAB>path or pending: accepted, still publishing; do not retry)
  comment <post> <text>
  react <post> [like|love|care|haha|wow|sad|angry|none]
  delete <post>                      your own posts only
  friend-add <who>                   send a friend request (reports existing friends / pending requests)
  group-join <group>                 join a group (reports joined / requested; membership questions come back as questions<TAB>n then q<TAB>text lines)
  group-apply <group> <answer>...    join a group by answering its membership questions in order (a choice question takes the option text)
  group-leave <group>                leave a group (reports not-a-member; a pending request is left alone)
  sell <title> --price N [--condition new|like-new|good|fair] [--category name] [--desc text] [--img file]... [--video file]   create a Marketplace listing; price 0 = free; at least one photo or video, 10 max
  listing-message <listing> <text>   message a Marketplace seller from the listing page
  follow <ref|url|@handle|id>        follow their public posts without a friend request; --undo unfollows, --dry only reports
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
