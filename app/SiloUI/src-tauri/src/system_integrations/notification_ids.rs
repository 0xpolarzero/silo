use std::collections::HashMap;
use std::sync::Mutex;

/// Coordinate server mutations with the IDs used to replace and withdraw notices.
pub(super) struct NotificationIds(Mutex<Option<HashMap<String, u32>>>);

impl NotificationIds {
    pub(super) const fn new() -> Self {
        Self(Mutex::new(None))
    }

    pub(super) fn deliver(
        &self,
        key: &str,
        send: impl FnOnce(u32) -> Result<u32, String>,
    ) -> Result<(), String> {
        let mut guard = self.0.lock().unwrap_or_else(|error| error.into_inner());
        let ids = guard.get_or_insert_with(Default::default);
        let replaces = ids.get(key).copied().unwrap_or(0);
        let id = send(replaces)?;
        ids.insert(key.into(), id);
        Ok(())
    }

    pub(super) fn clear(&self, keys: &[String], mut close: impl FnMut(u32)) {
        let mut guard = self.0.lock().unwrap_or_else(|error| error.into_inner());
        let Some(ids) = guard.as_mut() else { return };
        for key in keys {
            if let Some(id) = ids.remove(key) {
                close(id);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;
    use std::sync::{mpsc, Arc};
    use std::time::Duration;

    #[derive(Default)]
    struct Server {
        next: u32,
        active: HashSet<u32>,
    }

    impl Server {
        fn notify(&mut self, replaces: u32) -> u32 {
            if replaces != 0 && self.active.contains(&replaces) {
                return replaces;
            }
            self.next += 1;
            self.active.insert(self.next);
            self.next
        }
    }

    #[test]
    fn concurrent_same_key_delivery_replaces_and_clear_withdraws_every_notice() {
        let ids = Arc::new(NotificationIds::new());
        let server = Arc::new(Mutex::new(Server::default()));
        let (entered, first_entered) = mpsc::channel();
        let (release, wait_release) = mpsc::channel();
        let first_ids = ids.clone();
        let first_server = server.clone();
        let first = std::thread::spawn(move || {
            first_ids
                .deliver("sandbox", |replaces| {
                    entered.send(()).unwrap();
                    wait_release.recv().unwrap();
                    Ok(first_server.lock().unwrap().notify(replaces))
                })
                .unwrap();
        });
        first_entered.recv().unwrap();
        let (started, second_started) = mpsc::channel();
        let (sent, second_sent) = mpsc::channel();
        let second_ids = ids.clone();
        let second_server = server.clone();
        let second = std::thread::spawn(move || {
            started.send(()).unwrap();
            second_ids
                .deliver("sandbox", |replaces| {
                    let id = second_server.lock().unwrap().notify(replaces);
                    sent.send(()).unwrap();
                    Ok(id)
                })
                .unwrap();
        });
        second_started.recv().unwrap();
        let _ = second_sent.recv_timeout(Duration::from_millis(100));
        release.send(()).unwrap();
        first.join().unwrap();
        second.join().unwrap();
        assert_eq!(
            server.lock().unwrap().active.len(),
            1,
            "same key must replace"
        );
        ids.clear(&["sandbox".into()], |id| {
            server.lock().unwrap().active.remove(&id);
        });
        assert!(server.lock().unwrap().active.is_empty());
    }
}
