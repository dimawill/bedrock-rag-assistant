# Reliability pillar — study notes

The Reliability pillar emphasizes recovery from failures and meeting demand. For an API client, use bounded retries with exponential backoff and jitter for transient errors; do not blindly retry validation failures. Set timeouts, watch error rates, and test failure recovery. Distributing critical components across Availability Zones helps reduce the impact of a single-zone failure, but does not eliminate regional failures.
