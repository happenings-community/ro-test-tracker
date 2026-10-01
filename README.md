# R&O Test Tracker

Guided test scenarios for [Requests & Offers](https://github.com/happenings-community/requests-and-offers),
a peer-to-peer mutual aid app built on Holochain. Testers work through the steps for a
release, record Pass, Fail, Partial or Skip, and send what went wrong to the team as a
report they can act on.

**Live at [test.happenings.community](https://test.happenings.community)**, for invited
testers. Current round: **v0.6.0-alpha.1**, 50 steps.

## For testers

1. Open [test.happenings.community](https://test.happenings.community) and enter your email.
   A one-time code arrives in your inbox (check spam). You stay signed in for a month
2. The first time, give your name and the machine you are testing on. Every report you send
   includes it, so you only give it once
3. Work through the steps at your own pace. Pass means everything under Expected happened
4. On a Fail or Partial, a short report opens. Say which screen you were on and what
   happened, and add screenshots if you can
5. Something outside the steps? Use the 🐛 button

Your results save as you go; come back any time and carry on.

Reports are public, and so are screenshots: check nothing private is showing.

## Where reports go

Each report becomes a discussion in the
[Release feedback](https://github.com/happenings-community/requests-and-offers/discussions/categories/release-feedback)
category on the R&O repo, with the same headings as the category's own form: Version,
Machine, Screen, What you did, What happened and what you expected, Screenshots, Network
details.

There is one discussion per step per round. When a second tester fails the same step,
their report joins that discussion as a comment, so the team sees every perspective on a
step in one place. Maintainers turn a reproduced report into an issue.

## How it works

```
 tester's browser
        │
        ▼
 Cloudflare Access ─── who may come in (email one-time code, list of testers)
        │
        ▼
 Cloudflare Worker ─── serves the page, and decides what a tester may write:
 test.happenings.community     only their own results, only images,
        │                      only into Release feedback
        ▼
 GitHub App ────────── the only credential, owned by the org
 hAppenings Test Tracker
        │
        ├──► this repo         results and screenshots
        └──► R&O Discussions   reports
```

- **Page:** `public/index.html`, served as a file. No build step
- **Worker:** `worker/`. Only `/api/*` runs code
- **Results:** `data/rounds/<round>/testers/<id>.json`, one file per tester. The id is
  derived from the tester's email with a secret key, so emails never reach this public repo
- **Screenshots:** `data/rounds/<round>/screenshots/`, resized and stripped of location and
  device details in the browser before upload
- **Earlier rounds** (v0.4 and v0.5.1) are kept as they were in `data/results/`,
  `data/templates.json` and `data/testers.json`

Reports are posted by the org's GitHub App, not by a person, and its keys do not expire.
Each key the Worker uses is narrowed to one job: files in this repo, or discussions on R&O.

## For maintainers

- **Run a new round:** add `public/rounds/<round>/templates.json`, then change `ROUND` and
  `ROUND_VERSION` in `wrangler.jsonc`
- **Add a tester:** add their email to the `R&O testers` policy in Cloudflare Access
- **Deploy:** merge to `main`. The workflow runs the tests and deploys
- **Everything else** (setting it up, secrets, credentials, verifying the gate):
  [DEPLOYMENT.md](DEPLOYMENT.md)

Each step in a templates file has a `stepId` (`area.step`, at most nine steps per area),
`testArea`, `stepAction` and `lookFor`. Use `|` to split text into bullet points.

## Related

- [Requests & Offers](https://github.com/happenings-community/requests-and-offers)
- [Homebrew tap](https://github.com/happenings-community/homebrew-requests-and-offers)

Internal testing tool for the hAppenings community. Not intended for redistribution.
