//! Token-management transport. Never replays a request inside an HTTP call.
//! The policy worker retries only the latest intent after these gates allow it.
use reqwest::{
    blocking::{Client, Response},
    header::HeaderMap,
};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    io::Read,
    sync::{Mutex, OnceLock},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

const MAX_RETRIES: u32 = 5;
const MAX_RESPONSE: u64 = 8 * 1024 * 1024;
static CLIENT: OnceLock<Client> = OnceLock::new();
static GATES: OnceLock<Mutex<Gates>> = OnceLock::new();
#[derive(Default)]
struct Gates {
    requests: HashMap<String, Failure>,
    rate_until: u64,
}
struct Failure {
    attempts: u32,
    until: Option<u64>,
    message: String,
}
fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}
fn gates() -> &'static Mutex<Gates> {
    GATES.get_or_init(|| Mutex::new(Gates::default()))
}
fn client() -> Result<&'static Client, String> {
    if let Some(client) = CLIENT.get() {
        return Ok(client);
    }
    let client = Client::builder()
        .timeout(Duration::from_secs(30))
        .redirect(reqwest::redirect::Policy::none())
        .user_agent("Silo")
        .build()
        .map_err(|_| "Cannot initialize GitHub connection.")?;
    let _ = CLIENT.set(client);
    CLIENT
        .get()
        .ok_or_else(|| "Cannot initialize GitHub connection.".into())
}
fn key(route: &str, body: &[u8]) -> String {
    // Only hashes identify failed requests; credentials never appear in diagnostics.
    let mut hash = Sha256::new();
    hash.update(route);
    hash.update(body);
    format!("{:x}", hash.finalize())
}
fn waiting(until: u64, at: u64) -> String {
    format!(
        "GitHub access update is waiting. Retrying in {} seconds.",
        until.saturating_sub(at).max(1)
    )
}
impl Gates {
    fn check(&self, key: &str, at: u64) -> Result<(), String> {
        if self.rate_until > at {
            return Err(waiting(self.rate_until, at));
        }
        if let Some(failure) = self.requests.get(key) {
            match failure.until {
                Some(until) if until > at => return Err(waiting(until, at)),
                None => return Err(failure.message.clone()),
                _ => {}
            }
        }
        Ok(())
    }
    fn fail(
        &mut self,
        key: String,
        at: u64,
        retryable: bool,
        floor: u64,
        rate: bool,
        jitter: u64,
        message: &str,
    ) -> String {
        let attempts = self
            .requests
            .get(&key)
            .map_or(1, |f| f.attempts.saturating_add(1));
        let base = if rate { 60u64 } else { 2 };
        let delay = base
            .saturating_mul(1u64 << attempts.saturating_sub(1).min(10))
            .min(900);
        let until = at
            .saturating_add(delay)
            .max(floor)
            .saturating_add(jitter % 4);
        if rate {
            self.rate_until = self.rate_until.max(until);
        }
        let retry = retryable && attempts <= MAX_RETRIES;
        let message = if retry {
            waiting(until, at)
        } else {
            format!("{message} Automatic retries stopped. Retry explicitly after checking GitHub access.")
        };
        self.requests.insert(
            key,
            Failure {
                attempts,
                until: retry.then_some(until),
                message: message.clone(),
            },
        );
        message
    }
}
pub(crate) fn retry_at() -> u64 {
    gates()
        .lock()
        .map(|g| {
            g.requests
                .values()
                .filter_map(|f| f.until)
                .min()
                .unwrap_or(0)
                .max(g.rate_until)
        })
        .unwrap_or(u64::MAX)
}
pub(crate) fn retry_allowed() -> bool {
    gates()
        .lock()
        .map(|g| g.requests.is_empty() || g.requests.values().any(|f| f.until.is_some()))
        .unwrap_or(false)
}
pub(crate) fn reset_retries() {
    // An explicit Retry cannot bypass GitHub's requested waiting period.
    if let Ok(mut g) = gates().lock() {
        g.requests.clear();
    }
}
fn preflight(key: &str) -> Result<(), String> {
    gates()
        .lock()
        .map_err(|_| "GitHub retry state is unavailable.")?
        .check(key, now())
}
fn failure(key: &str, retryable: bool, floor: u64, rate: bool, message: &str) -> String {
    let jitter = u64::from(uuid::Uuid::new_v4().as_bytes()[0]);
    gates()
        .lock()
        .map(|mut g| g.fail(key.into(), now(), retryable, floor, rate, jitter, message))
        .unwrap_or_else(|_| "GitHub retry state is unavailable.".into())
}
fn number(headers: &HeaderMap, name: &str) -> Option<u64> {
    headers.get(name)?.to_str().ok()?.parse().ok()
}
fn retry_after(headers: &HeaderMap, at: u64) -> u64 {
    let value = headers.get("retry-after").and_then(|v| v.to_str().ok());
    let after = value
        .and_then(|v| {
            v.parse::<u64>()
                .ok()
                .map(|s| at.saturating_add(s))
                .or_else(|| {
                    time::OffsetDateTime::parse(v, &time::format_description::well_known::Rfc2822)
                        .ok()
                        .and_then(|t| u64::try_from(t.unix_timestamp()).ok())
                })
        })
        .unwrap_or(0);
    let reset = if number(headers, "x-ratelimit-remaining") == Some(0) {
        number(headers, "x-ratelimit-reset").unwrap_or(0)
    } else {
        0
    };
    after.max(reset)
}
fn is_rate_limit(status: u16, headers: &HeaderMap, body: &Value) -> bool {
    if status == 429 {
        return true;
    }
    if status != 403 {
        return false;
    }
    let message = body["message"]
        .as_str()
        .unwrap_or_default()
        .to_ascii_lowercase();
    number(headers, "x-ratelimit-remaining") == Some(0)
        || retry_after(headers, now()) > 0
        || body["code"] == "rate_limited"
        || message.contains("secondary rate limit")
        || message.contains("api rate limit exceeded")
        || message.contains("abuse detection")
}
fn retryable_response(status: u16, headers: &HeaderMap, body: &Value, safe: bool) -> bool {
    is_rate_limit(status, headers, body) || (status >= 500 && (safe || body["retryable"] == true))
}
fn response(
    key: &str,
    result: Result<Response, reqwest::Error>,
    safe: bool,
) -> Result<Value, String> {
    let response = result.map_err(|_| {
        failure(
            key,
            safe,
            0,
            false,
            "Cannot reach GitHub. The request outcome is unknown.",
        )
    })?;
    let status = response.status().as_u16();
    let headers = response.headers().clone();
    let mut bytes = Vec::new();
    response
        .take(MAX_RESPONSE + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| {
            failure(
                key,
                retryable_response(status, &headers, &Value::Null, safe),
                retry_after(&headers, now()),
                is_rate_limit(status, &headers, &Value::Null),
                "GitHub returned an incomplete response.",
            )
        })?;
    if bytes.len() as u64 > MAX_RESPONSE {
        return Err(failure(
            key,
            false,
            0,
            false,
            "GitHub response exceeds the supported size.",
        ));
    }
    let body: Value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
    if (200..300).contains(&status) {
        if body.is_null() {
            return Err(failure(
                key,
                safe,
                0,
                false,
                "GitHub returned an invalid response.",
            ));
        }
        if let Ok(mut g) = gates().lock() {
            g.requests.remove(key);
        }
        return Ok(body);
    }
    let floor = retry_after(&headers, now());
    let rate = is_rate_limit(status, &headers, &body);
    let retryable = retryable_response(status, &headers, &body, safe);
    let message = if rate {
        "GitHub is limiting requests."
    } else if status == 401 {
        "GitHub authorization expired or was revoked. Reconnect GitHub."
    } else if status == 403 {
        "GitHub refused this request. Check the App's repository permissions."
    } else {
        "GitHub access could not be updated."
    };
    Err(failure(key, retryable, floor, rate, message))
}
pub(crate) fn service(root: &str, route: &str, body: Value) -> Result<Value, String> {
    let url = reqwest::Url::parse(root).map_err(|_| "GitHub service URL is invalid.")?;
    if url.scheme() != "https"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err("GitHub service requires a configured HTTPS URL.".into());
    }
    let bytes = serde_json::to_vec(&body).map_err(|_| "Cannot encode GitHub request.")?;
    let key = key(&format!("{}{route}", root.trim_end_matches('/')), &bytes);
    preflight(&key)?;
    let safe = matches!(route, "/v1/tokens/revoke" | "/v1/oauth/revoke");
    response(
        &key,
        client()?
            .post(format!("{}{}", root.trim_end_matches('/'), route))
            .json(&body)
            .send(),
        safe,
    )
}
pub(crate) fn github(token: &str, path: &str) -> Result<Value, String> {
    let key = key(path, token.as_bytes());
    preflight(&key)?;
    response(
        &key,
        client()?
            .get(format!("https://api.github.com{path}"))
            .bearer_auth(token)
            .header("Accept", "application/vnd.github+json")
            .header("X-GitHub-Api-Version", "2022-11-28")
            .send(),
        true,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn direct_github_secondary_limits_are_distinct_from_permissions() {
        let mut headers = HeaderMap::new();
        let secondary = serde_json::json!({"message": "You have exceeded a secondary rate limit."});
        assert!(is_rate_limit(403, &headers, &secondary));
        assert!(!is_rate_limit(
            403,
            &headers,
            &serde_json::json!({"message": "Resource not accessible by integration"})
        ));
        headers.insert("x-ratelimit-remaining", "0".parse().unwrap());
        // An exhausted primary limit is still a limit when reset was omitted.
        assert!(is_rate_limit(403, &headers, &Value::Null));
        assert!(!is_rate_limit(401, &headers, &secondary));
    }
    #[test]
    fn ambiguous_writes_require_service_confirmation_before_retry() {
        let headers = HeaderMap::new();
        assert!(!retryable_response(502, &headers, &Value::Null, false));
        assert!(!retryable_response(
            502,
            &headers,
            &serde_json::json!({"retryable": false}),
            false
        ));
        assert!(retryable_response(
            502,
            &headers,
            &serde_json::json!({"retryable": true}),
            false
        ));
        assert!(retryable_response(502, &headers, &Value::Null, true));
        assert!(!retryable_response(
            403,
            &headers,
            &serde_json::json!({"retryable": true}),
            false
        ));
        assert!(retryable_response(429, &headers, &Value::Null, false));
    }
    #[test]
    fn invalid_headers_do_not_classify_permissions_as_limits() {
        let mut headers = HeaderMap::new();
        headers.insert("retry-after", "unknown".parse().unwrap());
        headers.insert("x-ratelimit-remaining", "invalid".parse().unwrap());
        headers.insert("x-ratelimit-reset", "900".parse().unwrap());
        assert_eq!(retry_after(&headers, 100), 0);
        assert!(!is_rate_limit(403, &headers, &Value::Null));
    }
    #[test]
    fn repeated_limits_back_off_and_stop_after_five_retries() {
        let mut g = Gates::default();
        let mut at = 100;
        let mut delays = Vec::new();
        for _ in 0..5 {
            g.fail("scope".into(), at, true, 0, true, 0, "limit");
            let until = g.requests["scope"].until.unwrap();
            assert!(g.check("scope", until - 1).is_err());
            assert!(g.check("scope", until).is_ok());
            delays.push(until - at);
            at = until;
        }
        assert_eq!(delays, [60, 120, 240, 480, 900]);
        g.fail("scope".into(), at, true, 0, true, 0, "limit");
        assert!(g.requests["scope"].until.is_none());
        assert!(g.check("scope", u64::MAX).is_err());
    }
    #[test]
    fn server_wait_is_a_floor_and_jitter_only_extends_it() {
        let mut g = Gates::default();
        g.fail("a".into(), 100, true, 5000, true, 3, "limit");
        assert_eq!(g.requests["a"].until, Some(5003));
        assert!(g.check("other", 5002).is_err());
        // Explicit retry preserves the shared wait even after per-request reset.
        g.requests.clear();
        assert!(g.check("a", 5002).is_err());
    }
    #[test]
    fn ambiguous_mint_is_not_replayed_but_new_choice_can_proceed() {
        let mut g = Gates::default();
        g.fail("old".into(), 100, false, 0, false, 0, "unknown");
        assert!(g.check("old", u64::MAX).is_err());
        assert!(g.check("new", 100).is_ok());
    }
    #[test]
    fn retry_headers_honor_both_deadlines_and_http_date() {
        let mut h = HeaderMap::new();
        h.insert("retry-after", "120".parse().unwrap());
        h.insert("x-ratelimit-remaining", "0".parse().unwrap());
        h.insert("x-ratelimit-reset", "900".parse().unwrap());
        assert_eq!(retry_after(&h, 100), 900);
        h.remove("x-ratelimit-remaining");
        assert_eq!(retry_after(&h, 100), 220);
        h.insert(
            "retry-after",
            "Wed, 21 Oct 2015 07:28:00 GMT".parse().unwrap(),
        );
        assert_eq!(retry_after(&h, 100), 1445412480);
    }
    #[test]
    fn transient_reads_back_off_without_delaying_unrelated_keys() {
        let mut g = Gates::default();
        g.fail("read".into(), 100, true, 0, false, 0, "offline");
        assert!(g.check("read", 101).is_err());
        assert!(g.check("read", 102).is_ok());
        assert!(g.check("other", 100).is_ok());
        g.fail("read".into(), 102, true, 0, false, 0, "offline");
        assert_eq!(g.requests["read"].until, Some(106));
    }
}
