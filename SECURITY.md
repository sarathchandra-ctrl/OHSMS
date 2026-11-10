# Reporting a security issue

**Please do not open a public issue for a security problem.** This repository is
public and its issue tracker is world-readable, so an issue is a disclosure.

Email **sarath200795@gmail.com** with:

- what you found and where (a file and line, or a URL and the request),
- what an attacker could do with it,
- how you confirmed it — a proof of concept against the emulator is ideal, and a
  reproduction against production is not necessary and not wanted.

You should get an acknowledgement within **3 working days** and an assessment
within **10**. If a fix is warranted you will be told when it ships, and credited
by name if you would like to be.

## Scope

In scope: this application's source, its server and access rules
(`stack/`, `worker/`), and the deployed site at `suite.weehs.org`.

Out of scope: Cloudflare platform infrastructure (report those to
Cloudflare), denial of service, volumetric or automated scanning, social
engineering, and findings from a scanner with no demonstrated impact.

## Please do not

- Access, modify or delete data belonging to anybody else. This system holds
  occupational health records about real people, including medical detail. If a
  proof of concept requires reading such a record, stop and describe the path
  instead — a description is enough and is preferred.
- Run automated scanners against the production site.
- Hold a finding to a deadline. Tell us and we will move.

## Where the security documentation lives

`docs/SECURITY.md` is the register of findings that are **closed** — each with
the mechanism, what was tried, what was rejected and the test that keeps it
closed. Read it before reporting: what you have found may already be there,
fixed, with the reasoning.

**The open half is deliberately not in this repository.** Findings that are
still live, or accepted with a residual risk, are held privately by the
maintainer, because a well-written open finding is a reachability argument
somebody can act on. `docs/SECURITY.md` explains the split and the rule for what
goes where.

So: **an absence from the public register is not evidence that something is
unknown.** If you would like to check a finding against what is already recorded
before you spend time on it, email and ask — that is a reasonable request and it
will get a straight answer.
