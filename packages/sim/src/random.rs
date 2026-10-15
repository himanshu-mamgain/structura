//! Seeded randomness, so the same seed always replays the same run.

/// xoshiro256** (Blackman & Vigna), seeded through SplitMix64.
pub struct Rng {
    state: [u64; 4],
}

impl Rng {
    pub fn new(seed: u64) -> Self {
        let mut s = seed;
        let mut next = || {
            s = s.wrapping_add(0x9E37_79B9_7F4A_7C15);
            let mut z = s;
            z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
            z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
            z ^ (z >> 31)
        };
        Self {
            state: [next(), next(), next(), next()],
        }
    }

    fn next_u64(&mut self) -> u64 {
        let [s0, s1, s2, s3] = &mut self.state;
        let result = s1.wrapping_mul(5).rotate_left(7).wrapping_mul(9);
        let t = *s1 << 17;
        *s2 ^= *s0;
        *s3 ^= *s1;
        *s1 ^= *s2;
        *s0 ^= *s3;
        *s2 ^= t;
        *s3 = s3.rotate_left(45);
        result
    }

    /// Uniform in (0, 1): never exactly 0, so logarithms stay finite.
    pub fn uniform(&mut self) -> f64 {
        ((self.next_u64() >> 11) as f64 + 0.5) / (1u64 << 53) as f64
    }

    pub fn exponential(&mut self, mean: f64) -> f64 {
        -mean * self.uniform().ln()
    }

    fn normal(&mut self) -> f64 {
        // Box-Muller; one of the pair is enough here.
        let (u1, u2) = (self.uniform(), self.uniform());
        (-2.0 * u1.ln()).sqrt() * (std::f64::consts::TAU * u2).cos()
    }

    /// Gamma(shape, 1) by Marsaglia & Tsang; shapes below 1 use the boost trick.
    fn gamma(&mut self, shape: f64) -> f64 {
        if shape < 1.0 {
            return self.gamma(shape + 1.0) * self.uniform().powf(1.0 / shape);
        }
        let d = shape - 1.0 / 3.0;
        let c = 1.0 / (9.0 * d).sqrt();
        loop {
            let x = self.normal();
            let v = (1.0 + c * x).powi(3);
            if v <= 0.0 {
                continue;
            }
            let u = self.uniform();
            if u.ln() < 0.5 * x * x + d - d * v + d * v.ln() {
                return d * v;
            }
        }
    }

    /// A service time with the given mean and coefficient of variation
    /// (gamma distributed: cv 1 is exponential, 0 is constant).
    pub fn service_time(&mut self, mean: f64, cv: f64) -> f64 {
        if mean <= 0.0 {
            return 0.0;
        }
        if cv <= 1e-9 {
            return mean;
        }
        let shape = 1.0 / (cv * cv);
        self.gamma(shape) * mean / shape
    }
}
