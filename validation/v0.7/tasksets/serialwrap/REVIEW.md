local-socket-peer-process-lookup: ok
lookback-window-shorthand-parsing: fixed: prompt said "RFC 3339 date-and-hour string", but the absolute form accepted is a full RFC 3339 timestamp (crates/serialwarden/src/cli/time.rs:51-55 parse_from_rfc3339); reworded to "absolute RFC 3339 timestamp". Key unchanged (sole parser; reused by cli/export.rs:236 and cli/tail.rs:71).
dns-rebinding-hostname-refusal: ok
held-agent-send-times-out: ok
serial-settings-patch-lifecycle: fixed: "applied to the open device" also covers the termios write in crates/serialwardend/src/port_io.rs:218/259 (apply_termios, reached via the live applier called at crates/serialwardend/src/port.rs:2308), a 5th file the 4-file key omitted and the flow cap cannot hold; also the browser path (crates/serialwardend/src/web/api.rs:315-323) reaches the same backend. Prompt now names the local-socket client as the entry and stops explicitly at the live-apply hand-off; key (session.rs:663, backend.rs:126/175, port.rs:2262-2343, device_profile.rs:133/402) unchanged.
agent-bridge-new-incident-reporting: ok
resolving-held-agent-commands: ok
garbled-output-diagnosis-change: ok
result-capping-step-callers: ok
add-nul-text-terminator-choice: ok
add-mark-check-bit-scheme: ok
add-csv-recording-download-format: ok
