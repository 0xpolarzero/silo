---
"silo-ui": patch
---

Keep normal HTTPS certificates for destinations that do not receive sandbox secrets, fixing TLS failures in SSH-connected coding agents that discard inherited CA settings. Secret destinations retain TLS interception, and live secret changes update which destinations are intercepted.
