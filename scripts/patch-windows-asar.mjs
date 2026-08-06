#!/usr/bin/env node

// Backward-compatible entry point for users of the original Windows fork.
// All platforms now share the same ASAR semantic patcher.
import "./patch-desktop-asar.mjs";
