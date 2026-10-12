# Out of scope

Read before opening an issue or proposing a feature under P1. Check source and product help for the existing surface first.
No declined product-feature ledger was established in this setup; do not infer a declined feature from this file.

This local setup leaves product behavior, engine/reference files, runtime data, public publication, deployment, and paid services outside its authorized scope.
Existing lint findings are measured by the ratchet; setup does not rewrite app-wide copy or fix unrelated product findings.
English is the current UI language. Existing literals are a backlog under C3.
The first user-facing copy change must establish one documented resource module and route that changed copy through it.
Do not add an empty unused resource module during setup. Future supported locales change together under C3.
Indirect UI text and semantic accessibility outcomes require review beyond the syntax lint.

The instruction scanner does not measure semantic preview expiry, safety ordering, signed claims, backup/readback correctness,
consent/blocker sequencing, credential meaning, or PID identity. Existing behavior tests and independent review own those claims.
Rust/PowerShell are not fed to a JavaScript comment stripper. Their lifecycle checks retain the current documented limits.
Original server baseline warnings involved worker termination after passing assertions; their root cause remains unproven.
The parent's setup record holds the raw baseline evidence. Do not reinterpret a warning as a proved process leak or a waived future failure.

The glib <0.20 Dependabot alert (VariantStrIter unsoundness) is dismissed as not used: glib is a Linux-only transitive
dependency of the Tauri 2 GTK stack (tauri -> tao/wry/tray-icon -> gtk 0.18 -> glib 0.18.5) and cargo tree proves it is
never compiled for the Windows-only product. No fix exists in the Tauri 2.x line: 0.18.5 is the final 0.18.x and the
patch is the semver-incompatible glib 0.20. Revisit when any build targets Linux/macOS or Tauri's platform stack upgrades.
