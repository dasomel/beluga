# beluga-manager

TypeScript project for the beluga data platform policy compiler. Compiles YAML policy declarations into Keycloak, Rego, and PostgreSQL DDL artifacts.

## Setup

```bash
npm install
```

## Development

```bash
npm test              # Run tests once
npm run test:watch   # Run tests in watch mode
npm run typecheck    # Type check only
npm run policyctl    # Run the policy compiler CLI
```

## Project Structure

- `src/` - Compiler source code
- `bin/` - CLI entry point
- `tests/` - Test files
- `dist/` - Compiled output
