//! Structura's load simulator: put traffic through a system design and measure
//! where it slows down or breaks. Compiled to WebAssembly for the browser.

mod engine;
mod model;
mod random;

pub use engine::run;
pub use model::*;

use wasm_bindgen::prelude::*;

/// JSON in, JSON out: `config` is a [`SimConfig`]; the result is a [`SimResult`]
/// or `{"error": "..."}`.
#[wasm_bindgen]
pub fn simulate(config: &str) -> String {
    let outcome = serde_json::from_str::<SimConfig>(config)
        .map_err(|e| format!("invalid config: {e}"))
        .and_then(|config| run(&config));
    match outcome {
        Ok(result) => serde_json::to_string(&result).unwrap_or_else(|e| error_json(&e.to_string())),
        Err(message) => error_json(&message),
    }
}

fn error_json(message: &str) -> String {
    serde_json::json!({ "error": message }).to_string()
}
