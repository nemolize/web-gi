# Web App Template

A modern web application template built with React, TypeScript, and Vite, deployed to Cloudflare Workers.

## After using this template

1. Rename the project: replace `default-project-name` in `wrangler.json` with your Worker name, and update `name` in `package.json` and the `<title>` in `index.html`.
2. Set up Cloudflare deployment: create an API token with Workers deploy permissions and add it as the `CLOUDFLARE_API_TOKEN` repository secret (used by `.github/workflows/deploy.yml`).
3. Install the toolchain: [mise](https://mise.jdx.dev/) provisions the Node.js and pnpm versions pinned in `mise.toml` (`mise install`).
4. Note on git hooks: `lefthook.yml` pulls its hook definitions from an external repository (`nemolize/lefthook-configs`). Replace it with your own configuration if you are not the template author.

## Features

- **React** with TypeScript
- **Vite** for fast development and building
- **ESLint** and **Prettier** for linting and formatting
- **Vitest** for unit testing with Testing Library
- **Playwright** for end-to-end testing
- **Cloudflare Workers** for hosting (static assets, SPA fallback) with PR preview deployments
- **Renovate** for automated dependency updates

## Getting Started

### Prerequisites

- Node.js (see `mise.toml` for version requirements)
- pnpm package manager

### Installation

```bash
pnpm install
```

### Development

Start the development server:

```bash
pnpm dev
```

### Building

Build for production:

```bash
pnpm build
```

Preview the production build:

```bash
pnpm preview
```

### Testing

Run unit tests:

```bash
pnpm test
```

Run end-to-end tests:

```bash
pnpm test:e2e
```

### Code Quality

Check code style and issues:

```bash
pnpm lint
```

Fix automatically fixable code style issues:

```bash
pnpm fix
```

Run type checking:

```bash
pnpm lint:typecheck
```

## Deployment

Deployment is handled by `.github/workflows/deploy.yml`:

- Push to `main` deploys to production (`wrangler deploy`).
- A manual run from `main` redeploys production; manual runs from other refs are skipped.
- Pull requests upload a preview version (`wrangler versions upload`); the preview URL is posted as a sticky PR comment.

The Worker configuration lives in `wrangler.json`. The build is driven by `@cloudflare/vite-plugin`, which generates the deployable config under `dist/` during `pnpm build`.

## Growing the codebase

The template ships with a minimal Counter demo under `src/` (a component, a hook, a utility, and a unit test for the hook) to demonstrate the testing setup. There is deliberately no imposed directory structure beyond `hooks/`, `utils/`, and `styles/` — introduce feature-oriented boundaries (e.g. `src/features/<name>/`) once the app has more than a handful of screens, and delete the Counter demo when you start building.

## License

MIT
