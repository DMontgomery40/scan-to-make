//! counterpart-host: Linux setup, user service and credential-resolving model
//! worker for the Counterpart companion. JSON on stdout (except `serve` and the
//! worker's own stream); errors are plain, non-secret messages with a nonzero exit.
mod choice;
mod credentials;
mod host;
mod paths;
mod process;
mod worker;

use credentials::{CredentialError, CredentialStore, SecretService};
use serde_json::{json, Value};
use std::io::Read;

fn fail(message: impl std::fmt::Display) -> i32 {
    eprintln!("{message}");
    1
}

fn stdin_json() -> Result<Value, &'static str> {
    let mut bytes = Vec::new();
    std::io::stdin().lock().take(worker::MAX_INPUT as u64 + 1).read_to_end(&mut bytes).map_err(|_| "Could not read the request")?;
    if bytes.len() > worker::MAX_INPUT { return Err("The request is too large"); }
    serde_json::from_slice(&bytes).map_err(|_| "The request is not valid JSON")
}

/// stdin {choice, secret} → {choice} bound to a fresh reference. The secret is
/// validated, stored with the exact choice, and never echoed.
fn store_credential(store: &dyn CredentialStore) -> Result<Value, String> {
    let input = stdin_json()?;
    let object = input.as_object().filter(|o| o.len() == 2).ok_or(CredentialError::Invalid.message())?;
    let choice = object.get("choice").and_then(|c| choice::Choice::from_value(c).ok()).ok_or(CredentialError::Invalid.message())?;
    let secret = object.get("secret").and_then(Value::as_str).ok_or(CredentialError::Invalid.message())?;
    let reference = uuid::Uuid::new_v4().hyphenated().to_string();
    let bound = choice.with_reference(&reference).map_err(|_| "Only API and endpoint choices take a saved key".to_owned())?;
    store.save(&bound, secret, true).map_err(|e| e.message().to_owned())?;
    Ok(json!({"choice": bound.to_value()}))
}

fn remove_credential(store: &dyn CredentialStore) -> Result<Value, String> {
    let input = stdin_json()?;
    let reference = input.as_object().filter(|o| o.len() == 1).and_then(|o| o.get("reference")).and_then(Value::as_str)
        .filter(|r| choice::uuid_ok(r)).ok_or("The request needs one key reference")?;
    Ok(json!({"removed": store.remove(reference).map_err(|e| e.message().to_owned())?}))
}

fn print(value: Value) -> i32 {
    println!("{value}");
    0
}

fn run(args: Vec<String>) -> i32 {
    let words: Vec<&str> = args.iter().map(String::as_str).collect();
    if words.first() == Some(&"--model-worker") {
        return worker::main(args[1..].to_vec(), &SecretService);
    }
    if let ["credentials", action] = words.as_slice() {
        unsafe { libc::umask(0o077) };
        let result = match *action {
            "store" => store_credential(&SecretService),
            "remove" => remove_credential(&SecretService),
            _ => Err("Usage: counterpart-host credentials store|remove".into()),
        };
        return result.map(print).unwrap_or_else(fail);
    }
    if let ["--version"] = words.as_slice() {
        return print(json!({"version": env!("CARGO_PKG_VERSION")}));
    }
    let context = match host::Context::load() { Ok(c) => c, Err(e) => return fail(e) };
    match words.as_slice() {
        ["status"] => print(host::status(&context)),
        ["setup"] => host::setup(&context).map(print).unwrap_or_else(fail),
        ["serve"] => host::serve(&context).unwrap_or_else(fail),
        ["service", action] => host::service(&context, action).map(print).unwrap_or_else(fail),
        _ => fail("Usage: counterpart-host status | setup | serve | service start|stop | credentials store|remove | --model-worker check|run|project …"),
    }
}

fn main() {
    std::process::exit(run(std::env::args().skip(1).collect()));
}

#[cfg(test)]
mod tests;
