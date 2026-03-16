# R&O v0.4.0 Alpha Test Tracker

A lightweight web app for coordinating structured alpha testing of [Requests & Offers](https://github.com/happenings-community/requests-and-offers) — a peer-to-peer resource sharing application built on [Holochain](https://holochain.org).

## What It Does

This tool guides testers through 57 steps across 12 test areas, collecting structured feedback that feeds directly into our development workflow.

**For testers:**
- Step-by-step test scenarios with clear instructions and expected outcomes
- One-click result recording (Pass / Fail / Partial / Skip)
- Notes and observations saved automatically
- Direct GitHub issue creation for bugs and problems

**For developers:**
- Test results stored as JSON in this repo, version-controlled with full history
- Failed/partial tests can be filed as GitHub issues with full context
- Summary progress visible per tester

## Test Areas

| # | Area | Steps | Description |
|---|------|-------|-------------|
| 1 | Installation & First Launch | 4 | Download, install, launch, and connection status |
| 2 | Profile Creation | 5 | Create profile with markdown support |
| 3 | Profile Editing | 4 | Edit and update existing profile |
| 4 | Creating a Request | 6 | Create and verify a resource request |
| 5 | Creating an Offer | 6 | Create and verify a service offer |
| 6 | Archive & Reactivate | 4 | Lifecycle management of listings |
| 7 | Search | 5 | Search across requests, offers, users, orgs |
| 8 | Peer Discovery | 8 | Key test — two-person discovery and sync |
| 9 | Organizations | 5 | Create and manage organisations |
| 10 | Service Types | 3 | Browse and assign categories |
| 11 | Navigation & UI | 4 | Menu, responsiveness, accessibility |
| 12 | Network Resilience | 3 | Offline behaviour and reconnection |

## Architecture

```
┌─────────────────────────┐
│   GitHub Pages (UI)     │  ← Testers interact here
│   index.html            │
└──────────┬──────────────┘
           │ HTTPS
           ▼
┌─────────────────────────┐
│   Cloudflare Worker     │  ← Proxy (token stored securely)
│   ro-test-proxy         │
└──────────┬──────────────┘
           │ GitHub API
           ▼
┌─────────────────────────┐
│   This repo             │
│   data/testers.json     │
│   data/templates.json   │
│   data/results/*.json   │
│   Issues (bugs)         │
└─────────────────────────┘
```

- **Frontend:** Single HTML file served via GitHub Pages — no build step, no dependencies
- **Proxy:** Cloudflare Worker injects GitHub API token server-side — no secrets exposed client-side
- **Data:** JSON files in this repo store tester registrations, test step templates, and per-tester results
- **Issues:** Failed/partial steps can be reported directly to the main R&O repo

## For Testers

1. Go to [happenings-community.github.io/ro-test-tracker](https://happenings-community.github.io/ro-test-tracker/)
2. Register with your name and platform details
3. Work through the test scenarios at your own pace
4. Record results and observations as you go
5. Use 🐛 Report Issue for failures — this creates a GitHub issue automatically

Your progress saves automatically. Use **Returning Tester** to pick up where you left off.

## Data Structure

```
data/
├── testers.json              # All registered testers
├── templates.json            # 57 test step definitions
└── results/
    ├── nate.json             # Per-tester results and observations
    ├── sacha-pignot.json
    └── sam-turner.json
```

## For Maintainers

### Updating Test Scenarios

Test steps are defined in `data/templates.json`. Each entry has:

| Field | Content |
|-------|---------|
| `stepId` | Step ID (e.g. 1.1) |
| `testArea` | Test area name |
| `stepAction` | Step instructions (pipe `\|` delimited for bullet formatting) |
| `lookFor` | Expected outcomes (pipe `\|` delimited) |

### Updating the Frontend

Edit `index.html` in this repo. Changes deploy automatically via GitHub Pages within a few minutes.

### Cloudflare Worker

The proxy worker (`ro-test-proxy`) runs on Cloudflare's free tier. The GitHub API token is stored as an encrypted secret in the Worker's environment variables — it never appears in client-side code.

## Related

- [Requests & Offers](https://github.com/happenings-community/requests-and-offers) — the application being tested
- [Install Guide](https://github.com/happenings-community/requests-and-offers/blob/main/INSTALL.md) — download and installation instructions
- [Homebrew Tap](https://github.com/happenings-community/homebrew-requests-and-offers) — macOS Homebrew installation

## Licence

Internal testing tool for the hAppenings community. Not intended for redistribution.
