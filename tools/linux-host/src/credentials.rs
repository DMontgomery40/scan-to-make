//! Counterpart's Secret Service namespace. Each item holds the whole immutable
//! choice with its key (the Mac's ModelCredential JSON), so a key saved for one
//! endpoint can never be replayed against another. No error text ever carries
//! the secret, the stored JSON or provider output.
use crate::choice::{secret_ok, Choice};
use serde_json::{json, Value};
use std::collections::HashMap;

pub const SCHEMA: &str = "com.scantomake.ModelAccess";
pub const APPLICATION: &str = "com.scantomake.model-access";

#[derive(Debug, PartialEq, Eq)]
pub enum CredentialError {
    Invalid,
    Missing,
    Locked,
    Unavailable,
    Mismatch,
}

impl CredentialError {
    /// Plain, actionable and non-secret: shown by the desktop app as is.
    pub fn message(&self) -> &'static str {
        match self {
            CredentialError::Invalid => "That AI choice or key is not valid. Check the model, address and key, then save again.",
            CredentialError::Missing => "Counterpart has no saved key for this AI choice. Enter the key again in Settings.",
            CredentialError::Locked => "Your login keyring is locked. Unlock it (log in to the desktop, or open Passwords and Keys), then try again.",
            CredentialError::Unavailable => "No Secret Service keyring is running in this desktop session. Install or start GNOME Keyring or KWallet's Secret Service, then try again.",
            CredentialError::Mismatch => "The saved key belongs to a different AI choice. Enter the key again for this choice in Settings.",
        }
    }
}

pub struct Saved {
    pub choice: Choice,
    pub secret: String,
}

impl std::fmt::Debug for Saved {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result { f.write_str("Saved(redacted)") }
}

pub trait CredentialStore {
    fn read(&self, reference: &str) -> Result<Saved, CredentialError>;
    fn save(&self, choice: &Choice, secret: &str, interactive: bool) -> Result<(), CredentialError>;
    fn remove(&self, reference: &str) -> Result<bool, CredentialError>;
}

pub fn encode(choice: &Choice, secret: &str) -> Vec<u8> {
    serde_json::to_vec(&json!({"version": 1, "choice": choice.to_value(), "secret": secret})).expect("JSON")
}

/// Accepts only a version-1 record whose own choice is valid and names `reference`.
pub fn decode(bytes: &[u8], reference: &str) -> Result<Saved, CredentialError> {
    let value: Value = serde_json::from_slice(bytes).map_err(|_| CredentialError::Unavailable)?;
    let object = value.as_object().ok_or(CredentialError::Unavailable)?;
    if object.len() != 3 || object.get("version") != Some(&json!(1)) {
        return Err(CredentialError::Unavailable);
    }
    let choice = Choice::from_value(object.get("choice").ok_or(CredentialError::Unavailable)?).map_err(|_| CredentialError::Unavailable)?;
    let secret = object.get("secret").and_then(Value::as_str).ok_or(CredentialError::Unavailable)?.to_owned();
    if choice.reference().map(str::to_ascii_lowercase) != Some(reference.to_ascii_lowercase()) {
        return Err(CredentialError::Unavailable);
    }
    Ok(Saved { choice, secret })
}

/// Validates the caller's choice against the saved item, then returns the key.
/// The caller's choice is only an assertion; destination and model must match exactly.
pub fn resolve(choice: &Choice, store: &dyn CredentialStore) -> Result<Option<Saved>, CredentialError> {
    choice.validate().map_err(|_| CredentialError::Invalid)?;
    let Some(reference) = choice.reference() else { return Ok(None) };
    let saved = store.read(reference)?;
    if !saved.choice.same_binding(choice) || saved.choice.validate().is_err() {
        return Err(CredentialError::Mismatch);
    }
    if !secret_ok(&saved.secret) {
        return Err(CredentialError::Invalid);
    }
    Ok(Some(saved))
}

pub struct SecretService;

fn map_error(error: secret_service::Error) -> CredentialError {
    use secret_service::Error as E;
    match error {
        E::Locked => CredentialError::Locked,
        E::NoResult => CredentialError::Missing,
        // A dismissed unlock prompt leaves the keyring locked.
        E::Prompt | E::PromptDisconnected => CredentialError::Locked,
        E::ZbusFdo(zbus::fdo::Error::AccessDenied(_)) => CredentialError::Locked,
        _ => CredentialError::Unavailable,
    }
}

fn connect() -> Result<secret_service::blocking::SecretService<'static>, CredentialError> {
    secret_service::blocking::SecretService::connect(secret_service::EncryptionType::Dh).map_err(map_error)
}

fn attributes(reference: &str) -> HashMap<&str, &str> {
    HashMap::from([("xdg:schema", SCHEMA), ("application", APPLICATION), ("reference", reference)])
}

impl CredentialStore for SecretService {
    /// Never prompts: a locked keyring is reported, not unlocked, from a background worker.
    fn read(&self, reference: &str) -> Result<Saved, CredentialError> {
        let reference = reference.to_ascii_lowercase();
        let service = connect()?;
        let found = service.search_items(attributes(&reference)).map_err(map_error)?;
        if found.unlocked.is_empty() {
            return Err(if found.locked.is_empty() { CredentialError::Missing } else { CredentialError::Locked });
        }
        if found.unlocked.len() != 1 {
            return Err(CredentialError::Unavailable);
        }
        let bytes = found.unlocked[0].get_secret().map_err(map_error)?;
        decode(&bytes, &reference)
    }

    fn save(&self, choice: &Choice, secret: &str, interactive: bool) -> Result<(), CredentialError> {
        choice.validate().map_err(|_| CredentialError::Invalid)?;
        let reference = choice.reference().ok_or(CredentialError::Invalid)?.to_ascii_lowercase();
        if !secret_ok(secret) {
            return Err(CredentialError::Invalid);
        }
        let service = connect()?;
        let collection = match service.get_default_collection() {
            Ok(collection) => collection,
            // A first-run keyring has no default collection; creating it asks for its password.
            Err(secret_service::Error::NoResult) if interactive => service.create_collection("Login", "default").map_err(map_error)?,
            Err(error) => return Err(map_error(error)),
        };
        if collection.is_locked().map_err(map_error)? {
            if !interactive {
                return Err(CredentialError::Locked);
            }
            collection.unlock().map_err(map_error)?;
            if collection.is_locked().map_err(map_error)? {
                return Err(CredentialError::Locked);
            }
        }
        collection
            .create_item("Counterpart AI key", attributes(&reference), &encode(choice, secret), false, "application/json")
            .map_err(map_error)?;
        Ok(())
    }

    /// Deletes only items in Counterpart's namespace carrying this exact reference.
    fn remove(&self, reference: &str) -> Result<bool, CredentialError> {
        let reference = reference.to_ascii_lowercase();
        let service = connect()?;
        let found = service.search_items(attributes(&reference)).map_err(map_error)?;
        if !found.locked.is_empty() {
            let locked: Vec<_> = found.locked.iter().collect();
            service.unlock_all(&locked).map_err(map_error)?;
        }
        let mut removed = false;
        for item in found.unlocked.iter().chain(found.locked.iter()) {
            let saved = item.get_attributes().map_err(map_error)?;
            if saved.get("application").map(String::as_str) == Some(APPLICATION) && saved.get("reference") == Some(&reference) {
                item.delete().map_err(map_error)?;
                removed = true;
            }
        }
        Ok(removed)
    }
}
