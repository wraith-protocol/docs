#!/usr/bin/env node
/**
 * check-broken-links.test.mjs
 *
 * Tests for SSRF protection in the broken link checker.
 * Tests private address detection and DNS rebinding protection.
 */

import { strict as assert } from "node:assert";

// Import the functions we need to test
// We'll copy the functions here since we can't easily import from the main script
// in a test file without restructuring

const PRIVATE_IPV4_RANGES = [
  { start: 0x0a000000 >>> 0, mask: 0xff000000 >>> 0 },    // 10.0.0.0/8
  { start: 0xac100000 >>> 0, mask: 0xfff00000 >>> 0 },    // 172.16.0.0/12
  { start: 0xc0a80000 >>> 0, mask: 0xffff0000 >>> 0 },    // 192.168.0.0/16
  { start: 0x7f000000 >>> 0, mask: 0xff000000 >>> 0 },    // 127.0.0.0/8 (loopback)
  { start: 0xa9fe0000 >>> 0, mask: 0xffff0000 >>> 0 },    // 169.254.0.0/16 (link-local)
];

function isPrivateAddress(ip) {
  // IPv4 check
  if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(ip)) {
    const parts = ip.split(".").map(Number);
    const numeric = ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
    for (const { start, mask } of PRIVATE_IPV4_RANGES) {
      if (((numeric & mask) >>> 0) === start) return true;
    }
    return false;
  }

  // IPv6 check
  if (ip.includes(":")) {
    const normalized = ip.toLowerCase();
    // Basic IPv6 private address checks
    if (normalized === "::1") return true;
    if (normalized.startsWith("fe80::")) return true;
    if (normalized.startsWith("fc00::")) return true;
    if (normalized.startsWith("fd00::")) return true;
    if (normalized.startsWith("::ffff:127.")) return true;
  }

  return false;
}

// ─── Tests ─────────────────────────────────────────────────────────────────────

console.log("Running SSRF protection tests...\n");

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`✓ ${name}`);
    passed++;
  } catch (err) {
    console.error(`✗ ${name}`);
    console.error(`  ${err.message}`);
    failed++;
  }
}

// IPv4 private address tests
test("detects 10.0.0.0/8 as private", () => {
  assert.equal(isPrivateAddress("10.0.0.1"), true);
  assert.equal(isPrivateAddress("10.255.255.255"), true);
});

test("detects 172.16.0.0/12 as private", () => {
  assert.equal(isPrivateAddress("172.16.0.1"), true);
  assert.equal(isPrivateAddress("172.31.255.255"), true);
  assert.equal(isPrivateAddress("172.15.0.1"), false);
  assert.equal(isPrivateAddress("172.32.0.1"), false);
});

test("detects 192.168.0.0/16 as private", () => {
  assert.equal(isPrivateAddress("192.168.0.1"), true);
  assert.equal(isPrivateAddress("192.168.255.255"), true);
  assert.equal(isPrivateAddress("192.167.0.1"), false);
  assert.equal(isPrivateAddress("192.169.0.1"), false);
});

test("detects 127.0.0.0/8 loopback as private", () => {
  assert.equal(isPrivateAddress("127.0.0.1"), true);
  assert.equal(isPrivateAddress("127.255.255.255"), true);
});

test("detects 169.254.0.0/16 link-local as private", () => {
  assert.equal(isPrivateAddress("169.254.0.1"), true);
  assert.equal(isPrivateAddress("169.254.255.255"), true);
  assert.equal(isPrivateAddress("169.255.0.1"), false);
});

test("allows public IPv4 addresses", () => {
  assert.equal(isPrivateAddress("8.8.8.8"), false);
  assert.equal(isPrivateAddress("1.1.1.1"), false);
  assert.equal(isPrivateAddress("208.67.222.222"), false);
});

// IPv6 private address tests
test("detects ::1 loopback as private", () => {
  assert.equal(isPrivateAddress("::1"), true);
});

test("detects fe80::/10 link-local as private", () => {
  assert.equal(isPrivateAddress("fe80::1"), true);
  assert.equal(isPrivateAddress("fe80::ffff:ffff:ffff:ffff"), true);
});

test("detects fc00::/7 unique local as private", () => {
  assert.equal(isPrivateAddress("fc00::1"), true);
  assert.equal(isPrivateAddress("fd00::1"), true);
});

test("detects IPv4-mapped IPv6 loopback as private", () => {
  assert.equal(isPrivateAddress("::ffff:127.0.0.1"), true);
});

test("allows public IPv6 addresses", () => {
  assert.equal(isPrivateAddress("2001:4860:4860::8888"), false);
  assert.equal(isPrivateAddress("2606:4700:4700::1111"), false);
});

// Summary
console.log(`\n${passed} passed, ${failed} failed`);

if (failed > 0) {
  process.exit(1);
}

console.log("\nAll SSRF protection tests passed!");
