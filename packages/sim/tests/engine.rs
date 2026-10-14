//! The engine against queueing theory: for simple systems the right answers are
//! known exactly, so the simulator must reproduce them.

use structura_sim::{run, SimConfig};

fn config(json: serde_json::Value) -> SimConfig {
    serde_json::from_value(json).expect("valid config")
}

/// One station fed by one flow.
fn single(rate: f64, servers: u32, service_ms: f64, cv: f64, duration_s: f64) -> SimConfig {
    config(serde_json::json!({
        "seed": 7,
        "rate": rate,
        "durationS": duration_s,
        "warmupS": 50.0,
        "components": [{ "id": "s", "label": "Server", "servers": servers, "serviceMs": service_ms, "cv": cv }],
        "flows": [{ "id": "f", "weight": 1.0, "steps": [{ "kind": "visit", "component": "s" }] }]
    }))
}

fn assert_close(actual: f64, expected: f64, tolerance: f64, what: &str) {
    let error = (actual - expected).abs() / expected;
    assert!(error <= tolerance, "{what}: got {actual:.3}, expected {expected:.3} (off by {:.1}%)", error * 100.0);
}

#[test]
fn mm1_matches_theory() {
    // λ = 50/s, μ = 100/s: ρ = 0.5, sojourn time ~ Exponential(μ − λ = 50/s).
    let result = run(&single(50.0, 1, 10.0, 1.0, 4000.0)).unwrap();
    assert_close(result.components[0].utilization, 0.5, 0.02, "utilization");
    assert_close(result.latency.mean_ms, 20.0, 0.05, "mean latency");
    assert_close(result.latency.p99_ms, 1000.0 * (100f64).ln() / 50.0, 0.08, "p99 latency");
    assert_close(result.goodput_per_s, 50.0, 0.02, "goodput");
}

#[test]
fn md1_matches_pollaczek_khinchine() {
    // Constant service: W = 1/μ + ρ / (2μ(1 − ρ)) = 10 ms + 5 ms.
    let result = run(&single(50.0, 1, 10.0, 0.0, 4000.0)).unwrap();
    assert_close(result.latency.mean_ms, 15.0, 0.04, "mean latency");
}

#[test]
fn mmc_matches_erlang_c() {
    // c = 4 workers, μ = 100/s each, λ = 300/s.
    let (c, mu, lambda) = (4u32, 100.0f64, 300.0f64);
    let a = lambda / mu;
    let rho = a / c as f64;
    let factorial = |n: u32| (1..=n).map(f64::from).product::<f64>();
    let sum: f64 = (0..c).map(|k| a.powi(k as i32) / factorial(k)).sum();
    let tail = a.powi(c as i32) / (factorial(c) * (1.0 - rho));
    let erlang_c = tail / (sum + tail);
    let expected_ms = 1000.0 * (erlang_c / (c as f64 * mu - lambda) + 1.0 / mu);

    let result = run(&single(lambda, c, 10.0, 1.0, 3000.0)).unwrap();
    assert_close(result.components[0].utilization, rho, 0.02, "utilization");
    assert_close(result.latency.mean_ms, expected_ms, 0.05, "mean latency");
}

#[test]
fn same_seed_same_result() {
    let cfg = single(80.0, 2, 15.0, 1.5, 100.0);
    let a = serde_json::to_string(&run(&cfg).unwrap()).unwrap();
    let b = serde_json::to_string(&run(&cfg).unwrap()).unwrap();
    assert_eq!(a, b);
}

#[test]
fn cache_misses_reach_the_database() {
    let cfg = config(serde_json::json!({
        "rate": 1000.0, "durationS": 60.0, "warmupS": 5.0,
        "components": [
            { "id": "cache", "label": "Cache", "servers": 8, "serviceMs": 0.5 },
            { "id": "db", "label": "Database", "servers": 8, "serviceMs": 5.0 }
        ],
        "flows": [{ "id": "read", "weight": 1.0, "steps": [
            { "kind": "visit", "component": "cache" },
            { "kind": "branch", "probability": 0.1, "then": [{ "kind": "visit", "component": "db" }] }
        ]}]
    }));
    let result = run(&cfg).unwrap();
    assert_close(result.components[0].throughput_per_s, 1000.0, 0.03, "cache throughput");
    assert_close(result.components[1].throughput_per_s, 100.0, 0.08, "database throughput (10% misses)");
}

#[test]
fn full_queue_rejects() {
    // Three times the capacity with a short queue: about a third get served.
    let mut cfg = single(300.0, 1, 10.0, 1.0, 200.0);
    cfg.components[0].queue_limit = Some(10);
    let result = run(&cfg).unwrap();
    assert!(result.rejected > 0, "expected rejections");
    assert_close(result.success_rate, 1.0 / 3.0, 0.06, "success rate");
    assert!(result.components[0].max_queue <= 10);
}

#[test]
fn retries_turn_a_healthy_system_into_a_retry_storm() {
    // At 70% load the server copes: about 1% of requests exceed the 150 ms timeout.
    // Retrying them adds load; abandoned attempts still occupy the server; the
    // queue grows, more requests time out, and the system tips into a storm
    // it never recovers from (a metastable failure).
    let at_70_percent = |retries: u32| {
        let mut cfg = single(70.0, 1, 10.0, 1.0, 300.0);
        cfg.client.timeout_ms = Some(150.0);
        cfg.client.retries = retries;
        run(&cfg).unwrap()
    };
    let calm = at_70_percent(0);
    let storm = at_70_percent(3);
    assert!(calm.success_rate > 0.95, "without retries {:.1}% succeed", calm.success_rate * 100.0);
    assert!(storm.attempts_per_s > 70.0 * 3.0, "retries should multiply attempts, got {:.0}/s", storm.attempts_per_s);
    assert!(storm.goodput_per_s < calm.goodput_per_s * 0.5, "goodput {:.1}/s with retries vs {:.1}/s without", storm.goodput_per_s, calm.goodput_per_s);
    assert!(storm.components[0].utilization > 0.97, "the server stays busy doing abandoned work");
}
