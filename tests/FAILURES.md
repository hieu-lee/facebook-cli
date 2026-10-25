# Agent workflow failure contract (written before implementation)

Use an isolated real Chrome with an intercepted Facebook fixture. No real account,
network posts, messages, or profile data is used by these checks. The CLI is the
entry point, not copied helper code. Save command output, timings and a screenshot.

1. Messenger PIN modal: deleting its DOM leaves React's modal/focus state active.
   Dismiss Close, then confirm Continue without restoring through real buttons.
   Handle English, Vietnamese, French; preserve unrelated dialogs; never delete DOM.
   `send` must create exactly one outgoing message and return confirmed success.
   Delayed dialog must not swallow text. Missing composer must fail before mutation.
2. Profile posts lack aria-posinset: still return the exact body and stable post ref.
   Trusted timestamp hover resolves obfuscated href; nested comments are not posts.
3. Post: explicit audience must be verified before submit. Composer closure alone
   does not prove a post exists. Return `posted<TAB>ref<TAB>path` only after a new
   exact post is found. No automatic second publish after an ambiguous outcome.
   Existing identical text must not confirm a failed publish. Delete uses the ref
   and must choose only the target post's menu, not a cover/profile menu.
4. Generic browser fallback: named pages survive commands, independent pages do not
   share state, stale snapshot targets fail rather than clicking a replacement.
   Snapshot is compact and bounded; names and values must be TSV-safe. Support
   navigation, snapshot, click, fill, key, scroll, upload, eval, screenshot, close.
   Invalid args must fail before browser mutations. Failure never silently retries
   an irreversible action. A page close/timeout must not leak browser slots.
5. Restart/reconnect: explicit pages are not accidentally used by normal commands;
   stale refs must fail after navigation/account change/daemon restart.
6. Release: CLI identifies version, all release assets correspond to one validated
   commit, checksums publish only after every target build succeeds.

Live acceptance: read-only profile/posts/chats and no duplicate `fb cli test` send.
One unique Only-me post may be created, read back, and deleted using returned ref.
Record the result and cleanup even when an intermediate assertion fails.

Live-discovered variants now represented in the fixture: audience controls can be
replaced during React's selection commit, and a profile URL can have a trailing
slash while its author link does not. Re-read the live audience control and compare
canonical profile identities, not the lifetime of an old DOM node or raw URL bytes.

Independent-review variants: receipt polling must revisit a card after body
hydration; rendered inline spans must not invent newlines; collapsed long text
must expand before comparison; explicit unlock must open a persisted Enter PIN
banner after normal commands skip restoration; HTTP pages must initialize their
ref epoch outside a secure context; release publication must exclude e2e-* assets.

Creation receipts must come from this tab's observed ComposerStoryCreateMutation
response, not from profile visibility. Old cards may be fully absent, header-only,
or missing URLs while loading. A failed create must never return any old post ref.
Reject malformed response, foreign actor, external URL, missing/ambiguous evidence;
then read the exact created URL and full rendered body back before returning a ref.

Fill must not change a covered control behind a modal. Check coverage before focus
or selection. Reject checkbox/radio/file/date/etc. as non-text fill targets rather
than silently dispatching text that cannot change the control. Use click/CDP for
other input types.

SPA pushState, replaceState (even the same URL), hash navigation and history
roundtrips must invalidate existing refs. Retained DOM controls with unchanged
labels must never keep an actionable ref across navigation to another context.

Text-producing trusted keys must include text and preserve modifiers. Shift+Enter
inserts a newline, Shift+a/Shift+1 produce A/!, selection shortcuts do not insert
text. Multiline post and Messenger send must preserve newlines exactly and send
once. Use one shared key boundary, not caller-specific raw/text key paths.

Snapshot truncation must count Unicode code points at text/label/value boundaries
and normalize malformed surrogate input. Emoji must never poison CDP JSON and hang
a command. Virtualized roots reused for another post must be reread, with and
without aria-posinset. Native editing shortcuts (select all/cut/undo/redo) must
perform the expected edit rather than returning ok for a silent raw-key no-op.

A root recycled during trusted timestamp hover must never associate old body with
new URL. Bind pending hover to captured render identity, reject/retry extraction
if it changed, and do not mark the replacement seen before reading it.
Native editor binding coverage includes caret/selection/word/deletion chords, not
only letter accelerators. Use the platform's established binding data.

Trusted mouse movement and focus can replace/rename a snapshot target. Validate
actionability and exact target identity after hover, reject moved geometry, then
press without another move. Fill must recheck identity/focus after focus/select.
No click or text may reach the changed target.

Focus redirection may be queued in a microtask. Fill's final validation must be a
separate side-effect-free CDP evaluation after focus/select, not another check at
the end of the same script. Neither intended nor redirected field may be edited.

Queued selection changes on the same focused target must not turn fill into an
append/prepend. Validate full replacement selection for native controls and
contenteditable at the side-effect-free final boundary, before inserting text.

The disposable Chrome E2E must ignore an inherited FB_SOCK. A separate mock Unix
socket must receive no fixture status, mutation, or cleanup stop requests.

Client disconnection while target preparation/hover is delayed must prevent the
subsequent click/fill/upload dispatch. Recheck cancellation at the final pre-input
boundary and close the uncertain named page rather than restoring it to registry.

Post capture setup (UID/network enable) can be delayed after preparation. A known
client disconnect during these awaits must prevent Post, disable capture, and
report no publication. A transparent real-Chrome CDP relay holds Network.enable's
response until the actual CLI client is gone; no fake Chrome result is substituted.

macOS native insertion chords that cannot be faithfully dispatched must fail
before any event, not return ok with only a movement suffix. Ctrl+O and modified
Ctrl/Alt Enter are explicitly unsupported; ordinary Enter/Shift+Enter work.

Native disabled fieldsets disable descendants even when their disabled property is
false. Ref actions must reject effective :disabled controls before dispatch; first
legend descendants are the native exception and must remain usable.

ARIA disabled state inherits through ancestors. The nearest valid true/false
token (case insensitive) wins; invalid tokens continue inheritance. An explicit
false can override ARIA true, but cannot override native :disabled state. Reject
disabled clicks/fills and preserve enabled overrides, matching actual Chrome AX.

aria-labelledby labels (ordered multiple IDs, hidden labels, aria-label on label
nodes, nested labelled content) must participate in names, PIN/password redaction
and fingerprints. HTML labels combine too; ordinary labelled draft values remain
visible. Referenced label renames must invalidate old refs.

A delayed PIN can autofocus during multiline typing. Before Enter, verify the
actual full draft matches the requested text and focus still belongs to composer.
Only exact full text once or no outgoing message is acceptable; no partial send,
no automatic retype/retry. A deliberately truncated draft must fail before send.

Snapshot value safety must not depend on complete accessible-name heuristics.
Never emit form/editor values by default, including unlabeled textarea/editor
content used as an accidental name. Explicit targeted eval still reads values.
Native image alt participates in names and fingerprints independently.

Only the current document's genuine Facebook hostname can mark Facebook session
expired. External query strings/lookalike hosts and a Facebook-to-external redirect
must not poison it; real Facebook login still marks it stale.

Use browser-effective editability, not a literal contenteditable attribute token.
Empty, plaintext-only, mixed-case true, and inherited editable modes must omit all
draft text and expose usable editor refs. Noneditable islands inside an editor
are still editor content and must not leak. A standalone false/invalid token is
ordinary page content, not a new editable control. Fill each valid editing host
through trusted input and explicitly read back the exact replacement.

Editor contents must also be omitted from fallback names on wrapping controls.
A button/link/role-button containing an editor must keep its surrounding label but
not promote a nested textarea or editable draft into the control name. Reuse the
same editor-aware label traversal instead of an unrestricted innerText fallback.
This also applies to control names inside a noneditable island within an editor:
the plain descendant text remains draft content, not an explicit accessible label.
