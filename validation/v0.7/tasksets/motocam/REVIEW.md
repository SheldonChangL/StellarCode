clip-cleanup-exemptions-and-order: ok
radar-view-out-of-window-crop: ok
firmware-download-failure-category: ok
rear-collision-flag-to-clip-capture: fixed: the prompt now also excludes the stores that only persist the settings. Without that, EventRecordingPreferenceStore.kt (read at DeviceProtocolBinder.kt:91-97) and RcwBsdSpeedGatePreferenceStore.kt (read at DeviceProtocolBinder.kt:98-101) could reasonably count as handling the "per-event toggle and low-speed gate". The toggle and the gate are actually applied in DeviceProtocolBinder.kt:117-126 and 167-168.
tip-over-to-crash-clip: ok
pick-camera-hotspot-to-process-tie: ok
retry-wait-doubling-helper-callers: ok
gps-speed-reading-new-kind-exhaustive: ok
radar-warning-new-kind-exhaustive: ok
add-ten-minute-screen-off-option: ok
hand-saved-clips-in-event-feed: fixed: the prompt said the clips do not raise "the unread badge on the bottom navigation bar", but the nav bar no longer draws a badge (MainNavBar.kt:174-183 removed BadgedBox; alertBadgeCount is unused plumbing). A careful developer would therefore have to add MainNavBar.kt to make the claimed badge appear. The prompt now refers to the count of events the rider has not yet looked at, which is computed at EmergencyRecordingViewModel.kt:83-87. I avoided an echo of the identifier unreadAlertCount. The key is unchanged: AlertsScreen.kt:85,726-731 and EmergencyRecordingViewModel.kt:85.
add-fourth-rear-collision-sensitivity: ok
