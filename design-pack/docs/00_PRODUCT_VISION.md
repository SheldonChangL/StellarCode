# Product Vision

## Problem

AI coding agents repeatedly spend context and tool calls rediscovering repository structure: listing directories, grepping symbols, opening unrelated files, reconstructing dependencies, and re-learning architecture decisions. Humans joining a repository face the same orientation problem.

## Product thesis

A local, continuously updated repository knowledge graph can serve both audiences:

- **Humans** explore it as an interactive code universe.
- **AI agents** query it through compact structured tools before opening source files.

The value is not the galaxy metaphor itself. The value is that both interfaces sit on a persistent, deterministic graph that makes repository navigation cheaper and more accurate.

## Primary jobs to be done

### Human
- Understand an unfamiliar repository in under two minutes.
- See what a file does and what it depends on.
- See which files depend on it.
- Locate important modules and recent hotspots.
- Inspect change and impact relationships without reading every file.

### AI agent
- Resolve a task to a small candidate file set.
- Resolve symbols to source locations.
- Retrieve direct dependencies and reverse dependencies.
- Estimate impact scope before editing.
- Avoid broad `find`, `tree`, `grep`, and `rg` exploration when indexed knowledge is sufficient.

## Non-goals for MVP

- Full semantic understanding of arbitrary business logic.
- Perfect runtime call graph across all languages.
- Cloud-hosted source indexing.
- Automatic code modification.
- IDE replacement.
- Mandatory LLM summaries for every file.
- Multi-user authorization or enterprise SaaS controls.

## MVP hypothesis

For repository-navigation-heavy coding tasks, StellarCode should reduce:

- discovery tool calls by at least 50%;
- discovery-related input tokens by at least 40%;
- time to first relevant source file by at least 50%;

without reducing task success rate.

## Product sentence

> StellarCode turns a repository into a living universe that humans can explore and AI can understand.
