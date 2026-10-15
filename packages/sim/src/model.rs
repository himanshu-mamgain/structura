//! The simulation's input and output, as JSON-friendly structs shared with the web app.

use serde::{Deserialize, Serialize};

/// A system to load-test: its components, the paths requests take through them,
/// and how clients behave.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SimConfig {
    /// Same seed and config always give the same result.
    #[serde(default = "default_seed")]
    pub seed: u64,
    /// Offered load: new client requests per second (Poisson arrivals).
    pub rate: f64,
    /// Simulated seconds to measure, after the warm-up.
    #[serde(default = "default_duration")]
    pub duration_s: f64,
    /// Simulated seconds discarded at the start, so the system reaches steady state.
    #[serde(default = "default_warmup")]
    pub warmup_s: f64,
    pub components: Vec<Component>,
    pub flows: Vec<Flow>,
    #[serde(default)]
    pub client: ClientPolicy,
}

fn default_seed() -> u64 {
    42
}
fn default_duration() -> f64 {
    30.0
}
fn default_warmup() -> f64 {
    5.0
}

/// Something that does work: a service, cache or database. It has `servers`
/// parallel workers (threads, connections) and a FIFO queue in front of them.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Component {
    pub id: String,
    /// Shown in results; usually the box's label on the canvas.
    pub label: String,
    pub servers: u32,
    /// Mean time one request takes once a worker picks it up.
    pub service_ms: f64,
    /// How variable service times are (standard deviation / mean): 0 = always
    /// the same, 1 = exponential, above 1 = heavy tail.
    #[serde(default = "default_cv")]
    pub cv: f64,
    /// Requests that may wait; beyond this, new ones are rejected. None = unbounded.
    #[serde(default)]
    pub queue_limit: Option<u32>,
}

fn default_cv() -> f64 {
    1.0
}

/// One kind of request and the path it takes. `weight` is its share of traffic.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Flow {
    pub id: String,
    pub weight: f64,
    pub steps: Vec<Step>,
}

/// A step on a request's path: visit a component, or branch at random
/// (e.g. a cache miss goes on to the database).
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Step {
    Visit {
        component: String,
    },
    Branch {
        /// Chance of taking `then`; otherwise `otherwise` is taken.
        probability: f64,
        then: Vec<Step>,
        #[serde(default)]
        otherwise: Vec<Step>,
    },
}

/// How clients react to slowness: give up after a timeout, and retry.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClientPolicy {
    /// The client stops waiting after this long. None = waits forever.
    pub timeout_ms: Option<f64>,
    /// Extra attempts after a timeout or rejection.
    pub retries: u32,
    pub backoff_ms: f64,
}

impl Default for ClientPolicy {
    fn default() -> Self {
        Self {
            timeout_ms: None,
            retries: 0,
            backoff_ms: 0.0,
        }
    }
}

/// What happened, measured over the measurement window (after warm-up).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SimResult {
    /// New client requests per second, as configured.
    pub offered_per_s: f64,
    /// Attempts per second that reached the system, retries included.
    pub attempts_per_s: f64,
    /// Client requests per second answered successfully within the timeout.
    pub goodput_per_s: f64,
    /// Share of client requests that succeeded (0 to 1).
    pub success_rate: f64,
    pub timed_out: u64,
    pub rejected: u64,
    pub latency: LatencySummary,
    pub components: Vec<ComponentStats>,
    /// The run stopped at the event limit (overloaded beyond recovery).
    pub truncated: bool,
}

/// End-to-end latency of successful client requests, including any retries.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LatencySummary {
    pub mean_ms: f64,
    pub p50_ms: f64,
    pub p95_ms: f64,
    pub p99_ms: f64,
    pub max_ms: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ComponentStats {
    pub id: String,
    pub label: String,
    /// Fraction of worker time spent busy (0 to 1).
    pub utilization: f64,
    pub throughput_per_s: f64,
    pub mean_queue: f64,
    pub max_queue: u32,
    /// Mean time waiting in the queue before a worker picked the request up.
    pub mean_wait_ms: f64,
    pub rejected: u64,
}
