mod act;
mod browser;
mod cdp;
mod client;
mod cmd;
mod connect;
mod daemon;
mod dev;
mod feed;
mod help;
mod ipc;
mod keys;
mod messenger;
mod ops;
mod page;
mod proto;
mod refs;
mod session;

fn main() {
    let argv: Vec<String> = std::env::args().skip(1).collect();
    if argv.first().map(String::as_str) == Some("__daemon") {
        daemon::main();
        return;
    }
    std::process::exit(client::run(argv));
}
