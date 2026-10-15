# Publishing releases (repository owner only)

Server admins installing the bot don't need this page.

Every push to `main` makes GitHub Actions (`.github/workflows/release.yml`):

1. run the tests, then build the bot image for amd64 and arm64 and publish it to this repo's **Packages** (`ghcr.io/<owner>/<repo>`)
2. build `install.sh` pinned to that exact image (`scripts/build-installer.sh`)
3. publish a new **Release** with `install.sh` and the digest-pinned `update.json` attached

An open pull request or a feature branch is not a release. Wait for **Build and release** to finish. VPS automatic updates follow published releases only.

One-time setup after the first successful run: profile → **Packages** → this package → **Package settings** → **Change visibility** → **Public**. VPSes download the image without logging in. If the workflow can't create the release, set **Settings → Actions → General → Workflow permissions** to *Read and write*.

To build an installer by hand without GitHub: `bash scripts/build-installer.sh`. That installer builds the bot on the VPS.

Repo-only files (not copied to the VPS): `installer/install-head.sh` (the installer itself), `scripts/build-installer.sh` (packs the repo into `install.sh`) and `.github/workflows/` (builds and tests).

Before pushing, run `npm run lint`, `npm run format:check` and `npm test`. Pull requests run the same checks.
