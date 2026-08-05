# Contributing to troth

Thanks for considering a contribution. troth is solo-maintained, so we keep contribution flow lean and predictable.

---

## Before you start

1. **Read [`docs/HONEST-LIMITS.md`](docs/HONEST-LIMITS.md).** Understand what troth does NOT solve before suggesting features for those areas.
2. **Open an issue first** for anything beyond a single-file fix. We say no a lot — better to know early.
3. **Match the existing style.** This codebase is opinionated. Read the adjacent file before writing.

---

## Developer Certificate of Origin (DCO)

We use DCO instead of a Contributor License Agreement. By signing off on your commits, you certify the [Developer Certificate of Origin v1.1](https://developercertificate.org/):

> Developer Certificate of Origin
> Version 1.1
>
> By making a contribution to this project, I certify that:
>
> (a) The contribution was created in whole or in part by me and I
>     have the right to submit it under the open source license
>     indicated in the file; or
>
> (b) The contribution is based upon previous work that, to the best
>     of my knowledge, is licensed under an appropriate open source
>     license and I have the right under that license to submit that
>     work with modifications, whether created in whole or in part
>     by me, under the same open source license (unless I am
>     permitted to submit under a different license), as indicated
>     in the file; or
>
> (c) The contribution was provided directly to me by some other
>     person who certified (a), (b) or (c) and I have not modified
>     it.
>
> (d) I understand and agree that this project and the contribution
>     are public and that a record of the contribution (including all
>     personal information I submit with it, including my sign-off) is
>     maintained indefinitely and may be redistributed consistent with
>     this project or the open source license(s) involved.

**Practical:** every commit must include a `Signed-off-by:` line. Git makes this easy:

```bash
git commit -s -m "fix: handle empty engram batch in recall.js"
```

The line should match the email in your Git config. Our CI will reject PRs with unsigned commits.

---

## What we accept

- **Bug fixes** with a failing test, then the fix
- **Performance improvements** with a before/after benchmark
- **Documentation** corrections and additions
- **New tests** for under-covered paths
- **New benchmark methodology** (the `/benchmarks/results/*.md` pattern)

## What we decline (by default)

- **New features** without an open issue and accepted scope
- **Refactors** that touch >3 files without prior discussion
- **Dependency additions** unless absolutely necessary
- **Style-only PRs** (we run our own formatting)
- **Anything that breaks HONEST-LIMITS guarantees** — conviction-holding and metacognitive integrity stay openly named

---

## PR checklist

- [ ] Commits are signed off (`git commit -s`)
- [ ] `node tests/test-all.js` is green locally
- [ ] `node tests/standards/run.js` is green locally (the enforced standards (`npm run test:standards` prints the current set))
- [ ] New code matches surrounding style (no new linters, no new formatters)
- [ ] Documentation updated if behavior changed
- [ ] If you added a benchmark claim, the result file lives in `benchmarks/results/` with a timestamp

---

## Maintainer cadence

The maintainer responds to PRs typically within 7 days. If you don't hear back, ping the issue. GitHub Discussions is the fastest channel for anything that is not a bug.

---

## License of contributions

troth is released under AGPL-3.0-only, and that is the license your contribution ships under. Two separate things are being asked of you, and they are worth keeping apart.

**1. Provenance.** Signing off with `git commit -s` certifies the [Developer Certificate of Origin 1.1](https://developercertificate.org/): that you wrote the contribution, or otherwise have the right to submit it. That is all the DCO says. It is not a license grant.

**2. License grant.** By submitting a contribution you grant the maintainer a perpetual, worldwide, non-exclusive, irrevocable, royalty-free license to reproduce, modify, publicly display, sublicense and distribute your contribution, both under AGPL-3.0-only and under other license terms, including proprietary ones. You keep your copyright and stay free to use your own work anywhere else, under any terms you choose.

The second grant is what allows a commercial or enterprise edition to exist without tracking down every past contributor for permission. It is spelled out here because the DCO alone does not provide it: a project that treats sign-off as permission to relicense does not actually have that permission. If you would rather not give the grant, say so in the pull request. The contribution can still be accepted as AGPL-only, it simply has to be recorded as such, and a large one may be declined on that basis.

This section is a plain statement of the terms, not legal advice.
