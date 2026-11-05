# v0.6 holdout task authoring rules

This file is given verbatim to the task author and the independent reviewer.

## Your environment

- **Repository.** You work only inside the repository directory you are given: a clean detached checkout at a fixed commit. Do not modify it.
- **Tools.** Use only `git`, `rg`/`grep`, `sed`, `cat`, `ls` and `find`.
  - Never run `stellar` or any StellarCode command.
  - Never look at the StellarCode repository, its source or its validation results.
- **Output.** Write your output only to the file path you are given.

## Task set

Write exactly **12 tasks**, 3 of each category:

| Category | What the task asks |
|---|---|
| `navigation` | Where is a specific behavior owned or implemented? |
| `flow` | Trace a concrete behavior through several symbols or files, from an entry point to where the effect happens. |
| `impact` | If a specific function, method, class or contract changes, which production code must be reviewed or changed? |
| `editing-prep` | Before making a specific described change, which files must be edited? |

Each task:

```json
{
  "id": "kebab-case-unique-id",
  "category": "navigation|flow|impact|editing-prep",
  "prompt": "A natural developer question.",
  "expectedFiles": ["repo/relative/path.ts"],
  "expectedMatch": "all|any",
  "expectedSemanticEdges": [{ "from": "path#Symbol", "relation": "CALLS", "to": "path#Symbol" }]
}
```

`expectedSemanticEdges` is optional; see the next section.

### Prompt rules

- Describe the behavior in **domain language**, the way a developer who knows the product but not the code would ask. Do not leak the answer:
  - no file names, file stems or directory names of expected files
  - no exact identifier of the expected symbol
- The question must be answerable from source code in the repository, and the answer must be **objective**.
- Prefer behaviors that span several symbols or files for `flow`, `impact` and `editing-prep`.
- Avoid tests, generated code, vendored code, build configuration and documentation as answers.

### `expectedFiles`

- Production source files that a correct answer must name. Use 1 file for navigation, 2–4 for the other categories.
- Use `expectedMatch: "all"` when every listed file is required, and `"any"` only when alternatives are truly equivalent.
- Every path must exist at this commit. Verify with `git ls-files`.

### `expectedSemanticEdges` (at least 6 of the 12 tasks)

Annotate only relations that are **objectively visible in source**. Each one must be one of:

| Relation | Meaning | Example |
|---|---|---|
| `CALLS` | Symbol A's body literally invokes symbol B. | `a()`, `obj.b()`, `this.repo.b()` where the receiver's class is unambiguous from source |
| `IMPLEMENTS` | Class A explicitly declares `implements B`, or method `A.m` is the implementation of interface method `B.m` in such a class. | |
| `REGISTERS` | A literally passes function or method B as an argument to a registration-like call (`router.post('/x', b)`, `emitter.on('evt', b)`, `register(b)`), or B is decorated with a call-form decorator (`@app.get(…)`). | |
| `CONSUMES` | A uses an imported symbol B without calling it: a type annotation, a constant read, an `instanceof`. | |

Symbol naming:

| Shape | Form | Example |
|---|---|---|
| Function or top-level constant | `path#name` | `src/a.ts#saveUser` |
| Class method | `path#Class.method` | `src/svc.ts#UserService.create` |
| Object-literal method (`const repo = { save() {} }`) | `path#repo.save` | |
| Class or interface | `path#ClassName` | |
| Code at module top level, not inside any function (for example route registrations) | the file path alone | `src/routes.ts` |
| Python method | `path#Class.method` | |
| Python function | `path#function` | |

Rules:

- Annotate the edges a developer must follow to answer the task, typically 1–4 per task.
- Do **not** annotate an edge whose target can only be known at runtime:
  - dynamic dispatch, `obj[name]()`
  - dependency-injection containers
  - a receiver whose type is not declared and not assigned from a known class
- Do **not** annotate interface dispatch to a concrete class as `CALLS`. Annotate `CALLS` to the interface method instead, if that is what the source says.
- Every annotated edge must be checkable by reading the two symbols' source.

## Reviewer instructions

You review a task file written by another author for the same repository, under the same tool restrictions.

- **Each task:**
  1. Verify the prompt does not leak expected file names or symbol identifiers.
  2. Verify that the answer is objective and that `expectedFiles` is complete and correct.
  3. Verify each `expectedSemanticEdges` entry literally in source:
     - the `from` symbol exists at that path
     - its body contains the call, use or registration
     - the `to` symbol exists at that path and is the one meant
- **Fixing.** Fix errors in place. Delete a task you cannot make objective, then write a replacement of the same category that follows the rules.
- **Final check.** Ensure there are 12 tasks, 3 per category, and at least 6 with `expectedSemanticEdges`.
- **Notes.** Write a review note per task: `ok`, `fixed: <what>`, or `replaced: <why>`.
