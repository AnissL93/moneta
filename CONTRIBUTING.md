# Contributing to Moneta

Thanks for your interest in improving Moneta. This project is a self-hosted,
single-user personal finance aggregator, so the priorities are correctness
(money must never be miscounted or duplicated) and a small, understandable
codebase.

## Development Setup

```bash
git clone https://github.com/AnissL93/moneta.git
cd moneta
./setup.sh                    # copies .env.example -> .env, npm install
docker compose up -d postgres # start only postgres for local dev
npm run dev                   # tsx watch mode (apps/server)
npm test                      # vitest, auto-creates a finance_test database
```

See [CLAUDE.md](CLAUDE.md) for the full command reference and architecture
overview, and [spec.md](spec.md) for the detailed design.

## Branch & PR Workflow

1. Fork the repository and create a feature branch off `main`.
2. Keep changes focused — one logical change per pull request.
3. Make sure `npm test` passes locally (requires the compose `postgres`
   service running).
4. Open a pull request against `main` with a clear description of the change
   and why it's needed.
5. Be responsive to review feedback; small, incremental commits are easier to
   review than large rewrites.

## Code Style

- TypeScript throughout, `type: module` (ESM).
- Money is always stored and manipulated as integer pence (`BIGINT`), never
  floating point.
- Sync logic must remain idempotent — rerunning a sync must never duplicate
  transactions, locally or in Actual Budget.
- New provider integrations should implement the `BankingProvider` interface
  in `apps/server/src/providers/banking-provider.ts` rather than special-casing
  a specific bank/provider elsewhere.
- Add or update tests alongside code changes (colocated `*.test.ts` files,
  run via vitest).

## Reporting Issues

Please use the issue templates under `.github/ISSUE_TEMPLATE/`:

- **Bug report** — include steps to reproduce, expected vs. actual behavior,
  and your environment (Node version, Docker version, deployment mode).
- **Feature request** — describe the problem you're trying to solve, not just
  the solution.

Since Moneta handles real financial data, please do **not** include real bank
credentials, account numbers, TrueLayer tokens, or `.env` contents in issues
or pull requests.

## Using Claude Code

This repository includes a [`CLAUDE.md`](CLAUDE.md) with project context
(commands, architecture, configuration) intended for use with
[Claude Code](https://claude.com/claude-code). Running `claude` from the
repository root will pick it up automatically, which can speed up
onboarding and code review.
