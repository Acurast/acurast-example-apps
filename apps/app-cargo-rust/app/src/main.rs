use std::env;

fn main() {
    let webhook = env::var("WEBHOOK_URL").expect("WEBHOOK_URL not set");
    let body = r#"{"language":"Rust","runtime":"rustc","message":"Hello from Rust running on Acurast!"}"#;

    let resp = ureq::post(&webhook)
        .set("Content-Type", "application/json")
        .send_string(body)
        .expect("POST failed");

    println!("posted: {}", resp.status());
}
