# Releases: shipping WEEHS to organizations that host it themselves

Organizations that run WEEHS on their own servers install a **versioned
image** and upgrade by replacing it with the next one. This page is how a
release is made, what an organization does with it, and the email that tells
them. Deploying one environment for the first time is
[`CONTROL-PLANE.md`](CONTROL-PLANE.md).

## What a release is

Pushing a tag `vMAJOR.MINOR.PATCH` (for example `v2.1.0`) on a commit that is
on `main` runs [`.github/workflows/release.yml`](../.github/workflows/release.yml),
which:

1. **Refuses** a tag whose commit is not on `main`, or whose name is not a
   version. A tag can point anywhere; a release is installed on other
   people's servers.
2. **Runs lint and the unit tests** on that exact commit.
3. **Builds and pushes** the dedicated-environment image
   `ghcr.io/OWNER/weehs-dedicated:2.1.0`. One image serves every
   organization; nothing about an organization is built in.
4. **Publishes the release page** with: the image pinned by **digest**, the
   source as tagged (`weehs-2.1.0-source.tar.gz`), `release.json` (version,
   commit, image, digest), and `SHA256SUMS` for both files.

Android packages are no longer built or attached to releases.

## Making a release

1. Merge what is going out into `main` and let CI pass.
2. Write down, for the release notes, anything an operator must do beyond
   replacing the image (a new required setting, a manual step). Most releases
   have none: the database schema is applied automatically at start-up.
3. On GitHub: **Releases → Draft a new release → Choose a tag** → type the
   new version (`v2.1.0`) → **Create new tag on publish**, target `main` →
   **Publish**. Or from a terminal:

```bash
git tag v2.1.0 origin/main
```

```bash
git push origin v2.1.0
```

4. Watch **Actions → Release**. When it finishes, open the release page; add
   your operator notes from step 2 at the top.
5. Send the update email below.

Use plain versions: `v2.1.0`, not `v2.1.00` or `v2.1`. Increase MAJOR when an
upgrade needs operator action, MINOR for new features, PATCH for fixes.

## Who can download the image

GitHub Container Registry makes a new package **private** by default, and it
stays that way until you change it. Decide before the first customer upgrade:

- **Public:** anyone can pull it. Simplest for customers. Combine with a
  license that says who may run it.
- **Private:** only accounts you grant can pull it. In the package's settings
  (**your profile → Packages → weehs-dedicated → Package settings**), add each
  customer's GitHub account or organization with **Read** access. Customers
  then sign in to `ghcr.io` with a token that has `read:packages`.

This repository is public, so the source is readable either way; which
organizations may _use_ it is the license's job, not the registry's.

## What an organization does with a release

**Install** (first time): on any Linux server with Docker, follow
[`SELF-HOSTING.md`](SELF-HOSTING.md); on Google Cloud Run, follow
[`CONTROL-PLANE.md`](CONTROL-PLANE.md). Both use the published image.

**Upgrade**:

1. Read the release notes for operator actions.
2. Back up the database.
3. Deploy the new image with the **same** environment variables and secrets.
   On Cloud Run, which pulls only from Artifact Registry, copy the image in
   first (`CONTROL-PLANE.md`, step 5), then:

```bash
gcloud run deploy ehs-COMPANY --image=REGION-docker.pkg.dev/PROJECT/ehs/weehs-dedicated:VERSION --region=REGION
```

Elsewhere: replace the image tag in your Compose file or orchestrator and
restart.

4. Open the site: the sign-in page loads, and `/health` answers `{"ok":true}`.

`STATE_KEY` and `SESSION_SECRET` must not change between versions: the first
decrypts the stored secrets, and the environment refuses to start without the
right one; the second signs sessions.

**Check a download**: next to the files from the release page,

```bash
sha256sum -c SHA256SUMS
```

and compare the image digest you deploy with the one on the release page.

## Supported versions

Say in your customer agreement which versions you support, for example "the
current and the previous minor version". Security fixes are released as a
PATCH on the current version; an organization on an older one upgrades to get
them.

## The update email

Send it from the address customers already know, to each organization's
technical contact. Link to the release page; do not attach files. An email
can be forged, and the release page is where an operator can check what they
install.

> **Subject:** WEEHS 2.1.0 is available
>
> Hello,
>
> WEEHS **2.1.0** is released.
>
> **What changed:** (two or three lines from the release notes)
>
> **Action needed:** None beyond replacing the image. _(Or: the one thing
> they must do.)_
>
> **Release page:** https://github.com/OWNER/REPO/releases/tag/v2.1.0
>
> The release page has the image to deploy, pinned by digest, and the
> upgrade steps. Only install images from that page; we will never send an
> image or a download link that does not point to it.
>
> Security fixes: _(yes / no)_. If yes, please upgrade within _N_ days.
>
> Regards,
> (name)
