#!/usr/bin/env node
// Thin CLI entry — all functionality lives in lib.js so the MCP server
// (and any other consumer) can require it without running the CLI.
require('./lib').cli();
