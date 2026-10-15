//! A discrete-event simulation of requests flowing through a system.
//!
//! Time jumps from event to event (a request arrives, a worker finishes, a
//! client gives up), so a minute of traffic at thousands of requests per second
//! takes milliseconds to compute. Every number in the result is measured from
//! individual simulated requests, not derived from a formula.

use std::cmp::Ordering;
use std::collections::{BinaryHeap, HashMap, VecDeque};

use crate::model::{ComponentStats, LatencySummary, SimConfig, SimResult, Step};
use crate::random::Rng;

/// Stops runaway runs (a hopelessly overloaded system with retries can create
/// events faster than it clears them); the result is then marked truncated.
const MAX_EVENTS: u64 = 5_000_000;
/// After arrivals stop, in-flight requests get this long to finish.
const DRAIN_S: f64 = 60.0;

#[derive(Clone, Copy)]
enum Kind {
    Arrival,
    Retry { request: usize },
    Done { attempt: usize, component: usize },
    Timeout { attempt: usize },
}

struct Event {
    time: f64,
    /// Breaks ties in scheduling order, so runs are deterministic.
    seq: u64,
    kind: Kind,
}

impl PartialEq for Event {
    fn eq(&self, other: &Self) -> bool {
        self.cmp(other) == Ordering::Equal
    }
}
impl Eq for Event {}
impl PartialOrd for Event {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}
impl Ord for Event {
    // BinaryHeap is a max-heap; reverse so the earliest event comes out first.
    fn cmp(&self, other: &Self) -> Ordering {
        other.time.total_cmp(&self.time).then(other.seq.cmp(&self.seq))
    }
}

struct Station {
    servers: u32,
    service_s: f64,
    cv: f64,
    queue_limit: Option<u32>,
    busy: u32,
    /// Waiting attempts, with the time each joined the queue.
    queue: VecDeque<(usize, f64)>,
    // Measurements, over the measurement window only.
    last_time: f64,
    busy_area: f64,
    queue_area: f64,
    max_queue: u32,
    served: u64,
    wait_sum: f64,
    waits: u64,
    rejected: u64,
}

struct Request {
    arrived: f64,
    attempts: u32,
    finished: bool,
    measured: bool,
}

struct Attempt {
    request: usize,
    path: Vec<usize>,
    step: usize,
    /// The client gave up on it (timed out) or it was rejected. A timed-out
    /// attempt keeps using workers until it finishes: wasted work.
    abandoned: bool,
    complete: bool,
}

enum Failure {
    TimedOut,
    Rejected,
}

/// Steps with their component ids already resolved to station indexes.
enum Route {
    Visit(usize),
    Branch { probability: f64, then: Vec<Route>, otherwise: Vec<Route> },
}

fn resolve(steps: &[Step], index: &HashMap<&str, usize>) -> Result<Vec<Route>, String> {
    steps
        .iter()
        .map(|step| match step {
            Step::Visit { component } => index
                .get(component.as_str())
                .map(|&i| Route::Visit(i))
                .ok_or_else(|| format!("unknown component \"{component}\" in a flow")),
            Step::Branch { probability, then, otherwise } => Ok(Route::Branch {
                probability: probability.clamp(0.0, 1.0),
                then: resolve(then, index)?,
                otherwise: resolve(otherwise, index)?,
            }),
        })
        .collect()
}

/// Turns a flow's steps into the concrete path one attempt takes, rolling the dice at each branch.
fn walk(routes: &[Route], rng: &mut Rng, path: &mut Vec<usize>) {
    for route in routes {
        match route {
            Route::Visit(i) => path.push(*i),
            Route::Branch { probability, then, otherwise } => {
                let taken = if rng.uniform() < *probability { then } else { otherwise };
                walk(taken, rng, path);
            }
        }
    }
}

struct Sim {
    rng: Rng,
    heap: BinaryHeap<Event>,
    seq: u64,
    stations: Vec<Station>,
    flows: Vec<(f64, Vec<Route>)>,
    flow_weight: f64,
    requests: Vec<Request>,
    attempts: Vec<Attempt>,
    window: (f64, f64),
    timeout_s: Option<f64>,
    retries: u32,
    backoff_s: f64,
    // Client-side measurements.
    attempts_in_window: u64,
    latencies: Vec<f64>,
    timed_out: u64,
    rejected: u64,
}

impl Sim {
    fn schedule(&mut self, time: f64, kind: Kind) {
        self.seq += 1;
        self.heap.push(Event { time, seq: self.seq, kind });
    }

    fn in_window(&self, t: f64) -> bool {
        t >= self.window.0 && t < self.window.1
    }

    /// Accumulates busy workers and queue length over time, clipped to the window.
    fn advance(&mut self, s: usize, t: f64) {
        let (start, end) = self.window;
        let station = &mut self.stations[s];
        let from = station.last_time.max(start);
        let to = t.min(end);
        if to > from {
            let dt = to - from;
            station.busy_area += station.busy as f64 * dt;
            station.queue_area += station.queue.len() as f64 * dt;
        }
        station.last_time = t;
    }

    fn start_attempt(&mut self, request: usize, t: f64) {
        self.requests[request].attempts += 1;
        if self.in_window(t) {
            self.attempts_in_window += 1;
        }
        // Pick a flow by weight, then a concrete path through it.
        let mut pick = self.rng.uniform() * self.flow_weight;
        let mut chosen = self.flows.len() - 1;
        for (i, (weight, _)) in self.flows.iter().enumerate() {
            if pick < *weight {
                chosen = i;
                break;
            }
            pick -= weight;
        }
        let mut path = Vec::new();
        walk(&self.flows[chosen].1, &mut self.rng, &mut path);

        let attempt = self.attempts.len();
        self.attempts.push(Attempt { request, path, step: 0, abandoned: false, complete: false });
        if let Some(timeout) = self.timeout_s {
            self.schedule(t + timeout, Kind::Timeout { attempt });
        }
        self.visit_next(attempt, t);
    }

    /// Sends an attempt to the next component on its path, or completes it.
    fn visit_next(&mut self, attempt: usize, t: f64) {
        let a = &self.attempts[attempt];
        if a.step >= a.path.len() {
            self.complete(attempt, t);
            return;
        }
        let s = a.path[a.step];
        self.advance(s, t);
        let measured = self.in_window(t);
        let station = &mut self.stations[s];
        if station.busy < station.servers {
            station.busy += 1;
            if measured {
                station.waits += 1;
            }
            let service = self.rng.service_time(station.service_s, station.cv);
            self.schedule(t + service, Kind::Done { attempt, component: s });
        } else if station.queue_limit.is_some_and(|limit| station.queue.len() as u32 >= limit) {
            if measured {
                station.rejected += 1;
            }
            self.fail(attempt, t, Failure::Rejected);
        } else {
            station.queue.push_back((attempt, t));
            station.max_queue = station.max_queue.max(station.queue.len() as u32);
        }
    }

    fn finish_service(&mut self, attempt: usize, s: usize, t: f64) {
        self.advance(s, t);
        let measured = self.in_window(t);
        let station = &mut self.stations[s];
        if measured {
            station.served += 1;
        }
        // The freed worker takes the next waiting attempt, if any.
        if let Some((next, queued_at)) = station.queue.pop_front() {
            if measured {
                station.wait_sum += t - queued_at;
                station.waits += 1;
            }
            let service = self.rng.service_time(station.service_s, station.cv);
            self.schedule(t + service, Kind::Done { attempt: next, component: s });
        } else {
            station.busy -= 1;
        }
        self.attempts[attempt].step += 1;
        self.visit_next(attempt, t);
    }

    fn complete(&mut self, attempt: usize, t: f64) {
        let a = &mut self.attempts[attempt];
        a.complete = true;
        if a.abandoned {
            return; // the client stopped waiting long ago: wasted work
        }
        let request = &mut self.requests[a.request];
        if request.finished {
            return;
        }
        request.finished = true;
        if request.measured {
            self.latencies.push(t - request.arrived);
        }
    }

    fn fail(&mut self, attempt: usize, t: f64, why: Failure) {
        let a = &mut self.attempts[attempt];
        if a.abandoned || a.complete {
            return;
        }
        a.abandoned = true;
        let request = a.request;
        if self.requests[request].finished {
            return;
        }
        if self.requests[request].attempts <= self.retries {
            self.schedule(t + self.backoff_s, Kind::Retry { request });
            return;
        }
        let r = &mut self.requests[request];
        r.finished = true;
        if r.measured {
            match why {
                Failure::TimedOut => self.timed_out += 1,
                Failure::Rejected => self.rejected += 1,
            }
        }
    }
}

fn percentile(sorted: &[f64], p: f64) -> f64 {
    if sorted.is_empty() {
        return 0.0;
    }
    let rank = ((p / 100.0) * sorted.len() as f64).ceil() as usize;
    sorted[rank.clamp(1, sorted.len()) - 1]
}

/// Runs the simulation and measures the result.
pub fn run(config: &SimConfig) -> Result<SimResult, String> {
    if !(config.rate > 0.0) || !config.rate.is_finite() {
        return Err("rate must be a positive number".into());
    }
    if config.duration_s <= 0.0 || config.warmup_s < 0.0 {
        return Err("duration must be positive and warm-up not negative".into());
    }
    let index: HashMap<&str, usize> = config.components.iter().enumerate().map(|(i, c)| (c.id.as_str(), i)).collect();
    let flows = config
        .flows
        .iter()
        .filter(|f| f.weight > 0.0)
        .map(|f| Ok((f.weight, resolve(&f.steps, &index)?)))
        .collect::<Result<Vec<_>, String>>()?;
    if flows.is_empty() {
        return Err("at least one flow needs a positive weight".into());
    }
    for c in &config.components {
        if c.servers == 0 || !(c.service_ms >= 0.0) {
            return Err(format!("component \"{}\" needs at least one server and a service time", c.id));
        }
    }

    let start = config.warmup_s;
    let end = config.warmup_s + config.duration_s;
    let mut sim = Sim {
        rng: Rng::new(config.seed),
        heap: BinaryHeap::new(),
        seq: 0,
        stations: config
            .components
            .iter()
            .map(|c| Station {
                servers: c.servers,
                service_s: c.service_ms / 1000.0,
                cv: c.cv.max(0.0),
                queue_limit: c.queue_limit,
                busy: 0,
                queue: VecDeque::new(),
                last_time: 0.0,
                busy_area: 0.0,
                queue_area: 0.0,
                max_queue: 0,
                served: 0,
                wait_sum: 0.0,
                waits: 0,
                rejected: 0,
            })
            .collect(),
        flow_weight: flows.iter().map(|(w, _)| w).sum(),
        flows,
        requests: Vec::new(),
        attempts: Vec::new(),
        window: (start, end),
        timeout_s: config.client.timeout_ms.filter(|t| *t > 0.0).map(|t| t / 1000.0),
        retries: config.client.retries,
        backoff_s: config.client.backoff_ms.max(0.0) / 1000.0,
        attempts_in_window: 0,
        latencies: Vec::new(),
        timed_out: 0,
        rejected: 0,
    };

    let first = sim.rng.exponential(1.0 / config.rate);
    sim.schedule(first, Kind::Arrival);
    let mut events = 0u64;
    let mut truncated = false;
    while let Some(event) = sim.heap.pop() {
        let t = event.time;
        if t > end + DRAIN_S {
            break;
        }
        events += 1;
        if events > MAX_EVENTS {
            truncated = true;
            break;
        }
        match event.kind {
            Kind::Arrival => {
                let measured = sim.in_window(t);
                let request = sim.requests.len();
                sim.requests.push(Request { arrived: t, attempts: 0, finished: false, measured });
                sim.start_attempt(request, t);
                let next = t + sim.rng.exponential(1.0 / config.rate);
                if next < end {
                    sim.schedule(next, Kind::Arrival);
                }
            }
            Kind::Retry { request } => sim.start_attempt(request, t),
            Kind::Done { attempt, component } => sim.finish_service(attempt, component, t),
            Kind::Timeout { attempt } => sim.fail(attempt, t, Failure::TimedOut),
        }
    }
    // Close the time integrals at the end of the window.
    for s in 0..sim.stations.len() {
        sim.advance(s, end);
    }

    let measured = sim.requests.iter().filter(|r| r.measured).count() as u64;
    let succeeded = sim.latencies.len() as u64;
    // Requests still unfinished when the run ended count as timed out.
    let unfinished = measured.saturating_sub(succeeded + sim.timed_out + sim.rejected);
    let mut latencies = std::mem::take(&mut sim.latencies);
    latencies.sort_by(f64::total_cmp);
    let to_ms = 1000.0;
    let duration = config.duration_s;

    Ok(SimResult {
        offered_per_s: config.rate,
        attempts_per_s: sim.attempts_in_window as f64 / duration,
        goodput_per_s: succeeded as f64 / duration,
        success_rate: if measured > 0 { succeeded as f64 / measured as f64 } else { 0.0 },
        timed_out: sim.timed_out + unfinished,
        rejected: sim.rejected,
        latency: LatencySummary {
            mean_ms: if latencies.is_empty() { 0.0 } else { latencies.iter().sum::<f64>() / latencies.len() as f64 * to_ms },
            p50_ms: percentile(&latencies, 50.0) * to_ms,
            p95_ms: percentile(&latencies, 95.0) * to_ms,
            p99_ms: percentile(&latencies, 99.0) * to_ms,
            max_ms: latencies.last().copied().unwrap_or(0.0) * to_ms,
        },
        components: config
            .components
            .iter()
            .zip(&sim.stations)
            .map(|(c, s)| ComponentStats {
                id: c.id.clone(),
                label: c.label.clone(),
                utilization: (s.busy_area / (s.servers as f64 * duration)).min(1.0),
                throughput_per_s: s.served as f64 / duration,
                mean_queue: s.queue_area / duration,
                max_queue: s.max_queue,
                mean_wait_ms: if s.waits > 0 { s.wait_sum / s.waits as f64 * to_ms } else { 0.0 },
                rejected: s.rejected,
            })
            .collect(),
        truncated,
    })
}
