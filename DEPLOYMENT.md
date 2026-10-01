# Deployment

How the R&O test tracker is served, gated and connected to GitHub. Modelled on the design
site (`happenings-design-site`) and its `DEPLOYMENT.md`; where this file is silent, that one
explains the reasoning.

## Shape

One Cloudflare Worker, `ro-test-tracker`, serving one hostname behind Cloudflare Access.

| Piece | Job |
|---|---|
| Cloudflare Access | Decides who can load anything at all. Email one-time PIN, a list of testers |
| The Worker | Serves the page, and decides what a tester may write: only their own results file, only images, only into the Release feedback category |
| GitHub App `hAppenings Test Tracker` | The only credential. Owned by the org, installed on two repositories |

`workers_dev` and `preview_urls` are off, so there is no public `*.workers.dev` address. The
page and its API share one origin: no CORS, no origin allowlist.

Only `/api/*` runs code (`run_worker_first` in `wrangler.jsonc`). Everything else is served
straight from `public/`.

| Route | Does |
|---|---|
| `GET /api/me` | The round, and the tester's saved results |
| `POST /api/register` | Name, machine, OS version and network details, once per round |
| `PUT /api/results` | Pass, Fail, Partial or Skip, and notes |
| `POST /api/screenshot` | One image, already resized and stripped of EXIF in the browser |
| `POST /api/report` | Posts to a Release feedback discussion on R&O |

## Where things are stored

| What | Where | Public? |
|---|---|---|
| A tester's results | `data/rounds/<round>/testers/<id>.json` in this repo | Yes |
| Screenshots | `data/rounds/<round>/screenshots/<id>/` in this repo | Yes |
| Reports | Discussions on requests-and-offers, category **Release feedback** | Yes |
| Testers' emails | Only in the Access policy | No |

`<id>` is an HMAC of the tester's email keyed with `TESTER_ID_SECRET`, so the same person
gets the same file every visit, and their email never reaches the public repo. **Set that
secret once and never change it**: a new value gives everyone a new, empty file.

The tracker tells testers that screenshots are public.

## Reports

One discussion per step per round, titled `[v0.6.0-alpha.1] 13.2 · Joining & Approval`.
The first Fail or Partial on a step starts it; later reports on the same step are added as
comments. Reports from the bug button (outside the steps) each start their own discussion.

The body uses the headings of the Release feedback form (#294): Version, Machine, Screen,
What you did, What happened and what you expected, Screenshots, Network details. Version
and Machine come from the round and the tester's registration, the step text from the
published templates, never from the page. Tester text is quoted and @mentions are defused.

Maintainers promote a reproduced report to an issue, as the contributing guide says.

## A new round

1. Add `public/rounds/<round>/templates.json` (stepIds as `area.step`, at most 9 steps per
   area, because `16.10` and `16.1` are the same number)
2. Change `ROUND` and `ROUND_VERSION` in `wrangler.jsonc`
3. Merge. Earlier rounds' results stay where they are

## Deploying

Push to `main`. The workflow runs the API tests, then `wrangler deploy`. It only runs when
`worker/`, `public/`, `wrangler.jsonc` or the workflow change, so the App's own commits of
results and screenshots do not redeploy anything.

Repository secrets: `CLOUDFLARE_API_TOKEN` (template *Edit Cloudflare Workers*) and
`CLOUDFLARE_ACCOUNT_ID`.

Tests, locally: `node --test --test-concurrency=1 test/api.test.mjs`. The browser test
(`test/browser.test.mjs`) needs Playwright.

## Standing it up

The order matters. Every step that touches GitHub or Cloudflare is Sam's.

### 1. The GitHub App

Organisation settings → Developer settings → GitHub Apps → **New GitHub App**.

- Name: `hAppenings Test Tracker`. Homepage: `https://test.happenings.community`
- Callback URL: none. Webhook: **untick Active**
- Repository permissions: **Contents: Read and write**, **Discussions: Read and write**.
  Metadata: Read-only is added automatically. Nothing else
- Where can this App be installed: **Only on this account**
- Description: *Posts R&O test reports to Release feedback and stores tester results. Has no
  access beyond ro-test-tracker and requests-and-offers.*

Create it, note the **App ID**, then **Generate a private key**. A `.pem` file downloads. It
is the App's password: keep it out of the Team Room and every repo.

**Install App** → happenings-community → **Only select repositories**: `ro-test-tracker` and
`requests-and-offers`.

The App holds Contents and Discussions on both repositories, but the Worker never uses that
breadth: each token it mints is narrowed to Contents on the tracker repo alone, or
Discussions on R&O alone.

Verify the installation exists. Nothing else will tell you if it does not:

```
gh api /orgs/happenings-community/installations --jq '.installations[] | {app: .app_slug, repos: .repository_selection, permissions}'
```

### 2. Access, before the first deploy

Cloudflare One → Access → Applications → **Add an application** → Self-hosted.

- Name: `R&O test tracker`. Destination: `test-next.happenings.community` (staging)
- Policy: a new reusable policy `R&O testers`, Action Allow, Include Emails: each tester.
  Session duration on the policy: **1 month** (testers on Proton, as on the design site)
- Save, then copy the application's **Audience (AUD) tag** from its overview

Access matches on hostname, so it gates the address before anything is deployed there.

### 3. First deploy, to staging

Put the App ID into `GH_APP_ID` in `wrangler.jsonc`, merge to `main`, and let the workflow
deploy. `wrangler.jsonc` points at `test-next.happenings.community`, which Cloudflare creates.

### 4. Worker secrets

Workers & Pages → `ro-test-tracker` → Settings → Variables and Secrets → Add, type **Secret**:

| Name | Value |
|---|---|
| `GH_APP_PRIVATE_KEY` | The whole `.pem` file, including the BEGIN and END lines |
| `TESTER_ID_SECRET` | A long random string. In Terminal: `openssl rand -hex 32` |
| `ACCESS_AUD` | The Audience tag from step 2 |

Secrets survive later deploys; the plain settings in `wrangler.jsonc` are rewritten by each.
Delete the `.pem` from Downloads once the secret is saved. If it is ever needed again,
generate a new key on the App and delete the old one.

### 5. Verify on staging

```
curl -sI https://test-next.happenings.community/ | grep -i "^location"
```

It must redirect to `happeningscic.cloudflareaccess.com`. A `200` is an open door.

Then sign in, register, fail a step with a screenshot and post the report. Check the
discussion in Release feedback has all seven headings and the image shows. Have a second
tester fail the same step and check it arrives as a comment. Delete the test discussions.

### 6. Cut over

1. GitHub: ro-test-tracker → Settings → Pages → remove the custom domain, then unpublish
2. Cloudflare DNS: delete the `test` CNAME that points at `happenings-community.github.io`
   (wrangler will not overwrite a record it did not create)
3. Access: add `test.happenings.community` as a destination on the application
4. `wrangler.jsonc`: change the route pattern to `test.happenings.community`; merge
5. Repeat the `curl` check against `test.happenings.community`

### 7. Tidy, in teardown order

1. Delete the old Worker `ro-test-proxy`
2. Remove the `test-next` destination from Access
3. Delete both expired `ro-test-tracker` tokens on GitHub (fine-grained and classic)
4. Remove the old GitHub Pages files from the repo root once nobody needs them
